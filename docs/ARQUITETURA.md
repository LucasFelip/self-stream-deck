# Arquitetura

Como o self-stream-deck funciona por dentro. Para usar o painel, veja o [README](../README.md); para mexer no código, o [CONTRIBUTING](../CONTRIBUTING.md).

```
┌──────────────┐   HTTP (USB/adb reverse) ou HTTPS (Wi-Fi opcional)   ┌─────────────────────────────┐
│ App Android  │ ───────────────────────────────────────────────────▶ │ server/ (Node, no PC)       │
│ (WebView)    │ ◀── interface web, ícones, dados, eventos ─────────── │  • rotas  • helpers nativos │
└──────────────┘                                                      └─────────────────────────────┘
```

## Pastas

| Pasta | O que tem |
|---|---|
| `android/` | App Android fino (Java, sem bibliotecas): guarda o endereço, mantém a tela ligada, vibra, expõe `Android.openSettings/vibrate/reconnect` à página. |
| `legacy/server/src/` | O servidor. `index.js` (HTTP em 127.0.0.1 e HTTPS na rede local), `supervisor.js`, `security.js`, `http.js`, `config.js` + `config-check.js`, `events.js`, `host.js`, `log.js`, e os módulos que falam com o PC (`system`, `media`, `monitor`, `power`, `taskbar`, `camera`, `vcam`, `macros`, `keys`). |
| `legacy/server/src/routes/` | As rotas, um arquivo por assunto (`apps`, `shortcuts`, `macros`, `editor`, `audio`, `media`, `pc`, `windows`, `camera`, `events`). `context.js` guarda o estado compartilhado; `index.js` monta a tabela e despacha. |
| `web/` | A interface (React + TypeScript); o servidor entrega o build `web/dist` (mudar a interface não exige recompilar o APK). |
| `legacy/server/native/` | O C# dos helpers nativos (um só `ssd-helper.exe`). |
| `legacy/server/scripts/` | Os mesmos helpers em PowerShell (plano B), mais `taskbar.ps1`, `tls-cert.ps1`, `tls-ios.ps1` (AC e certificado do iPhone) e `autostart.ps1`; `make-icons.js` redesenha os ícones de `public/icons/`. |
| `legacy/server/test/` | Testes (veja abaixo). |
| `legacy/server/data/` | Dados da máquina, fora do git: `config.json` (token), `config.json.bak`, `bin/`, `cache/`, `icons/`, `tls/`, `vcam/`, `server.log`. |

## Servidor

**Pedido → resposta.** `index.js` valida o `Host`, o bloqueio por falhas, o token e a origem (`security.js`); arquivos estáticos saem de `http.js`
(só `web/dist`, só tipos conhecidos, ETag/304); o resto vai para `routes.dispatch`. Cada rota é uma função `(ctx, on)` registrada com
`on(método, padrão, handler)`; erros com `status` viram a resposta, qualquer outro vira 500 sem vazar detalhes.

**Injeção de dependências.** `createRoutes(config, overrides)` recebe os módulos que falam com o PC (`system`, `media`, `monitor`, `power`,
`camera`, `vcam`, `taskbar`, `events`, `update`, `uiVersion`). Em produção são os reais; nos testes, falsos, e assim cada rota é testada sem Windows.

**Validação.** Tudo que vem do cliente é conferido contra listas do servidor (apps da barra de tarefas, atalhos do `config.json`, dispositivos
existentes, passos de macro permitidos). Nunca caminhos, teclas ou comandos arbitrários. Os validadores comuns estão em `src/validate.js`.

**Configuração.** `config.js` lê `legacy/server/data/config.json` (aceita BOM, nunca sobrescreve um arquivo ilegível, porque isso giraria o token),
completa com os padrões e valida (`config-check.js`: tipos, portas, ids únicos, caracteres danificados). Problemas antigos viram aviso; ao salvar
pelo editor, um problema nas chaves alteradas é recusado com 400 e nada é escrito. Cada gravação guarda a versão anterior em `config.json.bak` e
move o novo arquivo por rename (atômico).

**Log.** `log.js` (`debug`, `info`, `warn`, `error`; `SSD_LOG` escolhe o nível). Erros ignorados de propósito vão para `debug` com o motivo
(`swallow`), então um problema que antes sumia pode ser visto com `SSD_LOG=debug`.

**Supervisor.** A tarefa de autostart roda `supervisor.js`, que sobe o servidor e o reinicia se cair (2 s, aumentando até 30 s se falhar logo).
O motivo de cada parada fica no `server.log`.

