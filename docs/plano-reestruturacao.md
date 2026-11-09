# Plano de reestruturação

Objetivo: levar o projeto de "servidor Node + helpers C#/PowerShell + interface em JS puro" para uma base com tecnologias e práticas profissionais
(contrato de API, tipos, módulos, instalador), **sem parar de usar o painel** e **sem reescrever tudo de uma vez**.

Este documento é o plano de execução. As razões da escolha de stack estão resumidas em "Decisões" e devem virar ADRs em `docs/adr/` (Fase 1).

## 1. Decisões

| # | Decisão | Escolha | Alternativa se falhar |
|---|---|---|---|
| D1 | Agente no PC | **Rust** (`axum`, `tokio`, crate `windows`, `tracing`) | Go + um helper nativo, ou .NET (NativeAOT). Decidido no fim do spike da Fase 3.0 |
| D2 | Interface | **React + TypeScript + Vite**, PWA, servida pelo agente | Svelte/Solid se o React pesar |
| D3 | Contrato | **OpenAPI 3.1** como fonte única; tipos TS gerados (`openapi-typescript`); no Rust, `utoipa` gera o YAML e um teste confere que não divergiu | – |
| D4 | Tempo real | **SSE** (como hoje); WebSocket só para o fluxo da câmera, se compensar | – |
| D5 | Android | Casca **Kotlin** fina (mesma ponte `Android.*`) | Capacitor, se um dia houver iOS nativo |
| D6 | iPhone | Continua **PWA no Safari** (sem conta de desenvolvedor, sem Mac) | – |
| D7 | CI | **Sem GitHub Actions por ora** (decisão já registrada em `plano-qualidade.md`). Tudo roda local com um comando e um hook de `pre-push`. O workflow fica pronto em `docs/ci/` para ligar depois | Ligar o Actions quando o dono quiser |
| D8 | Migração | **Incremental** (strangler): a interface e o agente novos convivem com os antigos até a paridade | – |

Fora do escopo (de propósito): Spring, Angular, Flutter, banco de dados, Docker, microsserviços, app iOS nativo.

## 2. Princípios

1. Cada fase termina com `check` verde e o painel usável no celular. Nenhuma fase deixa o projeto "pela metade".
2. O comportamento visível não muda até a Fase 2; o que muda é por baixo.
3. **Contrato primeiro.** Nada é portado sem estar descrito no OpenAPI e coberto por teste de contrato.
4. **Um backend por vez.** Enquanto o Rust não cobre uma rota, o Node responde por ela (proxy), então nunca há rota faltando.
5. Os testes de hoje são o ouro: `routes.test.js`, `deck.ui.test.js` (1447 linhas) e `layout.ui.test.js` passam a rodar **contra qualquer implementação**.
6. Reversível: cada fase tem uma etiqueta git e um jeito de voltar (seção 6).

## 3. Estrutura alvo

```
self-stream-deck/
├─ contracts/
│  ├─ openapi.yaml            # 50 rotas + tópicos SSE
│  └─ fixtures/               # respostas de exemplo (usadas pelos testes e pelo harness)
├─ agent/                     # Cargo workspace (Fase 3)
│  └─ crates/{core,platform-windows,api,app}
├─ web/                       # React + TS + Vite (Fase 2)
│  ├─ src/{api,features,components,styles}
│  └─ e2e/                    # Playwright (herda os cenários do deck.ui.test.js)
├─ mobile/android/            # Kotlin (Fase 5)
├─ legacy/server/             # o server/ atual, congelado, só para correções (some na Fase 5)
├─ tools/                     # scripts de dev (gen de tipos, check, hooks)
└─ docs/{adr,ARQUITETURA.md,...}
```

Mapa do que existe hoje para onde vai:

