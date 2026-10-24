# Plano de redesign da interface

Objetivo: fazer o app se comportar como um **stream deck no celular**: o que é necessário a no máximo 3 toques, nada sobreposto ou cortado, uma só linguagem de tecla e os gestos que quem usa Android espera (voltar, sheets, navegação ao alcance do polegar).
Regra de ouro: cada fase termina com `npm run check` verde **e** com as telas conferidas no aparelho (paisagem e retrato). Nenhuma fase depende de uma posterior.

Base do diagnóstico: análise feita no Galaxy A31 (1080×2400, 420 dpi, Android 12), 6 abas nas duas orientações, menu, mapa de janelas, editor, câmera e "Sobre este PC", mais a leitura do código.

## 1. Metas (como saberemos que acabou)

| Meta | Hoje | Alvo |
|---|---|---|
| Ação diária (abrir app, tecla, mudo, play/pause) | 1–2 toques | 1–2 toques (não piorar) |
| Volume, trocar saída de áudio, janela à frente, bloquear | 2 | 2 |
| Mover janela entre telas, brilho do monitor | 3+ (botão escondido atrás do FPS) | 2 |
| Editar uma tecla | 3+ (menu, editor, escolher, salvar) | 2 (modo Editar, tocar na tecla) |
| Desligar/reiniciar | 3 (aba, botão, segurar) | 3 (intencional) |
| Elementos sobrepostos ou cortados, nas 6 telas × 2 orientações | 5 casos | 0 |
| Estado offline visível em retrato | só um ponto de 6 px | faixa com texto e botão "Tentar agora" |
| Alvos de toque na navegação | 36–40 px | 48 px |
| Padrões de "botão" (tecla, cartão `.act`, chip/barra) | 3 | 1 para ações; cartões só para leitura |

## 2. Decisões de projeto

1. **Paisagem é o uso principal** (celular no suporte). Retrato é suportado, não otimizado primeiro.
2. **Navegação por trilho lateral em paisagem e barra inferior em retrato**, escolhidos por orientação (`@media (orientation: landscape)`), não por largura (`max-width: 640px`).
3. **Destinos (6):** Apps · Atalhos · Janelas · Som · PC · Energia. "PC" reúne Desempenho, Processos e Sistema como seletor segmentado.
4. **Os `id`s do HTML atuais não mudam** (`status`, `mic`, `player`, `cam`, `menu`, `power-pill`, `tabs`, `pager`, `toast`, `modal-root`). Os módulos `header.js`, `connection.js`, `pc.js` e `game.js` continuam funcionando, só o lugar dos elementos muda.
5. **O contrato `#tabs .tab[data-section][aria-selected]` é mantido**, porque `test/ui/deck.ui.test.js` depende dele.
6. **Fontes não aumentam.** No A31 (densidade 2,625) os rótulos já são legíveis; o problema é espaço e sobreposição, não tamanho.
7. **A interface não precisa de APK novo**, exceto nos itens marcados com 📱 (recorte, Voltar, dimmer). A página nova deve funcionar com o APK antigo (detectar `window.Android.xxx` antes de usar).

## 3. Fases

### Fase 0: Preparação (P)
- Há trabalho local não commitado em `monitor.js`, `game.js` (novo), `style.css`, `index.html` e outros. Commitar ou guardar antes de começar, para os diffs do redesign ficarem limpos. Criar a branch `redesign-ui`.
- Criar `server/scripts/device-shots.ps1`: usa o `adb` de `.tools/platform-tools`, trava a rotação com `cmd window user-rotation lock 0|1`, toca em cada destino, puxa os PNG para uma pasta e **restaura** a rotação automática (`cmd window user-rotation free`). É o "antes/depois" visual de cada fase. Capturar o baseline agora.
- Ampliar `test/ui/` com dois viewports (paisagem 836×387 e retrato 411×914; `launchBrowser` já aceita `width`/`height`) e um teste genérico **"nada se sobrepõe"**: em cada destino, nenhum botão da navegação ou pílula fica sobre o retângulo do conteúdo e nada estoura na horizontal. Esse teste falha hoje (FPS sobre o botão Mapa; cabeçalho em retrato) e deve passar no fim da Fase 1.