## Helpers

Cada tipo de trabalho tem um **helper de longa duração** que fala JSON por linha (um pedido por linha na entrada, uma resposta por linha na saída,
com `id`). `host.js` o inicia no primeiro uso e o reinicia se morrer.

- **Nativo (padrão):** `legacy/server/native/*.cs` compilados em um único `ssd-helper.exe` com o compilador C# que já vem no Windows (.NET Framework 4,
  **C# 5**: sem `?.`, interpolação etc.), em `legacy/server/data/bin/`, com o nome contendo o hash dos fontes. Modos: `input`, `media`, `monitor`, `notifications`, `vcam` (as notificações do Windows também são nativas: ~0,6 s na primeira leitura, contra vários segundos e ~44 MB do PowerShell).
- **PowerShell (plano B):** os scripts `legacy/server/scripts/*-host.ps1`, mesmo protocolo. Usados se o exe não puder ser compilado, ou com `SSD_NO_NATIVE=1`.
  O C# de `DeckNative` e `VCam` tem **uma só cópia** (`native/DeckNative.cs`, `native/VCam.cs`): os scripts compilam esses mesmos arquivos
  (`Add-CachedType -Path`). `monitor` e `media` são portes, não cópias, e a paridade é conferida por teste.
- **Falhas:** um helper nativo que morre antes de ficar pronto duas vezes seguidas é abandonado nesta execução (cai para o PowerShell). Se um
  helper morre no meio de um pedido, as **leituras** (`retryOps`) são pedidas mais uma vez com o helper reiniciado; as **ações** nunca são repetidas.
  O evento `ready` do `Host` avisa quando um helper (re)começa, para quem precisa reenviar uma assinatura (a observação de janelas).

| Modo | Faz |
|---|---|
| `input` | Teclas (`keybd_event`), janelas (listar, focar, minimizar, mover, fechar, **avisar quando mudam**), monitores (brilho DDC/CI, desligar), áudio por Core Audio (dispositivo padrão, volume, mudo, mixer por app). |
| `media` | Mídia via *System Media Transport Controls* (a mesma fonte do controle de mídia do Windows). |
| `monitor` | Contadores de desempenho (API PDH: uma leitura por segundo para tudo), `nvidia-smi`, MSI Afterburner/RTSS, WMI. |
| `vcam` | Alimenta a câmera virtual direta com os quadros recebidos do celular. |

## Atualização por push (SSE)

`GET /api/events?topics=windows,state,audio,media,monitor,game,processes,power` mantém a resposta aberta e envia um valor **só quando ele muda**
(comparado por uma assinatura). Um tópico tem um *produtor* (`routes/events.js`) que **só roda enquanto alguém escuta**; quem chega depois recebe o último valor
na hora. `windows` é empurrado pelo próprio helper nativo (`SetWinEventHook`); os outros perguntam ao PC num intervalo (uma pergunta para todos os celulares).
Se a conexão não abre, a interface volta a perguntar de tempos em tempos e espaça os pedidos enquanto nada muda. `GET /api/requests` mostra quantas
vezes cada rota foi usada.

## Interface (`web/`)

A interface é o app React + TypeScript de `web/` (ver [web/README.md](../web/README.md) e [ADR 0002](adr/0002-interface-react-typescript-pwa.md)). `npm run build` gera `web/dist`, que o servidor entrega em `/` (ETag/304, mesma exigência de token; manifest, ícones e `pair.js` são públicos). Um build novo também recarrega o celular sozinho (`/api/ui-version` olha a data dos arquivos de `web/dist`).
O cliente da API é gerado de `contracts/openapi.yaml`; um único `EventSource` (`LiveHub`) alimenta todas as páginas e só consulta por GET quando o fluxo está fechado. Sem `web/dist` o servidor responde 404 em `/`: rode `npm run build` em `web/`.

## Wi-Fi e segurança de rede

HTTP só em `127.0.0.1`; o Wi-Fi é HTTPS em outra porta, com certificado próprio que o app **fixa pela impressão digital SHA-256**, e uma regra de firewall só para a
sub-rede local. Token obrigatório em tudo; `Host` validado (IP, `localhost`, o nome do PC e `nome.local`); `POST` de outra origem recusado; 10 falhas bloqueiam o IP por 1 minuto. Detalhes de uso no README.

### iPhone (Safari / PWA)

