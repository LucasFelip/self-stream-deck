# Arquitetura

Como o self-stream-deck funciona por dentro. Para usar o painel, veja o [README](../README.md); para mexer no código, o [CONTRIBUTING](../CONTRIBUTING.md).

```
┌──────────────┐   HTTP (USB/adb reverse) ou HTTPS (Wi-Fi opcional)   ┌─────────────────────────────┐
│ App Android  │ ───────────────────────────────────────────────────▶ │ ssd.exe (Rust, no PC)       │
│ (WebView)    │ ◀── interface web, ícones, dados, eventos ─────────── │  • rotas  • API do Windows  │
└──────────────┘                                                      └─────────────────────────────┘
```

## Pastas

| Pasta | O que tem |
|---|---|
| `android/` | App Android fino (Java, sem bibliotecas): guarda o endereço, mantém a tela ligada, vibra, expõe `Android.openSettings/vibrate/reconnect` à página. |
| `agent/crates/core/` | A lógica sem Windows: `guard` (Host, token, bloqueio, Origin), `config`, `ports` (um trait por parte do PC e um `Fake*` de cada), `keys`, `macros`, `media`, `taskbar`, `windows`, `power`, `notices`, `sha1`/`sha256`. |
| `agent/crates/api/` | O HTTP (axum): `lib.rs` (o fluxo do pedido), `routes.rs` e os módulos por assunto (`winroutes`, `powerroutes`, `monitorroutes`, `editor`, `camera`, `apps`), `events.rs` (SSE), `statics.rs` + `embedded.rs` (a interface dentro do `.exe`). |
| `agent/crates/platform-windows/` | Os adaptadores: Core Audio, SMTC, teclas, barra de tarefas, janelas (DWM), energia, monitor (PDH, `nvidia-smi`, RTSS, WMI), notificações, câmera virtual, rede. É o único lugar com `unsafe`. |
| `agent/crates/agent/` | O programa `ssd`: argumentos, bandeja (`tray.rs`), `diagnose.rs`, `data.rs` (pasta de dados e migração), `lan.rs` (HTTPS pelo Schannel, iPhone, firewall) e os scripts de certificado (embutidos). |
| `agent/scripts/` | `package.ps1`, `install.ps1`, `uninstall.ps1`, `sign.ps1` e `launch-hidden.vbs` (a tarefa agendada o usa para subir sem janela). |
| `web/` | A interface (React + TypeScript); o `ssd` a leva dentro do `.exe`. Mudar a interface não exige recompilar o APK. |
| `contracts/` | `openapi.yaml` (a fonte única da API) e `fixtures/fake-pc.json`. |
| `tools/` | `check.js` (tudo), `contract-test/` (o agente contra o contrato), `agent-check/` (de fora para dentro), `hooks/`. |

## Agente

**Pedido → resposta.** `api/lib.rs` valida o `Host`, o bloqueio por falhas, o token e a origem (`core/guard.rs`); arquivos estáticos saem de `statics.rs` (só tipos conhecidos, ETag/304,
da pasta `--web-dir` ou do que está dentro do `.exe`); o resto vai para `routes::answer`, que despacha por método e caminho. O que nenhuma rota responde é um 404 em JSON; erros viram o JSON do contrato, nunca um rastro de pilha.

**Portas e adaptadores.** A lógica só conhece os traits de `core/ports.rs` (`AudioPort`, `MediaPort`, `InputPort`, `TaskbarPort`, `WindowsPort`, `PowerPort`, `MonitorPort`, `NotificationsPort`, `VcamPort`).
Em produção entram os adaptadores de `platform-windows`; com `--fake-platform` (e nos testes) entram os `Fake*`, e assim cada rota é testada sem Windows.

**Validação.** Tudo que vem do cliente é conferido contra listas do agente (apps da barra de tarefas, atalhos do `config.json`, dispositivos existentes, passos de macro permitidos). Nunca caminhos, teclas ou comandos arbitrários.