### Fase 1: Correções que sobrevivem ao redesign (P/M)
Itens que não serão jogados fora quando a navegação mudar:

| # | Item | Arquivos |
|---|---|---|
| 1.1 | **FPS sai de cima do conteúdo.** Vira uma pílula na área de ações (ao lado de mic/player), só visível fora do PC/Desempenho. Remove `position: fixed`. | `game.js`, `index.html`, `style.css` |
| 1.2 | **Offline legível em qualquer orientação.** A regra `@media` zera a fonte de `.status` em todos os estados; passa a esconder o texto só em `online`. Nova faixa `#offline` abaixo da navegação: "PC desconectado · Tentar agora" (chama a mesma verificação do `tick`). | `style.css`, `connection.js`, `index.html` |
| 1.3 | **Som, Câmera e Editor em retrato:** incluir `.sound-page`, `.camera-page`, `.editor-page` na regra de coluna única de `pages.css`; o player de Som, quando "Nada tocando", vira uma faixa fina (hoje ocupa uma coluna de ~1500 px). | `pages.css`, `sound.js`, `media.js` |
| 1.4 | **Energia sem ruído:** tirar os chips "Janelas abertas" e o aviso do cartão Estado (o mesmo aviso já existe no painel de confirmação, `power.js:225`); "Hibernar" some quando indisponível em vez de ficar apagado. | `power.js` |
| 1.5 | **Câmera só liga quando pedida:** hoje abrir "Câmera do celular" já chama `getUserMedia` e mostra a prévia (`camera.js:76`). Mostrar um estado de espera com botão "Ver prévia / Transmitir". | `camera.js` |
| 1.6 | 📱 **Recorte da câmera:** tema próprio em `res/values-v28/styles.xml` com `windowLayoutInDisplayCutoutMode=shortEdges` (o `minSdk` é 24, então só a partir da API 28), e variáveis CSS `--safe-top/left/right/bottom` a partir de `env(safe-area-inset-*)` aplicadas ao conteúdo. Ganha ~30 dp de largura em paisagem. | `AndroidManifest.xml`, `res/values-v28/`, `style.css` |
| 1.7 | 📱 **Botão Voltar do Android:** `onBackPressed` chama `Deck.back()` via `evaluateJavascript`. `Deck.back()` fecha, nessa ordem: sheet de `modal-root`, menu, overlay; depois volta à aba Apps; devolve `false` se já está em Apps (então continua ignorando, como hoje, para um Voltar acidental não derrubar o deck). `Deck.overlay` passa a se registrar numa pilha. | `MainActivity.java`, `deck.js`, `pager.js` |
| 1.8 | **Detalhes do mapa de janelas:** a leitura de brilho ("100%" colado em "sem controle de brilho") e os nomes cortados nas linhas. | `pages.css`, `windows.js` |

**Pronto quando:** `npm run check` verde, o teste "nada se sobrepõe" passa nos dois viewports, e as capturas do aparelho mostram os 6 destinos sem corte. APK reinstalado só por causa de 1.6 e 1.7.

### Fase 2: Nova navegação e destinos (G)
Ordem importa; cada passo deixa o app funcionando.

**2.1 Casca e tokens.** `body` vira grade: em paisagem `[trilho 64px][conteúdo]`, em retrato `[conteúdo][barra 56px]`. Tokens novos em `:root`: `--touch: 48px`, `--rail-w`, `--bar-h`. O `<header>` vira `<nav class="nav">` com: `#tabs`, bloco de status (ponto + nome do PC), área "ativos agora" (`#cam`, `#mic`, `#player`, `#power-pill`, FPS) e `#menu`. Os `id`s ficam; só mudam de lugar. O trilho ocupa 6 × 48 = 288 dp dos 387 dp úteis em paisagem, e o cabeçalho de 48 dp desaparece (+12% de altura para as teclas).