O Safari valida os nomes do certificado, então o iPhone não usa o certificado fixado do Android. `tls-ios.js` (e `scripts/tls-ios.ps1`) mantém, em `data/tls/ios/`, uma **AC local**
(`ca.pfx`/`ca.cer`, 10 anos, instalada uma vez no iPhone) e uma **folha** (`leaf.pfx`/`leaf.cer`, 1 ano, SAN = nome do PC, `nome.local`, `localhost` e os `homeAddresses()`, EKU serverAuth).
`ensure()` refaz só a folha quando os IPs mudam ou faltam 30 dias; `index.js` (`startIos`) confere a cada 5 min e troca o contexto TLS ao vivo (`setSecureContext`), sem reiniciar. O script
remove da loja do usuário as chaves **e** a cópia pública da AC que o Windows põe em "Autoridades Intermediárias" (o Node trata essa loja como confiável, o que esconderia erros de verificação).
Duas portas: `iosPort` (HTTPS, a mesma `onRequest` do deck) e `iosCaPort` (HTTP simples, `ios.js`: só `GET /ca.cer` e uma página com a impressão digital da AC; nada de segredo, sem token).
Regra de firewall própria (`RULE_IOS`, as duas portas, `LocalSubnet`); `firewall.ensure(portas, regra)`.

Front-end: `manifest.webmanifest` e ícones (`web/public/icons/`) mais as metas `apple-mobile-web-app-*` no `index.html` dão a Tela de Início em tela cheia. `http.js` (`isPublicAsset`) libera sem token só
o manifest, os ícones e o `pair.js`, porque o Safari os pede sem cookie. Sem token, um navegador que abre `/` recebe `pair.html` (`index.js`; token errado conta como falha e volta com `?error=1`),
porque o app da Tela de Início guarda cookies separados do Safari: o código vem de `GET /api/pair-code` (`routes/pairing.js`), copiado pelo item de menu "Código de pareamento" de `js/pairing.js` (só no iOS, `Deck.isIOS`).
`connection.js` pede a Wake Lock de novo ao ser solta ou no primeiro toque; `deck.js` faz o háptico no iOS virando um `<input switch>` escondido (iOS 18+). Testes: `ios.test.js` (AC, folha, troca de IP, porta do certificado, nada
sobra na loja), `http.test.js`, `routes.test.js`, e os de UI com o UA do iPhone e os viewports 390x844 e 844x390.

## Câmera

O celular manda quadros JPEG (`POST /api/camera/frame`); o servidor os republica em MJPEG (`/api/camera/stream`, para o OBS) e, se instalada, escreve em uma câmera virtual
DirectShow (UnityCapture, DLL fixada por SHA-256) pela memória compartilhada do filtro, de baixo para cima em RGBA. O cabeçalho `X-Camera-Wanted` diz ao celular se alguém usa a imagem;
se ninguém usa, ele manda 1 quadro por segundo.

## Consumo (medido neste PC)

| | Antes | Agora |
|---|---|---|
| Servidor responde depois de reiniciar | ≥ 2,5 s (lia a barra de tarefas antes) | ~15 ms (usa a lista da última vez e confere em segundo plano) |
| Memória dos 3 helpers | ~320 MB (PowerShell) | ~140 MB (nativo) |
| Partida do helper de teclas/janelas | ~560 ms | ~80 ms |
| Pedidos do celular na tela Atalhos | ~120 por minuto | 0 (o PC avisa quando algo muda) |
| Câmera sem ninguém usando | 17 quadros/s, ~580 KB/s | 1 quadro/s, ~26 KB/s |

Interface nova (React) no Galaxy A31 e agente no PC, medidos com o jogo aberto: agente + helpers ≈ 113 MB de RAM e ~0,2 % da CPU da máquina (16 núcleos) com o celular na página PC; app Android ≈ 150 MB (PSS) mais ~150 MB do renderizador do WebView, ~1 % de CPU de um núcleo e ~0,6 KB/s de rede.

A lista da barra de tarefas fica em cache (`data/taskbar-cache.json`) e só é relida quando a pasta de atalhos fixados muda ou ao tocar em Atualizar.

## Testes

| Comando | O que roda | Precisa de |
|---|---|---|
| `npm run lint` | ESLint (inclui "erro engolido precisa de motivo") | Node |
| `npm test` | Lógica e servidor: câmera, macros, rede, push, eventos, segurança, HTTP, configuração, rotas (com módulos falsos), `Host` | Node |
| `npm test` em `web/` | Tipos gerados do contrato, `tsc --strict`, ESLint e Vitest (77 testes de regras puras) | Node |
| `npm run test:e2e` em `web/` | Build e a interface em um navegador sem tela (Chrome, Brave ou Edge; `CHROME_PATH` aponta outro) contra um servidor falso que obedece ao contrato: shell, apps, som, PC, janelas, extras, editor, câmera, menu/folhas e o layout em 6 viewports | Node + navegador |
| `npm run test:integration` | Helper nativo contra o PowerShell (mesmas perguntas, mesmas respostas) e os dois caminhos do `Host` | Windows |
| `npm run check` | Tudo | Windows |

