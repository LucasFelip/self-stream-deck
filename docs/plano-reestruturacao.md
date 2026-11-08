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
- [x] Linha de base estática em `tools/baseline/baseline-phase0-static.json` (código, tamanho da interface); `tools/baseline/measure.js --live` mede latência e memória do seu agente (precisa do seu token, por isso não foi rodado aqui).
- [x] Refatoração mínima para tornar o servidor testável: o tratamento de pedidos saiu de `src/index.js` para `src/app.js` (sem mudar o comportamento) e `createRoutes` expõe `routeTable()`.

Achados que o contrato registra (detalhes no README): o 413 chega ao cliente como conexão fechada; `iconVersion` era número na interface de teste e texto no servidor; o `harness` não enviava `fastStartup` em `/api/power` (corrigidos).

Linha de base dos testes (esta máquina): `npm test` verde; `layout.ui.test.js` verde (77 casos, 1m35s); `deck.ui.test.js` **já falhava antes da Fase 0**, de forma repetível, em "Janelas: dragging a window on the map moves it..." (`deck.ui.test.js:593`, o `place` não é enviado depois do redimensionamento no meio do arrastar) e por isso para nos 54 primeiros casos (3m21s). Ficou como pendência a corrigir antes da Fase 2, porque é a rede de segurança da interface.

Pronto quando: o teste de contrato passa 100% no Node e falha ao quebrar de propósito uma rota ou um tipo (verificado: remover uma rota do contrato e trocar o tipo de `level` quebram o teste).

### Fase 1: Monorepo, ferramentas e documentação (≈ 0,5 a 1 semana)

- [ ] Mover o `server/` para `legacy/server/` (git mv, histórico preservado) e ajustar caminhos de scripts e docs.
- [ ] Raiz com um `check` único (`tools/check`) que roda lint, testes, contrato e UI; mesmo comando local e, depois, no Actions.
- [ ] Hook `pre-push` (via `core.hooksPath`) que roda o `check` rápido. Workflow do Actions escrito e guardado, **desligado** (D7).
- [ ] `docs/adr/0001..0005`: D1 a D5, com o contexto e as alternativas rejeitadas.
- [ ] Tirar PNGs de `docs/redesign-*` do histórico atual (mover para um release/artefato; manter só 1 baseline por viewport) para encolher o repositório.
- [ ] `.editorconfig`, `rust-toolchain.toml`, `.nvmrc`, Prettier/ESLint na raiz.

Pronto quando: `tools/check` verde, o painel roda de `legacy/server` igual a antes.

### Fase 2: Interface React + TypeScript (≈ 3 a 4 semanas)

Backend intacto (Node). A UI nova é servida em `/v2/` ao lado da antiga (`/`), com um botão no menu ⚙ "Testar nova interface". Quando houver paridade, `/` aponta para a nova.

**2.1 Esqueleto (3 a 4 dias)**
- [ ] `web/` com Vite, TS `strict`, ESLint, Vitest, Playwright, PWA (`manifest`, service worker mínimo, ícones atuais).
- [ ] Cliente da API gerado do OpenAPI; `fetch` com token/cookie igual ao atual, tratamento de 401/offline.
- [ ] Hook `useEvents(topics)` sobre SSE com o plano B de polling (herdar `live.js`) e `TanStack Query` para o estado do servidor.
- [ ] Tokens CSS portados de `style.css` (`--touch`, `--rail-w`, `--bar-h`, `--safe-*`); navegação por orientação (trilho/barra) como componente.
- [ ] `Deck.back()`, pilha de overlays e folhas (`Deck.overlay`) como contexto React; sem globais.

**2.2 Páginas, da mais simples para a mais difícil**
1. [ ] **Energia** (`power.js`): teclas, banner de agendamento, folha de confirmação com `holdButton`.
2. [ ] **Som** (`sound.js`, `media.js`, `audio.js`): player, Saída/Entrada, mixer; sliders com `touch-action: none`.
3. [ ] **PC** (`monitor.js`): Desempenho/Processos/Sistema, gráficos (canvas ou SVG leve; sem biblioteca grande).
4. [ ] **Janelas** (`windows.js`, `geometry.js`): lista + mapa de telas; `geometry` vira módulo puro com os testes atuais portados para Vitest.
5. [ ] **Apps e Atalhos** (`pager.js`, `tiles.js`, `arrange.js`, `edit.js`): o trecho mais delicado (grade medida, scroll-snap, arrastar para reordenar, modo Editar). Portar `appsLayout()` como função pura com testes numéricos (os tamanhos medidos no `ARQUITETURA.md` viram casos).
6. [ ] Overlays: **Câmera** (`camera.js`, `camera.html`), **Editor** (`editor.js`), **Escurecer** (`idle.js`), **notificações** (`notifications.js`), **pareamento** (`pair.html/js`), **game/FPS** (`game.js`), reconexão (`connection.js`), autoatualização (`reload.js`).

**2.3 Paridade e troca**
- [ ] Os cenários de `deck.ui.test.js` e `layout.ui.test.js` portados para Playwright nos 4 viewports (836x387, 740x360, 411x914, 360x740) e passando na UI nova.
- [ ] Teste no aparelho real (Android no app, iPhone no Safari e na Tela de Início), incluindo recorte da câmera (`--safe-*`) e rotação.
- [ ] Medir peso do bundle (meta: < 250 kB gzip) e tempo até interativo no celular.
- [ ] Trocar `/` para a nova UI; manter a antiga em `/legacy/` por uma versão.