| Hoje | Destino |
|---|---|
| `server/public/**` | `web/src/**` (reescrito por página) |
| `server/src/routes/*` | `agent/crates/api` (uma rota por vez) + `contracts/openapi.yaml` |
| `server/src/{system,media,monitor,power,taskbar,camera,vcam,keys,macros}` | `agent/crates/platform-windows` atrás de traits em `core` |
| `server/native/*.cs` + `server/scripts/*-host.ps1` | desaparecem: viram chamadas diretas da crate `windows` |
| `server/src/{security,config,config-check,validate,log}` | `agent/crates/{api,app,core}` |
| `server/src/{tls*,ios,addresses,lan-cli,firewall}` | `agent/crates/app` (subcomandos `lan`, `cert`) |
| `server/src/supervisor.js` + `scripts/autostart.ps1` | serviço/tarefa do instalador + bandeja |
| `server/data/*` | `%APPDATA%\SelfStreamDeck\` (migração automática, token preservado) |
| `android/` (Java) | `mobile/android/` (Kotlin) |

## 4. Fases

Estimativas em semanas de trabalho dedicado de uma pessoa; são ordem de grandeza, não promessa.

### Fase 0: Contrato e rede de segurança (≈ 1 semana) — **feita**

Sem ela, as fases 2 e 3 são arriscadas. Detalhes de uso em [contracts/README.md](../contracts/README.md).

- [x] `contracts/openapi.yaml` (OpenAPI 3.1): as 51 operações (50 rotas do código + `GET /api/requests`), parâmetros, corpos, erros, segurança por token (query, cabeçalho e cookie), esquemas compartilhados.
- [x] Os 9 tópicos do SSE descritos em `x-events` (`windows, state, audio, media, notifications, monitor, game, processes, power`) com o mesmo esquema da rota GET equivalente.
- [x] `contracts/fixtures/fake-pc.json`: o PC de mentira (apps, janelas, áudio, mídia, monitor, energia, câmera), determinístico. Substitui "gravar uma sessão real": nada de dado da máquina vai para o git.
- [x] `tools/contract-test`: sobe a pilha real do Node (`src/app.js` + `routes` + `security`) com módulos falsos e confere cada caso contra o contrato; o mesmo `run.js` aceita `--base-url` para outro agente em plataforma falsa. Hoje: **167 verificações**, mais a lista de rotas do código igual à do contrato.
- [x] Teste de contrato dos eventos: cada tópico entrega o primeiro valor, no formato documentado.
- [x] Regras de segurança como casos explícitos: token (3 formas), `Host` (421), `Origin` (403), pareamento, cookie, cabeçalhos, corpo inválido/grande, travessia de caminho, bloqueio (429).
- [x] O `harness.js` da interface passa a ser conferido contra o contrato (as respostas que a UI recebe nos testes têm de ser válidas) e serve a interface por pasta configurável (`SSD_WEB_DIR`), pronto para apontar para o build do React.
- [x] Linha de base estática em `tools/baseline/baseline-phase0-static.json` (código, tamanho da interface); `tools/baseline/measure.js --live` mede latência e memória; rodada ao vivo em `tools/baseline/baseline-phase0-live.json` (servidor Node de `legacy/server`: ~63 MB de working set / 32 MB privados, `/api/state` p50 12 ms, `/api/windows` 15 ms, `/api/audio` 56 ms, `/api/apps` 0,8 ms; a memória dos `ssd-helper` não entra).
- [x] Refatoração mínima para tornar o servidor testável: o tratamento de pedidos saiu de `src/index.js` para `src/app.js` (sem mudar o comportamento) e `createRoutes` expõe `routeTable()`.

Achados que o contrato registra (detalhes no README): o 413 chega ao cliente como conexão fechada; `iconVersion` era número na interface de teste e texto no servidor; o `harness` não enviava `fastStartup` em `/api/power` (corrigidos).

Linha de base dos testes (esta máquina): `npm test` verde, `layout.ui.test.js` verde (77 casos, ~1m35s) e `deck.ui.test.js` verde depois de corrigir um bug real de `windows.js` (abaixo). Antes da correção ele já falhava, igual, no commit `f0b3d74` limpo (portanto não era efeito da Fase 0).

**Bug corrigido:** se o navegador soltava o `pointer capture` com o dedo ainda na tela (um redimensionamento no meio do arrasto faz isso), `lostpointercapture` cancelava o arrasto e o `pointermove` seguinte lançava `TypeError` (`drag` nulo): a janela nunca era movida. Agora o capture é retomado e o `pointermove` ignora um gesto já encerrado.

Pronto quando: o teste de contrato passa 100% no Node e falha ao quebrar de propósito uma rota ou um tipo (verificado: remover uma rota do contrato e trocar o tipo de `level` quebram o teste).

### Fase 1: Monorepo, ferramentas e documentação (≈ 0,5 a 1 semana) — **feita**

- [x] `server/` movido para `legacy/server/` com `git mv` (histórico preservado), mais `node_modules`. Ajustados os caminhos de `tools/`, `.gitignore`, `README`, `CONTRIBUTING`, `ARQUITETURA` e o comentário do `MainActivity`.
- [x] `node tools/check.js` na raiz: lint, testes unitários e de contrato (`--full` inclui interface e integração; `--ci` inclui a interface). Passa a incluir `web/` e `agent/` quando existirem.
- [x] Hook `pre-push` em `tools/hooks` (ativado com `git config core.hooksPath tools/hooks`). Workflow do Actions guardado e **desligado** em `docs/ci/github-actions.yml.disabled` (ADR 0006).
- [x] `docs/adr/0001..0007`: Rust, React/TS PWA, OpenAPI, SSE, Android Kotlin com iPhone PWA, verificação local, migração incremental.
- [x] `.nvmrc` (24) e `rust-toolchain.toml`. O `.editorconfig` já existia; Prettier fica para a Fase 2 (`web/`), para não reformatar o código legado.
- [x] `server/data/` movida para `legacy/server/data/` (token, config, certificados, ícones preservados; o painel subiu de lá com os mesmos 20 apps e o mesmo certificado) e o fallback temporário de `config.js` foi removido. Só a pasta `vcam/` ficou fisicamente em `server/data/vcam/`: a DLL da câmera virtual está registrada no sistema com esse caminho e carregada pelo Brave e pelo Claude, e o Windows não deixa mover um arquivo em uso. `legacy/server/data/vcam` é uma junção (`mklink /J`) para ela. O painel vai mostrar a câmera direta como "não instalada" (o registro aponta para o caminho antigo); **reinstalar uma vez pelo painel** registra o novo caminho, e depois dá para apagar `server/`.
- [x] PNGs de `docs/redesign-*`: ficou só a série mais recente, em `docs/referencia-visual/` (19 capturas, referência da paridade da Fase 2); as outras 7 séries saíram da árvore (continuam no histórico do git).
- [x] Autostart recriado a partir de `legacy/server` (`npm run autostart:install -- -StartNow`, com UAC): a tarefa "Self Stream Deck" aponta para `legacy\server\scripts\launch-hidden.vbs` e o servidor responde em 7878.
- [ ] **Resto (não bloqueia a Fase 2):** reinstalar a câmera direta uma vez pelo painel e então apagar `server/` (só sobrou `server/data/vcam/`).

Pronto quando: `tools/check.js` verde e o painel roda de `legacy/server` igual a antes (verde: lint, unitários e contrato em 18 s).

### Fase 2: Interface React + TypeScript (≈ 3 a 4 semanas) — **2.1 e 2.2 prontas (todas as páginas e extras migrados); 2.3: paridade e troca de `/` feitas; Android real testado; falta o iPhone (adiado)**

Backend intacto (Node). A UI nova é servida em `/` e a antiga foi **removida** (`legacy/server/public`, `/legacy/` e os testes dela) assim que a nova passou nos testes e no A31; só o servidor Node continua em `legacy/server/` até a Fase 3.
Detalhes e comandos em [web/README.md](../web/README.md).

**2.1 Esqueleto — feito**
- [x] `web/`: Vite, React 18, TypeScript `strict` (+ `noUncheckedIndexedAccess`), ESLint, Vitest; build de 215 kB de JS (70 kB gzip) + 9,5 kB gzip de CSS.
- [x] Cliente da API gerado do OpenAPI (`openapi-typescript` + `openapi-fetch`): rota ou corpo fora do contrato não compila. `npm test` regenera os tipos.
- [x] `LiveHub` + `useLiveQuery`: um `EventSource` para todos os tópicos, fechado com a tela apagada, evento e rota GET como o mesmo objeto, consulta periódica só com o fluxo fechado (6 testes unitários).
- [x] Tokens e CSS da antiga copiados sem mudança; navegação trilho/barra por orientação, pager com scroll-snap (eixo por orientação, mantém a página ao girar), menu ⚙ (popover/folha com arrastar para fechar), faixa offline com "Tentar agora" e vigia de 45 s de silêncio, wake lock, tique de vibração.
- [x] Pilha do Voltar (`lib/back.ts`) e `window.Deck.back()` para o `MainActivity`; folhas (`#modal-root`) e `HoldButton` como componentes.
- [x] Servido pelo agente em `/v2/` (`http.js`: pasta `web/dist`, mesma exigência de token, manifest e ícones públicos como na antiga; coberto pelo teste de contrato de segurança).