**2.2 `pager.js`.** `SECTIONS` passa a `apps, shortcuts, windows, sound, pc, power`. Removem-se o nome dinâmico da aba ("Desempenho 1/3"), as bolinhas dentro da aba e o "tocar na aba ativa avança de página" (comportamento invisível). Páginas múltiplas da grade (Apps com muitos itens) ganham um indicador de página próprio, no rodapé do conteúdo. Tocar na aba ativa volta ao início da seção.

**2.3 Volume fora de Atalhos.** `buildPages` perde a lógica de `footer`, `side` e `split` (menos código). Atalhos fica com a grade inteira (+1 linha de teclas). O `#volume` (que `volume.js` já mantém vivo) é movido para um painel aberto por um botão de volume no trilho: slider, mudo e anterior/play/próxima. 1 toque para abrir, mais o arrastar; de qualquer aba.

**2.4 Aba Janelas.** `windows.js` registra uma página com `Deck.addPage({ id: 'windows', section: 'windows', ... })`: lista com ações à esquerda e mapa/telas à direita (em retrato, seletor Lista | Mapa). Sai o `mapSheet` (overlay), o `Deck.windowsUi` e `Deck.lifecycle['shortcuts-0']`. `visible.list` e `visible.map` viram o `show`/`hide` da página. O mapa só mede e desenha quando visível (`renderScreens` no `show`), por causa do `ResizeObserver`.

**2.5 Aba PC.** Nova página única (`Deck.perf`, para não colidir com `Deck.pc`) com seletor segmentado **Desempenho | Processos | Sistema**. Cada painel reaproveita o elemento atual; `show`/`hide` delegam ao painel ativo (amostras do monitor, processos). `Deck.game.monitorOpen` passa a valer só com o painel Desempenho visível; `game.js` abre `PC → Desempenho` quando um jogo começa. "Sobre este PC" sai do menu e vira o painel Sistema. Processos passa a mostrar 12 ou mais linhas e uma ação "Encerrar" com toque longo e confirmação (precisa de rota nova no servidor: confirmar antes se já existe).

**2.6 Energia como teclas.** Os cartões `.act` viram `.tile` (ícone + nome, cor de `data-tone` no ícone) numa grade 4×2 (paisagem) ou 2×4 (retrato). A descrição vai só para o painel de confirmação, que já a tem. O cartão Estado vira uma faixa de uma linha. O banner de agendamento continua.

**2.7 Menu → ⚙.** Itens: Editar botões, Câmera do celular, Endereço do PC, Atualizar. Em paisagem abre ao lado do trilho; em retrato, como sheet inferior.

**2.8 Overlays como sheets.** `Deck.overlay` mantém a API (`open/close/isOpen`). Em retrato vira bottom sheet com alça e fecha arrastando para baixo; em paisagem mantém o painel cheio, mas o "Fechar" ganha 48 px de alvo.

**Testes:** atualizar `test/ui/deck.ui.test.js` (lista de abas, destinos novos); novos casos: aba Janelas mostra a lista e o mapa, painel de volume abre e muda o valor, seletor do PC alterna, `Deck.back()` fecha sheet → menu → overlay, faixa offline aparece com texto em retrato. Atualizar a lista de scripts em **dois** lugares ao mesmo tempo: `index.html` e `test/load-check.js`.

**Pronto quando:** tabela de metas (seção 1) cumprida nas linhas de toques e sobreposição; `npm run check` verde; conferido no A31 nas duas orientações.

### Fase 3: Modo Editar no próprio deck (M)
- O ⚙ ganha "Editar". Com `body.editing` ligado: teclas com contorno, **tocar numa tecla abre o editor já nela** (`editor.js` passa a aceitar um item inicial), arrastar continua reordenando (`arrange.js`), e os espaços vazios (`.slot`) viram botões "+" que abrem o editor para criar ali. Um chip "Concluir" aparece em "ativos agora". Voltar sai do modo.
- Dica de primeira vez, guardada em `localStorage` (com `try/catch`): "Segure e arraste para mover · Editar para alterar".
- Verificar em `tiles.js`/`routes` como a ordem é salva (`POST /api/layout`) para que uma tecla nova caia no espaço escolhido.
- Testes de UI: ligar o modo, tocar numa tecla abre o editor, tocar num slot cria.