**Configuração.** `core/config.rs` lê `config.json` da pasta de dados (aceita BOM, nunca sobrescreve um arquivo ilegível, porque isso giraria o token), completa com os padrões e valida os tipos das chaves editáveis.
Cada gravação guarda a versão anterior em `config.json.bak` e move o novo arquivo por rename.

**Dados.** `%APPDATA%\SelfStreamDeck\` (`--data-dir` troca; `--migrate-from` copia o token e os certificados de uma instalação anterior só quando não há config). Contém `config.json`, `.bak`, `tls/`, `icons/`, `vcam/`, `server.log`.

**Operação.** `ssd.exe` roda como tarefa agendada no logon (administrador, sem janela, reinício automático); a bandeja dá o painel, o código de pareamento e o registro; `ssd diagnose` junta o estado para investigar.
Um objeto de job do Windows mata o que o agente iniciou (PowerShell do firewall, auxiliares) se ele cair.

## Atualização por push (SSE)

`GET /api/events?topics=windows,state,audio,media,monitor,game,processes,power,notifications` mantém a resposta aberta e envia um valor **só quando ele muda**
(comparado por uma assinatura). Um tópico tem um *produtor* (`api/events.rs`) que **só roda enquanto alguém escuta**; quem chega depois recebe o último valor
na hora; um comentário de manutenção sai a cada 20 s. `windows` é empurrado pelo próprio Windows (`SetWinEventHook`, com a mudança só de título suavizada em ~600 ms); os outros perguntam ao PC num intervalo
(uma pergunta para todos os celulares). Se a conexão não abre, a interface volta a perguntar de tempos em tempos e espaça os pedidos enquanto nada muda. `GET /api/requests` mostra quantas vezes cada rota foi usada.

## Interface (`web/`)

A interface é o app React + TypeScript de `web/` (ver [web/README.md](../web/README.md) e [ADR 0002](adr/0002-interface-react-typescript-pwa.md)). `npm run build` gera `web/dist`, que o agente embute no `.exe` (`rust-embed`) e entrega em `/` (ETag/304, mesma exigência de token; manifest, ícones e `pair.js` são públicos). Um build novo também recarrega o celular sozinho (`/api/ui-version`).
O cliente da API é gerado de `contracts/openapi.yaml`; um único `EventSource` (`LiveHub`) alimenta todas as páginas e só consulta por GET quando o fluxo está fechado.

## Wi-Fi e segurança de rede

HTTP só em `127.0.0.1`; o Wi-Fi é HTTPS em outra porta (Schannel, pelo `native-tls`), com certificado próprio que o app **fixa pela impressão digital SHA-256**, e uma regra de firewall só para a
sub-rede local. Token obrigatório em tudo; `Host` validado (IP, `localhost`, o nome do PC e `nome.local`); `POST` de outra origem recusado; 10 falhas bloqueiam o IP por 1 minuto. Detalhes de uso no README.

### iPhone (Safari / PWA)

O Safari valida os nomes do certificado, então o iPhone não usa o certificado fixado do Android. `scripts/tls-ios.ps1` (embutido no `.exe`) mantém, em `tls/ios/`, uma **AC local**
(`ca.pfx`/`ca.cer`, 10 anos, instalada uma vez no iPhone) e uma **folha** (`leaf.pfx`/`leaf.cer`, 1 ano, SAN = nome do PC, `nome.local`, `localhost` e os IPs de casa, EKU serverAuth).
**Diferença conhecida:** os certificados só são refeitos quando faltam (não por validade nem quando os IPs mudam).
Duas portas: `iosPort` (HTTPS, as mesmas rotas do deck) e `iosCaPort` (HTTP simples: só `GET /ca.cer` e uma página com a impressão digital da AC; nada de segredo, sem token).
Regra de firewall própria (as duas portas, só a sub-rede local).

Front-end: `manifest.webmanifest` e ícones (`web/public/icons/`) mais as metas `apple-mobile-web-app-*` dão a Tela de Início em tela cheia. Sem token, um navegador que abre `/` recebe a página de pareamento (token errado conta como falha),
porque o app da Tela de Início guarda cookies separados do Safari: o código vem de `GET /api/pair-code`, copiado pelo item de menu "Código de pareamento" (só no iOS). A Wake Lock é pedida de novo ao ser solta; o háptico no iOS 18+ usa um `<input switch>` escondido.

## Câmera

O celular manda quadros JPEG (`POST /api/camera/frame`, validados como JPEG); o agente os republica em MJPEG (`/api/camera/stream`, para o OBS) e, se instalada, escreve em uma câmera virtual
DirectShow (UnityCapture, DLL fixada por SHA-256) pela memória compartilhada do filtro, de baixo para cima em RGBA. O cabeçalho `X-Camera-Wanted` diz ao celular se alguém usa a imagem;
se ninguém usa, ele manda 1 quadro por segundo. Sem sinal, o stream mostra a imagem "Sem sinal".

## Consumo (medido neste PC)

Antes (servidor Node + helpers) e agora (um só `ssd.exe`):

| | Node + helpers | `ssd.exe` |
|---|---|---|
| Processos | 5 (Node e 4 helpers) | 1 |
| Memória | ~250 MB | ~55–70 MB |
| CPU parado | — | ~1 % de um núcleo (~5 % com os 9 tópicos abertos) |
| Pedidos do celular na tela Atalhos | ~120 por minuto | 0 (o PC avisa quando algo muda) |
| Câmera sem ninguém usando | 17 quadros/s, ~580 KB/s | 1 quadro/s, ~26 KB/s |

App Android no Galaxy A31: ≈ 150 MB (PSS) mais ~150 MB do renderizador do WebView, ~1 % de CPU de um núcleo e ~0,6 KB/s de rede.
A lista da barra de tarefas fica em cache (`taskbar-cache.json`) e só é relida quando a pasta de atalhos fixados muda ou ao tocar em Atualizar.

## Testes

| Comando | O que roda | Precisa de |
|---|---|---|
| `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` em `agent/` | Formatação, lints e testes de lógica, rotas com portas falsas, TLS, eventos | Rust |
| `npm test` em `web/` | Tipos gerados do contrato, `tsc --strict`, ESLint e Vitest (regras puras) | Node |
| `npm run test:e2e` em `web/` | Build e a interface em um navegador sem tela (Chrome, Brave ou Edge; `CHROME_PATH` aponta outro) contra um servidor falso que obedece ao contrato | Node + navegador |
| `npm test` em `tools/contract-test/` | O `ssd.exe` num PC de mentira contra `contracts/openapi.yaml`: cada operação, esquemas, segurança, eventos (casos que dependem dos ids da fixture ficam como `skip` neste agente) | `cargo build --release` |
| `node tools/agent-check/run.js` | De fora para dentro: Host, token, pareamento, cookie, cabeçalhos, ETag, câmera, energia, editor, monitor, notificações, bloqueio | `cargo build --release` + `web/dist` |
| `node tools/check.js [--full]` | Tudo | Windows |

## Variáveis de ambiente

| Variável | Efeito |
|---|---|
| `SSD_PORT` | Porta só desta execução (não vai para o `config.json`). |
| `SSD_LOG` | `debug`, `info` (padrão), `warn` ou `error`. |
| `SSD_DATA_DIR` | Outra pasta para os dados (o padrão é `%APPDATA%\SelfStreamDeck`). |
| `SSD_WEB_DIST` | Serve a interface desta pasta em vez da que está dentro do `.exe`. |
| `SSD_NO_FIREWALL` | Não mexe nas regras do firewall (os testes usam outras portas). |
| `SSD_AGENT_EXE` | Outro `ssd.exe` para o `contract-test` e o `agent-check`. |
| `CHROME_PATH` | Navegador para `test:e2e`. |

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