**2.2 Páginas**
1. [x] **Energia** (`features/power`): teclas, linha de estado, contagem do agendamento, folha de confirmação, segurar para confirmar, atraso e forçar. 10 casos em navegador (portados da antiga + o novo "o toque do segure não clica na aba de baixo").
2. [x] **Som** (`features/sound`): player com capa, linha do tempo contada na página entre as respostas, "Nada tocando", troca de player; Saída, Entrada e mixer com `RangeSlider` (no máximo um pedido em voo, só vale a última posição; não briga com o dedo). 24 casos em navegador: as 18 cenas de layout da antiga (tocando, vazio, 14 apps × 6 viewports) e o que cada controle envia ao PC. Build agora com 224 kB de JS (73 kB gzip).
3. [x] **PC** (`features/pc`): Desempenho (CPU com barras por núcleo, memória, GPU, disco, rede, faixa do FPS do jogo), Processos e Sistema (armazenamento por disco físico, uptime que anda), seletor de 48 px; só o painel visível assina o fluxo / consulta o PC. Gráficos em SVG próprio (sem biblioteca). 23 casos em navegador (as 18 cenas da antiga: normal, 8 discos, sem GPU × 6 viewports) e 10 unitários das regras (níveis, histórico, caminhos do gráfico, blocos de armazenamento). O contrato ganhou `source` no FPS e os tipos de `Sistema` (armazenamento, rede, placa-mãe). `paneStore` já deixa o detector de jogo abrir Desempenho de qualquer página (falta o detector, em "Overlays e extras"). Build: 236 kB de JS (77 kB gzip).
4. [x] **Janelas** (`features/windows`): lista com botões de 48 px, mapa de telas a escala (arrastar para mover, até a borda para encaixar, até o topo para maximizar), painel da janela selecionada, brilho por tela, projeção, seletor Lista | Mapa em retrato. `geometry` virou módulo puro (`geometry.ts`) com os 14 testes da antiga portados e `model.ts` (layout, zonas, ordem das linhas) com mais 12. A ação muda a imagem na hora e as respostas seguintes confirmam ou corrigem; enquanto há arrasto ou ação em voo o que o PC diz não é desenhado. O mapa não se refaz no meio do gesto (os elementos são chaveados por janela, então nada é substituído sob o dedo) e o capture solto por redimensionamento é retomado. 11 casos em navegador: os da antiga (lista, seletor, seleção compartilhada, paisagem lado a lado, tocar no mapa sem redesenhar, arrastar com redimensionamento no meio, painel com 6 botões de 48 px) + borda/topo, fechar com dois toques, telas, brilho. Build: 251 kB de JS (82 kB gzip).
5. [x] **Apps e Atalhos** (`features/deck`): Apps numa página só com todas as teclas (grade normal, encaixe compacto ou rolagem, conforme cabe), Atalhos paginado com o indicador de página, macros como teclas, bolinhas de app rodando/aberto, estados vazios, recarga quando a lista da barra muda (`appsRev`) e **hold-and-drag para reordenar** (troca com outra tecla, vai ao fim num espaço vazio, a tecla desliza ao novo lugar). Para isso o `Pager` foi generalizado: acha as páginas no DOM (uma seção pode ter várias), guarda a página em que cada seção parou (só onde o deslize termina, não as que atravessa), mede a tela e passa as medidas às páginas, e mostra os pontos. `layout.ts` (puro: `measure`, `appsLayout`, `reorder`, `paginate`) tem 10 testes unitários. 24 casos em navegador: as 12 cenas de 24/30 apps × 6 viewports e o recuo para rolagem com 150 da antiga, o eixo do pager por orientação, trocar teclas, e o que a antiga não cobria (macros, páginas de Atalhos, vazio, appsRev). **Fica para o item 6:** o modo Editar (depende do editor) e a tecla da câmera. Build: 253 kB de JS (83 kB gzip).
6. [x] **Overlays e extras** (`features/editor`, `camera`, `idle`, `game`, `notices`):
   - **Modo Editar e editor**: o menu liga o modo (barra `Concluir` no fluxo, `+` nos espaços vazios, toque na tecla abre o editor naquela tecla, Voltar fecha o editor e depois o modo, sair de Apps/Atalhos encerra, dica na primeira vez com ou sem `localStorage`). O editor tem atalhos (chips de modificadores + tecla, prévia), macros (10 tipos de passo, subir/descer/remover, aparece em Apps ou Atalhos), ocultar apps, Testar (salva e roda) e Excluir com dois toques. Estado do modo num `editStore` externo (teclas, espaços, barra e menu estão longe na árvore). `model.ts` puro com 8 testes.
   - **Câmera do celular**: `CameraController` (singleton, sobrevive à folha): prévia espelhada só na frontal, transmissão por quadros JPEG para `/api/camera/frame` (um por segundo quando ninguém usa a imagem), tecla da câmera em Apps (bolinha vermelha ao transmitir), passos `camera` das macros, câmera virtual direta (instalar/remover segurando) e link do OBS.
   - **Escurecer** (véu, `Android.setDim`, só acorda no primeiro toque, não escurece com dedo na tela/folha/overlay/menu/energia agendada/câmera/modo Editar), **jogo/FPS** (contador flutuante + deslize para PC > Desempenho, inclusive se já rodava ao carregar), **notificações do Windows**, **auto-atualização** (o servidor agora também acompanha o build de `web/dist`), **Código de pareamento** no iPhone e `pair.html`/`pair.js` copiados para `web/public`.
   - 10 casos (extras) + 16 (editor) + 8 (câmera) em navegador. Tipos do `Overlay` novo reaproveitados por escurecer, editor e câmera. Build: 295 kB de JS (97 kB gzip).