### Fase 4: Dimmer para tela AMOLED (P) 📱
O app mantém a tela sempre ligada (`FLAG_KEEP_SCREEN_ON` e wake lock) e o A31 tem tela AMOLED. Ponte nova `Android.setDim(on)` (muda `screenBrightness` da janela, sem permissão); JS com um temporizador de inatividade (Desligado/1/2/5 min, em ⚙). O primeiro toque com a tela escurecida só acorda: não deve acionar a tecla debaixo. Não escurecer durante transmissão da câmera nem agendamento de energia. Detectar `window.Android.setDim` para funcionar com APK antigo.

### Fase 5: Pastas e perfis (G, opcional, decisão sua)
- **Pastas**: uma tecla do tipo `f:<id>` que abre um conjunto de teclas, com chip de voltar. Exige mudar o formato salvo em `/api/layout`, `/api/shortcuts` e macros, com testes em `routes.test.js` e `config.test.js`.
- **Perfil automático por app em primeiro plano**: a lista de janelas já indica a da frente (a primeira com `state !== 1`). Regra `match.app → conjunto de atalhos`, com chip do perfil ativo e "Fixar" para desligar a troca automática.
- Começar por um **spike pequeno** (confirmar o que `/api/windows` informa sobre a janela ativa e o desenho do formato) antes de comprometer a fase.

## 4. Ordem e esforço

`Fase 0 (P)` → `Fase 1 (P/M)` → `Fase 2 (G)` → `Fase 3 (M)` → `Fase 4 (P)` → `Fase 5 (G, opcional)`.
Dentro da Fase 2: 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6 → 2.7 → 2.8. Sugestão: parar e validar no aparelho depois de 2.3 (a navegação nova já está de pé com as abas antigas funcionando).

## 5. Riscos

| Risco | Mitigação |
|---|---|
| Mexer em `pager.js` e `windows.js` (arquivos com mais regressão no histórico) quebra a lista, o mapa ou o arrastar | O teste de UI com dois viewports e o de sobreposição vão antes (Fase 0); mudar um destino por vez |
| O trilho lateral rouba largura de teclas em paisagem | O cálculo de `measure()` já usa a largura real do `#pager`; conferir se o número de colunas continua bom (hoje 7×3) e ajustar `TILE_ASPECT` se preciso |
| A aba PC junta três polls (amostra, processos, info) | `show`/`hide` ativam só o painel visível; manter o comportamento atual de parar com a tela |
| `game.js` troca de página sozinha quando um jogo abre | Passa a abrir `PC → Desempenho`; manter a regra de não trocar com sheet aberto (`busy()`) |
| Segurar para arrastar e o novo toque para editar disputam o gesto | O modo Editar é explícito (`body.editing`); fora dele, nada muda |
| APK e interface evoluem em ritmos diferentes | Detectar `window.Android.*` antes de usar; só 1.6, 1.7 e a Fase 4 exigem APK |

## 6. Ao final de cada fase
- `npm run check`; capturas do aparelho com `device-shots.ps1` nas duas orientações, comparadas com o baseline.
- Atualizar `docs/ARQUITETURA.md` (seção Interface: módulos, destinos, `Deck.back`, `Deck.perf`) e o README, se citar abas.
- `graphify update .` depois de mexer em código, como pede o `CLAUDE.md` do workspace.

## 7. Decisões em aberto

1. **Lado do trilho** em paisagem: esquerda (junto ao recorte da câmera, que fica à esquerda quando o A31 está em `ROTATION_90`), direita, ou configurável?
2. **Janelas como aba própria** (proposto) ou continuar dentro de Atalhos, só com o botão "Mapa" visível?
3. **Fase 5** (pastas e perfis): fazer, adiar ou descartar?
4. **"Encerrar processo"** na aba PC: quer essa ação (exige rota nova e confirmação) ou a aba continua só de leitura?