Pronto quando: os testes de UI passam nas duas UIs, uso diário de 1 semana sem voltar à antiga.

### Fase 3: Agente em Rust (≈ 5 a 7 semanas)

**3.0 Spike de viabilidade (3 a 5 dias), com portão de decisão**
Provar em Rust, fora do produto, os três pontos de maior risco: (a) Core Audio (volume, mudo, mixer por app, troca de dispositivo padrão), (b) SMTC via WinRT (leitura e controle de mídia), (c) `SetWinEventHook` empurrando mudanças de janelas. Se algum for inviável ou muito frágil, aplicar a alternativa da D1 e registrar no ADR.

**3.1 Esqueleto (1 semana)**
- [ ] Workspace Cargo: `core` (domínio, traits `AudioPort/MediaPort/InputPort/PowerPort/WindowsPort/MonitorPort/TaskbarPort/VCamPort`, tipos), `platform-windows`, `api`, `app`.
- [ ] `axum` com: validação de `Host`, bloqueio por falhas, token, origem (paridade com `security.js`), estáticos embutidos (`rust-embed`) com ETag, SSE com produtores "só enquanto alguém escuta" e último valor ao entrar.
- [ ] Config (`serde` + validação equivalente a `config-check.js`), gravação atômica com `.bak`, nunca sobrescrever arquivo ilegível.
- [ ] `tracing` com nível por `SSD_LOG`; contadores de `/api/requests`.
- [ ] **Proxy de transição:** o agente Rust sobe o Node como filho em porta interna e repassa as rotas ainda não portadas (a UI e o celular só enxergam a porta do Rust). A cada rota portada, remove-se do proxy.
- [ ] Teste de contrato rodando contra o Rust.

**3.2 Módulos, do menos arriscado para o mais arriscado**
Cada item: porta em `core`, implementação em `platform-windows`, adaptador falso para teste, rota no `api`, contrato verde, remoção da rota do proxy.

| Ordem | Módulo | Rotas | Observação |
|---|---|---|---|
| 1 | Estado e ping | `/api/ping`, `/api/state`, `/api/layout`, `/api/pair-code` | só config |
| 2 | Energia | `/api/power` | desligar, reiniciar, agendar, hibernar |
| 3 | Teclas e macros | `/api/shortcut/:id`, `/api/macro/:id`, `/api/mediakey/:key`, `/api/shortcuts`, `/api/macros` | `SendInput`; manter a lista fechada de teclas |
| 4 | Editor | `/api/editor*` | validação já existe no desenho de `validate.js` |
| 5 | Apps e barra de tarefas | `/api/apps`, `/api/launch/:id`, `/api/icon/:id`, `/api/refresh` | ícones, cache |
| 6 | Áudio | `/api/audio*`, `/api/volume`, `/api/mic` | Core Audio |
| 7 | Mídia | `/api/media*` | SMTC; capa em `/api/media/art` |
| 8 | Monitor | `/api/monitor/*` | PDH, `nvidia-smi`, RTSS/Afterburner, WMI |
| 9 | Janelas e telas | `/api/windows*`, `/api/screens*` | `SetWinEventHook` empurra para o SSE; brilho DDC/CI |
| 10 | Notificações do Windows | `notifications.js` | o que a UI usa hoje |
| 11 | Câmera e câmera virtual | `/api/camera/*` | por último: DirectShow/Media Foundation é o trecho mais trabalhoso; pode ficar no helper C# por mais tempo, sem bloquear o resto |
| 12 | LAN/TLS/iPhone | `lan-cli`, `tls*`, `ios`, `firewall` | geração de AC e certificado (`rcgen`), firewall |

**3.3 Corte**
- [ ] Todas as rotas no Rust; proxy removido; Node e C# fora do caminho de produção.
- [ ] Paridade: contrato + Playwright + 1 semana de uso. Comparar com a linha de base da Fase 0 (RAM, startup, latência).

Riscos: câmera virtual (ordem 11), SMTC e Core Audio (cobertos pelo spike), diferenças sutis de comportamento que só o uso real mostra (por isso o proxy e as fixtures). Gatilho de saída: se a Fase 3.2 passar de 2x a estimativa sem fechar a ordem 9, reavaliar D1.

### Fase 4: Empacotamento e operação (≈ 1 a 2 semanas)

- [ ] Instalador MSI (WiX) ou `cargo-dist`: instala em `Program Files`, atalho, desinstalação limpa, regra de firewall opcional.
- [ ] Config e dados em `%APPDATA%\SelfStreamDeck\`; **migração automática** de `server/data/config.json` (token preservado, para o celular não perder o pareamento), `.bak`, `tls/`, `icons/`.
- [ ] Ícone na bandeja: status, abrir painel, mostrar QR/código de pareamento, abrir logs, sair.
- [ ] Início com o Windows (tarefa agendada ou serviço) e reinício automático em falha (substitui `supervisor.js` e `autostart.ps1`).
- [ ] Assinatura do `.exe` e do instalador (certificado próprio no início; um certificado de verdade quando for distribuir).
- [ ] Atualização automática com verificação de assinatura, e canal "estável/teste".
- [ ] Logs com rotação; comando `ssd diagnose` que junta log, versão, config sem token.

Pronto quando: máquina limpa instala, pareia o celular e funciona após reiniciar o PC.

### Fase 5: Android em Kotlin e limpeza (≈ 0,5 a 1 semana)

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