Portado da antiga durante a migração (bug que existia nas duas): ao completar o "segure", a folha some com o dedo ainda na tela e o toque seguinte clicava na aba da barra (em retrato abria "PC"). Corrigido em `HoldButton` e em `deck.js` (`holdButton`).

**2.3 Paridade e troca** — feita, falta o aparelho real
- [x] **Paridade em navegador:** `layout.ui.test.js` roda contra as duas (`SSD_UI_BASE=/`: 77 de 77) e as demais cenas de `deck.ui.test.js` (111) foram portadas para `web/e2e` (shell, apps, sound, pc, windows, extras, editor, camera e `chrome`: menu, folhas, sobreposições e a matriz "a última coisa termina acima da barra"). Só o teste de vibração do iPhone ficou de fora.
- [x] **Troca:** `/` serve `web/dist` (`vite base '/'`, manifest com `start_url '/'`); `/v2/` redireciona para `/`; o `pair.html` e o `camera.html` vivem em `web/public`. A interface antiga foi apagada (plano antigo era mantê-la em `/legacy/` por uma versão; o dono dispensou). O servidor falso e o navegador sem tela saíram de `legacy/server/test/ui` para `web/e2e/harness.cjs`; as 77 medições de layout viraram `web/e2e/layout.e2e.cjs`.
- [x] **Android real (A31, no app):** páginas Apps, Janelas, Som e PC, menu (popover em paisagem, folha em retrato), folha da câmera, Voltar e rotação, sem erros de script no log. Ainda por testar no aparelho: escurecer, notificações e Atualizar.
- [ ] **Adiado:** iPhone no Safari e na Tela de Início. 

