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
| `server/src/` | O servidor. `index.js` (HTTP em 127.0.0.1 e HTTPS na rede local), `supervisor.js`, `security.js`, `http.js`, `config.js` + `config-check.js`, `events.js`, `host.js`, `log.js`, e os módulos que falam com o PC (`system`, `media`, `monitor`, `power`, `taskbar`, `camera`, `vcam`, `macros`, `keys`). |
| `server/src/routes/` | As rotas, um arquivo por assunto (`apps`, `shortcuts`, `macros`, `editor`, `audio`, `media`, `pc`, `windows`, `camera`, `events`). `context.js` guarda o estado compartilhado; `index.js` monta a tabela e despacha. |
| `server/public/` | A interface web servida pelo próprio servidor (mudar a interface não exige recompilar o APK). |
| `server/native/` | O C# dos helpers nativos (um só `ssd-helper.exe`). |
| `server/scripts/` | Os mesmos helpers em PowerShell (plano B), mais `taskbar.ps1`, `tls-cert.ps1` e `autostart.ps1`. |
| `server/test/` | Testes (veja abaixo). |
| `server/data/` | Dados da máquina, fora do git: `config.json` (token), `config.json.bak`, `bin/`, `cache/`, `icons/`, `tls/`, `vcam/`, `server.log`. |

## Servidor

**Pedido → resposta.** `index.js` valida o `Host`, o bloqueio por falhas, o token e a origem (`security.js`); arquivos estáticos saem de `http.js`
(só `public/`, só tipos conhecidos, ETag/304); o resto vai para `routes.dispatch`. Cada rota é uma função `(ctx, on)` registrada com
`on(método, padrão, handler)`; erros com `status` viram a resposta, qualquer outro vira 500 sem vazar detalhes.

**Injeção de dependências.** `createRoutes(config, overrides)` recebe os módulos que falam com o PC (`system`, `media`, `monitor`, `power`,
`camera`, `vcam`, `taskbar`, `events`, `update`, `uiVersion`). Em produção são os reais; nos testes, falsos, e assim cada rota é testada sem Windows.

**Validação.** Tudo que vem do cliente é conferido contra listas do servidor (apps da barra de tarefas, atalhos do `config.json`, dispositivos
existentes, passos de macro permitidos). Nunca caminhos, teclas ou comandos arbitrários. Os validadores comuns estão em `src/validate.js`.

**Configuração.** `config.js` lê `server/data/config.json` (aceita BOM, nunca sobrescreve um arquivo ilegível, porque isso giraria o token),
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

- **Nativo (padrão):** `server/native/*.cs` compilados em um único `ssd-helper.exe` com o compilador C# que já vem no Windows (.NET Framework 4,
  **C# 5**: sem `?.`, interpolação etc.), em `server/data/bin/`, com o nome contendo o hash dos fontes. Modos: `input`, `media`, `monitor`, `vcam`.
- **PowerShell (plano B):** os scripts `server/scripts/*-host.ps1`, mesmo protocolo. Usados se o exe não puder ser compilado, ou com `SSD_NO_NATIVE=1`.
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

## Interface (`server/public/`)

Scripts simples que compartilham o namespace global `Deck`, carregados em ordem pelo `index.html` (sem empacotador, sem módulos ES, para o
carregamento no Android não mudar).

1. `deck.js`: caixa de ferramentas (`h`, `icon`, `api`, `toast`, `overlay`, `slider`, `addPage`, `lifecycle`, `menuItems`...).
2. `js/live.js` (push com plano B de consulta), `js/geometry.js` (cálculo do mapa de janelas, também testado no Node).
3. **Páginas e painéis.** Uma página se registra com `Deck.addPage({ id, section, title, el, show?, hide? })`: `sound` (que monta `media` e `audio`), `monitor` (também registra `processes`) e `power`.
   `windows` (lista e mapa de janelas), `camera` e `editor` são painéis que outras partes abrem (a lista de janelas fica na página de atalhos, o editor e a câmera vêm do menu).
4. **O deck**, depois das páginas: `tiles` (botões e ordem), `arrange` (segurar e arrastar), `pager` (páginas, abas, `render`), `pc` (estado do PC e pílula de energia),
   `header` (microfone, player, menu, faixa de ativos), `volume`, `reload` (autoatualização), `connection` (online/offline, recuperação, wake lock).
5. `app.js` só junta e inicia.

**Navegação por orientação.** Não há mais `<header>`: o `<nav class="nav">` fica à esquerda em paisagem (trilho) e embaixo em retrato (barra), escolhido por `@media (orientation: landscape|portrait)` e não por largura. Tokens em `:root`: `--touch: 48px` (alvo mínimo da navegação), `--rail-w: 72px`, `--bar-h: 56px`, `--strip-h: 36px`, mais os `--safe-*` da câmera. O trilho/barra cobre o recorte do seu lado (`padding-left: var(--safe-left)` / `padding-bottom: var(--safe-bottom)`), e por isso `.main` zera esse `--safe-*` e o `measure()` do `pager.js` lê os `--safe-*` do próprio `#pager` (não da raiz) para ajustar a grade ao que sobra. O `nav` tem: o ponto de status (`#status`, só o ponto: o texto fica a cargo da faixa `#offline`; mais o ícone do PC em paisagem), as abas `#tabs` (`role=tablist`, `.tab[data-section][aria-selected]`: ícone sobre rótulo curto, 48 px) e o menu `#menu`/`#menu-pop` (em paisagem abre ao lado do trilho; em retrato 6 destinos + ⋯ não cabem na barra, então o status e o ⋯ ficam `position: fixed` na linha da faixa de ativos, no alto). O corpo é flex: paisagem `[trilho][.main]`, retrato `[.main][barra]`; `.main` contém `#live-strip`, `#offline` e `#pager` (mais o `#page-dots`, sobreposto).