## Variáveis de ambiente

| Variável | Efeito |
|---|---|
| `SSD_PORT` | Porta só desta execução (não vai para o `config.json`). |
| `SSD_LOG` | `debug`, `info` (padrão), `warn`, `error` ou `silent`. |
| `SSD_NO_NATIVE` | `1` força os helpers PowerShell. |
| `SSD_DATA_DIR` | Outra pasta para os dados (os testes usam para não tocar nos reais). |
| `SSD_CACHE_DIR` | Pasta do cache das DLLs compiladas pelos scripts PowerShell. |
| `CHROME_PATH` | Navegador para `test:ui`. |

## API

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/events?topics=…` | Fluxo de atualizações ao vivo (server-sent events): `windows`, `state`, `audio`, `media`, `monitor`, `game`, `processes`, `power` |
| GET | `/api/ping` · `/api/state` | Conexão; apps rodando/abertos e agendamento de energia |
| GET | `/api/requests` | Quantas vezes cada rota foi usada desde que o servidor iniciou |
| GET | `/api/apps` · `/api/icon/:id` | Lista e ícones (URL versionada por hash) |
| POST | `/api/launch/:id` · `/api/refresh` | Abre ou traz para a frente; relê a barra de tarefas |
| GET/POST | `/api/shortcuts` · `/api/shortcut/:id` | Lista e dispara atalhos |
| GET/POST | `/api/macros` · `/api/macro/:id` | Lista e executa macros (devolve o resultado de cada passo) |
| GET/POST | `/api/layout` | Posição dos botões: `{apps, shortcuts}`; POST `{page, order}` |
| GET/POST | `/api/editor` · `/api/editor/shortcuts` · `/macros` · `/apps` | Editor de botões: lê tudo; salva atalhos, macros, apps ocultos (validado no servidor) |
| GET/POST | `/api/volume` | `{level, muted}`; POST `{level}` e/ou `{muted: bool｜"toggle"}` |
| POST | `/api/mediakey/:key` | `prev`, `playpause`, `next` (teclas globais) |
| GET | `/api/audio` | Saídas, entradas e sessões por app |
| POST | `/api/audio/default` · `/device` · `/session` | Trocar padrão; volume/mudo de dispositivo; volume/mudo de app |
| GET | `/api/media` · `/api/media/art` | Sessões de mídia; capa (por `session` e `key`) |
| POST | `/api/media/control` | `{session, action: toggle｜play｜pause｜next｜previous｜seek, position?}` |
| GET | `/api/monitor/sample` · `/fps` · `/processes` · `/info` | Medições ao vivo; FPS do jogo (ou `null`); top processos; hardware (em cache) |
| GET/POST | `/api/power` | Estado; ação `{action, confirm: true, delaySec?, force?}` ou `{action: "cancel"}` |
| GET | `/api/windows` | Janelas abertas: `{handle, title, app, state, monitor, x, y, w, h}` (pixels reais) |
| POST | `/api/windows/place` · `/snap` | `{handle, x, y}`; `{handle, monitor, zone: left｜right｜full}` |
| POST | `/api/windows/action` · `/move` | `{handle, action: focus｜minimize｜maximize｜restore｜close}`; `{handle, monitor}` (só em janelas da lista atual) |
| GET | `/api/screens` | Monitores e brilho (DDC/CI); `?brightness=0` pula a leitura lenta do brilho |
| POST | `/api/screens/brightness` · `/off` · `/project` | `{device, level}`; desligar telas; `{mode: extend｜clone｜first｜second}` (`first`/`second` com `confirm: true`) |
| POST | `/api/mic` | `{muted: true｜false｜"toggle"}` no microfone padrão |
| POST | `/api/camera/frame` | Um quadro JPEG do celular (corpo binário) |
| GET | `/api/camera/stream` · `/status` | Stream MJPEG; estado (ao vivo, fps, KB/s, quem assiste) e o link para o OBS |
| POST | `/api/camera/copy-link` | Copia o link do OBS para a área de transferência do PC |
| POST | `/api/camera/direct/install` · `/uninstall` | Instala ou remove a câmera virtual direta (exige `{confirm: true}`) |