### Fase 3: Agente em Rust (≈ 5 a 7 semanas) — **3.0 e 3.1 feitas; 3.2 em andamento (19 de 51 operações: layout, pareamento, áudio, mídia, atalhos e a lista de apps); 3.3 pendente**

**3.0 Spike de viabilidade (3 a 5 dias), com portão de decisão — feito, passou ([ADR 0008](adr/0008-spike-rust-windows.md))**
Provar em Rust, fora do produto, os três pontos de maior risco: (a) Core Audio (volume, mudo, mixer por app, troca de dispositivo padrão), (b) SMTC via WinRT (leitura e controle de mídia), (c) `SetWinEventHook` empurrando mudanças de janelas. Se algum for inviável ou muito frágil, aplicar a alternativa da D1 e registrar no ADR.
Resultado: os três funcionam em Rust (`agent/spike`: Core Audio 11 ms, SMTC 12 ms, ganchos de janela instalados), com o alvo `x86_64-pc-windows-gnu` (não há Visual Studio aqui). Falta provar só a vtable de `IPolicyConfig` (trocar o dispositivo padrão), no item 6.

**3.1 Esqueleto (1 semana) — feito, com o que ficou para depois indicado**
- [x] Workspace Cargo `agent/`: `core` (guard, config, portas `AudioPort/MediaPort/PowerPort`), `api` (axum), `agent` (binário `ssd`) e o `spike`. Faltam as portas `InputPort/WindowsPort/MonitorPort/TaskbarPort/VCamPort` e o crate `platform-windows`, que entram com cada módulo da 3.2.
- [x] `axum` com validação de `Host`, bloqueio por falhas, token (consulta, cabeçalho, cookie), origem, página de pareamento, manifest/ícones públicos e estáticos com ETag/304 (paridade com `security.js`/`http.js`). [ ] Ainda não: estáticos embutidos no exe (`rust-embed`; hoje lê `web/dist`) e o hub de SSE próprio (o SSE passa pelo proxy; vira próprio com o primeiro tópico portado).
- [x] Config: mesma `config.json` do Node (chaves desconhecidas preservadas, BOM aceito), gravação atômica com `.bak`, nunca sobrescreve arquivo ilegível. [ ] Falta a validação equivalente a `config-check.js` (hoje só o tipo das chaves editáveis).
- [x] `tracing` com nível por `SSD_LOG`; contadores de `/api/requests`.
- [x] **Proxy de transição:** o agente Rust sobe o Node como filho em porta interna e repassa as rotas ainda não portadas (a UI e o celular só enxergam a porta do Rust). A cada rota portada, remove-se do proxy.
- [~] `tools/agent-check` (10 casos: Host, token, pareamento, Origin, bloqueio, estáticos, proxy JSON e SSE, rotas portadas) roda contra o `ssd` com o Node atrás. O teste de contrato completo (`tools/contract-test`) ainda roda só contra o Node: precisa do modo `--fake-platform` do Rust, que vem junto com as portas.