**Faixa de ativos** (`#live-strip`, acima do pager): pílula de energia, câmera, microfone, player e pílula de FPS (`#fps`, `game.js`, só enquanto um jogo roda e fora de Desempenho; em retrato só o número). Alinhada à direita, 44 px. `header.js` observa o atributo `hidden` dos filhos (MutationObserver) e põe `hidden` na faixa inteira quando nenhum aparece, para o pager recuperar a altura; em retrato a faixa fica sempre visível (é a linha do status e do ⋯). Todo botão da faixa e o ⋯ têm no mínimo 44x44 px (as pílulas de energia e FPS parecem ter 28 px, mas o botão tem 44 px de altura; o desenho fica num `::before`). Com tudo ligado ao mesmo tempo em 411 px os botões não encolhem: a pílula de energia usa menos preenchimento e rótulos curtos ("Reinicia av."), e a faixa deixa folga para o ponto de status e o ⋯ (`layout.ui.test.js` prova o pior caso e o mínimo de 44 px).

**Abas e indicador de página.** A aba mostra sempre o nome da seção (sem "Desempenho 1/3" nem bolinhas na aba). Tocar na aba da seção atual volta à primeira página dela (já nela, nada acontece); vir de outra seção cai na última página vista ali. Seções com mais de uma página (Apps/Atalhos com muitos itens) mostram o indicador `#page-dots` (pontos, `pointer-events: none`, sobre o preenchimento inferior das páginas, fora do layout); seções de página única não mostram nada. Grade medida: paisagem 836x387 passou de 7x3 para 6x3 (trilho de 72 px), retrato 411x914 de 3x8 para 3x7 (barra de 56 px + linha de 36 px); `TILE_ASPECT`/`MIN_TILE_H` ficaram como estavam. O resto dos blocos de `pages.css` que eram `max-width: 640px` agora são `(orientation: portrait)`.

**Faixa offline.** Logo abaixo da faixa de ativos vem `#offline` ("PC desconectado" ou "Não autorizado", mais o botão "Tentar agora"): ocupa espaço no fluxo (o pager encolhe) e só aparece com `body[data-state="offline"]`. O botão chama `Deck.connection.retry()`, a mesma verificação do `tick` sem esperar o silêncio do push.

**Voltar.** `Deck.back()` desfaz uma coisa por chamada, na ordem: a sheet de `#modal-root` (último filho), o menu (`#menu-pop`), o overlay aberto mais recente (`Deck.overlay` mantém uma pilha); sem nada aberto, qualquer página que não seja Apps volta para Apps. Devolve `true` se fez algo e `false` se já estava em Apps sem nada aberto. O app Android chama isso em `onBackPressed` e nunca fecha por conta própria. `Deck.goTo(id)` (e `Deck.pager.goToId`) devolve `false` se a página ainda não existe.

**Recorte da câmera.** O tema `DeckTheme` (`res/values-v28`, API 28+) deixa a página desenhar sob o recorte (`shortEdges`); o CSS afasta o conteúdo com `--safe-top/right/bottom/left` (`env(safe-area-inset-*)`, 0 em navegadores sem recorte).

Os módulos conversam por `Deck.tiles`, `Deck.pager`, `Deck.pc`, `Deck.header`, `Deck.volume`, `Deck.reload` e `Deck.connection`, sempre no momento do uso,
nunca guardando variável de outro. `header.js` precisa vir depois das páginas porque lê `Deck.menuItems`.

## Wi-Fi e segurança de rede

HTTP só em `127.0.0.1`; o Wi-Fi é HTTPS em outra porta, com certificado próprio que o app **fixa pela impressão digital SHA-256**, e uma regra de firewall só para a
sub-rede local. Token obrigatório em tudo; `Host` validado; `POST` de outra origem recusado; 10 falhas bloqueiam o IP por 1 minuto. Detalhes de uso no README.

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

A lista da barra de tarefas fica em cache (`data/taskbar-cache.json`) e só é relida quando a pasta de atalhos fixados muda ou ao tocar em Atualizar.

## Testes

| Comando | O que roda | Precisa de |
|---|---|---|
| `npm run lint` | ESLint (inclui "erro engolido precisa de motivo") | Node |
| `npm test` | Lógica e servidor: carga da interface, geometria, câmera, macros, rede, push, eventos, segurança, HTTP, configuração, rotas (com módulos falsos), `Host` | Node |
| `npm run test:ui` | A interface em um navegador sem tela (Chrome, Brave ou Edge; `CHROME_PATH` aponta outro) contra um servidor falso: o deck (abas, arrastar, offline, Voltar, câmera, FPS) e o teste "nada se sobrepõe" (`layout.ui.test.js`: paisagem e retrato × 6 destinos, trilho/barra no lado certo, alvos ≥ 48 px, conteúdo não coberto, pior caso com todos os ativos ligados e faixa vazia; estrito por padrão, `LAYOUT_STRICT=0` só avisa). Pulado se não houver navegador | Navegador |
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