**3.2 Módulos, do menos arriscado para o mais arriscado**
Cada item: porta em `core`, implementação em `platform-windows`, adaptador falso para teste, rota no `api`, contrato verde, remoção da rota do proxy.

| Ordem | Módulo | Rotas | Observação |
|---|---|---|---|
| 1 | Estado e ping | `/api/ping`, `/api/state`, `/api/layout`, `/api/pair-code` | **`/api/layout` e `/api/pair-code` portadas**; `ping` e `state` dependem dos módulos de PC |
| 2 | Energia | `/api/power` | desligar, reiniciar, agendar, hibernar |
| 3 | Teclas e macros | `/api/shortcut/:id`, `/api/macro/:id`, `/api/mediakey/:key`, `/api/shortcuts`, `/api/macros` | **atalhos e teclas de mídia portados** (`keybd_event`, mesma lista fechada de teclas em `core/keys.rs`); macros dependem de apps/janelas e ficam no Node |
| 4 | Editor | `/api/editor*` | validação já existe no desenho de `validate.js` |
| 5 | Apps e barra de tarefas | `/api/apps`, `/api/launch/:id`, `/api/icon/:id`, `/api/refresh` | **lista, ícones e atualizar portados** (`IShellLinkW` + `PrivateExtractIconsW` + PNG, ~ms em vez de 2,5 s de PowerShell; mesmos 21 ids, nomes e processos que o Node neste PC). Diferenças aceitas: a versão do ícone vem do PNG do Rust (outro texto), e `wt.exe` usa o ícone do atalho. `/api/launch/:id` fica no Node até o módulo de janelas (focar a janela já aberta) |
| 6 | Áudio | `/api/audio*`, `/api/volume`, `/api/mic` | **portado** (`platform-windows/audio.rs`: volume, mudo, microfone, dispositivos, mixer por app e troca do padrão por `IPolicyConfig`, conferido contra o Node neste PC: mesmas listas; o rótulo do app às vezes sai melhor, porque o Rust lê a descrição do exe também de processos protegidos) |
| 7 | Mídia | `/api/media*` | **portado** (`platform-windows/media.rs`, SMTC tipado; capa com cache de 40 e MIME pela assinatura; chave da capa por FNV-1a em vez de SHA-1) |
| 8 | Monitor | `/api/monitor/*` | PDH, `nvidia-smi`, RTSS/Afterburner, WMI |
| 9 | Janelas e telas | `/api/windows*`, `/api/screens*` | `SetWinEventHook` empurra para o SSE; brilho DDC/CI |
| 10 | Notificações do Windows | `notifications.js` | o que a UI usa hoje |
| 11 | Câmera e câmera virtual | `/api/camera/*` | por último: DirectShow/Media Foundation é o trecho mais trabalhoso; pode ficar no helper C# por mais tempo, sem bloquear o resto |
| 12 | LAN/TLS/iPhone | `lan-cli`, `tls*`, `ios`, `firewall` | geração de AC e certificado (`rcgen`), firewall |

**3.3 Corte**
- [ ] Todas as rotas no Rust; proxy removido; Node e C# fora do caminho de produção.
- [ ] Paridade: contrato + Playwright + 1 semana de uso. Comparar com a linha de base da Fase 0 (RAM, startup, latência).

Riscos: câmera virtual (ordem 11), SMTC e Core Audio (cobertos pelo spike), diferenças sutis de comportamento que só o uso real mostra (por isso o proxy e as fixtures). Gatilho de saída: se a Fase 3.2 passar de 2x a estimativa sem fechar a ordem 9, reavaliar D1.

### Fase 4: Empacotamento e operação (≈ 1 a 2 semanas) — não começou (depende da 3.3)

- [ ] Instalador MSI (WiX) ou `cargo-dist`: instala em `Program Files`, atalho, desinstalação limpa, regra de firewall opcional.
- [ ] Config e dados em `%APPDATA%\SelfStreamDeck\`; **migração automática** de `server/data/config.json` (token preservado, para o celular não perder o pareamento), `.bak`, `tls/`, `icons/`.
- [ ] Ícone na bandeja: status, abrir painel, mostrar QR/código de pareamento, abrir logs, sair.
- [ ] Início com o Windows (tarefa agendada ou serviço) e reinício automático em falha (substitui `supervisor.js` e `autostart.ps1`).
- [ ] Assinatura do `.exe` e do instalador (certificado próprio no início; um certificado de verdade quando for distribuir).
- [ ] Atualização automática com verificação de assinatura, e canal "estável/teste".
- [ ] Logs com rotação; comando `ssd diagnose` que junta log, versão, config sem token.

Pronto quando: máquina limpa instala, pareia o celular e funciona após reiniciar o PC.

### Fase 5: Android em Kotlin e limpeza (≈ 0,5 a 1 semana) — não começou (a parte de remover a interface antiga já foi feita na Fase 2)

- [ ] `MainActivity.java` (407 linhas) → Kotlin, mesma ponte (`openSettings`, `vibrate`, `reconnect`, `setDim`); Gradle com versões em catálogo.
- [ ] Remover `legacy/server`, `server/native`, scripts PowerShell e a UI antiga; atualizar `README`, `CONTRIBUTING`, `ARQUITETURA.md`.
- [ ] Reativar/ligar o Actions se o dono decidir (D7).
- [ ] Retrospectiva: o que ficou melhor, medido contra a linha de base.

## 5. Qualidade em todas as fases

| Camada | Ferramenta | O que cobre |
|---|---|---|
| Rust | `cargo test`, `clippy -D warnings`, `rustfmt` | núcleo com adaptadores falsos; integração real do Windows marcada `#[ignore]` e rodada à mão |
| Web | `tsc --strict`, ESLint, Vitest | lógica pura (geometria, `appsLayout`, reducers) |
| UI | Playwright, 4 viewports | alvos de toque, sobreposição, cortes, rolagem, ordem dos cartões (cenários atuais) |
| Contrato | teste de contrato contra o OpenAPI | qualquer backend |
| Segurança | casos explícitos de `Host`, token, origem, bloqueio por falhas, entradas inválidas (400 e não 500) | paridade com o Node |
| Real | checklist manual no aparelho | rotação, câmera, iPhone, Android, jogo rodando |

## 6. Reversão

| Fase | Como voltar |
|---|---|
| 0 e 1 | `git revert`; só adiciona arquivos e move pastas |
| 2 | `/legacy/` serve a UI antiga por uma versão; o botão do menu alterna |
| 3 | o proxy de transição permite devolver qualquer rota ao Node mudando uma linha; o instalador antigo continua disponível |
| 4 | desinstalar restaura o autostart do `legacy` (a migração de config copia, não move) |
| 5 | só ocorre depois de uma semana estável nas anteriores; etiqueta `pre-limpeza` |

## 7. Riscos principais

| Risco | Impacto | Mitigação |
|---|---|---|
| Câmera virtual em Rust | alto | deixar por último; manter o helper C# até lá |
| COM/WinRT em Rust mais difícil que o esperado | médio | spike 3.0 com portão de decisão |
| Regressão sutil de layout na UI nova | alto | testes nos 4 viewports antes de trocar `/`; baseline de capturas |
| Perder o pareamento dos celulares na migração | médio | preservar o token; teste de migração com a config real |
| Escopo crescer ("já que estou aqui...") | alto | cada fase só entrega paridade; funcionalidade nova vai para um backlog |
| Parar de corrigir o painel atual durante a reescrita | médio | `legacy/` continua aceitando correções pequenas, portadas depois |

## 8. Ordem sugerida e marcos

1. **Marco A (fim da Fase 1):** contrato, testes de contrato, `check` único, ADRs. Já é um ganho profissional completo, mesmo se parar aqui.
2. **Marco B (fim da Fase 2):** interface tipada e modular. Maior ganho visível para quem mexe no código.
3. **Marco C (fim da Fase 3):** um único `.exe`, sem Node, C# nem PowerShell.
4. **Marco D (fim das Fases 4 e 5):** instalável por qualquer pessoa, limpo e documentado.

## 9. Perguntas em aberto

- O Actions continua desligado (D7), ou ligamos já na Fase 1?
- Haverá distribuição para outras pessoas (precisa de certificado de assinatura "de verdade") ou é uso próprio?
- Aceita-se trocar o Rust por Go/.NET se o spike mostrar que o COM/WinRT cobra caro?
- A câmera virtual precisa continuar nativa, ou aceitamos mantê-la como um componente C# separado indefinidamente?
