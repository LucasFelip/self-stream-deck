# self-stream-deck

Transforma um celular Android (feito para o Galaxy A31) em um painel de controle do PC com Windows:
abrir/focar aplicativos, atalhos de teclado, volume e áudio avançado, mídia tocando agora, monitor do
sistema e controles de energia.

```
┌──────────────┐   HTTP (USB/adb reverse, ou Wi-Fi opcional)   ┌──────────────────────────┐
│ App Android  │ ───────────────────────────────────────────▶ │ server/ (Node, no PC)    │
│ (WebView)    │ ◀── interface web, ícones, dados ─────────── │  • helpers PowerShell     │
└──────────────┘                                               └──────────────────────────┘
```

- `server/` — servidor no PC. Node 20+, **sem dependências** (não precisa de `npm install`).
  Serve também a interface web (`server/public/`), então a lógica do painel fica toda no PC.
- `android/` — app Android fino (Java, sem libs): guarda o endereço do PC, mantém a tela ligada,
  vibra ao toque e mostra a página. Mudar a interface **não exige recompilar o APK**.

## Páginas

Não há rolagem na tela principal: o painel é dividido em **páginas**, agrupadas em **4 abas** fixas no
topo para não ser preciso ficar deslizando até achar a certa:

| Aba | Páginas |
|---|---|
| **Apps** | Aplicativos |
| **Atalhos** | Atalhos de teclado, volume e lista de janelas |
| **Som** | Mídia e áudio numa tela só |
| **Desempenho** | Desempenho ("Sobre este PC" fica no menu ⋯) |
| **Energia** | Energia |
| **Processos** | Processos |

Tocar numa aba vai direto para ela (na última página que você tinha aberto ali); tocar na aba **ativa**
avança para a próxima página do grupo; os pontinhos sob a aba ativa mostram onde você está, e o nome da
aba vira o da página atual. Arrastar para os lados continua percorrendo todas as páginas em ordem (o mapa de janelas abre numa folha própria, então o arrasto dele nunca briga com a troca de página).
A grade das páginas de apps/atalhos é calculada pelo tamanho real da tela e funciona deitado ou em pé.
Um módulo novo escolhe a aba com `Deck.addPage({ section: 'pc', ... })`.

| Página | O que faz |
|---|---|
| **Aplicativos** | Apps fixados na barra de tarefas. Ponto verde = tem janela aberta (tocar traz para a frente); ponto cinza = processo rodando. |
| **Atalhos** | Atalhos de teclado (configuráveis) + faixa de volume (mudo, slider, mídia global) à esquerda, e à direita a **lista de janelas abertas**: toque na linha para trazer a janela para a frente; os dois botões da linha minimizam e maximizam/restauram. O botão **Mapa** abre a folha de Janelas e telas. |
| **Janelas e telas** (folha aberta pelo botão Mapa) | Um **mapa em escala das suas telas** com cada janela desenhada onde ela está. **Arraste** uma janela para movê-la, inclusive de uma tela para a outra; arraste até a borda esquerda/direita de uma tela para **encaixar** (metade da tela) ou até o topo para **maximizar**. Toque numa janela para selecioná-la (e trazê-la para a frente); toque no vazio para desmarcar. **No topo** fica a lista de todas as janelas (inclusive minimizadas e escondidas) e **à direita**, em botões grandes com texto, as ações da selecionada: minimizar, maximizar/restaurar, esquerda, direita, outra tela e fechar (dois toques). Sem seleção, esse espaço mostra os controles das telas: desligar telas e projeção (estender/duplicar; "só tela 1/2" exigem segurar). O **brilho** de cada monitor (DDC/CI) fica logo abaixo dele no mapa. |
| **Som · mídia** (à esquerda) | O que está tocando (Spotify, YouTube ou qualquer coisa no navegador, VLC…): capa, título, artista, barra de tempo com busca, anterior/play/próxima. Vários players viram abas. |
| **Som · áudio** (à direita) | Saída e entrada padrão (trocar dispositivo, volume, mudo — inclusive o microfone) e mixer de volume por aplicativo. |
| **Desempenho** | CPU (total e por núcleo, clock, temperatura e potência), memória, GPU, disco e rede, ao vivo. Com um jogo desenhando quadros, o cartão da GPU mostra o FPS e o tempo de quadro (lido do RTSS, que acompanha o MSI Afterburner). |
| **Sobre este PC** (menu ⋯) | Hardware e Windows: processador, memória (módulos), vídeo, placa-mãe/BIOS, armazenamento, rede, monitores, uptime. |
| **Processos** | Maiores usos de CPU e de memória. |
| **Energia** | Bloquear, suspender, hibernar, sair da conta, reiniciar, desligar, reiniciar para a BIOS e para o menu avançado, com atraso, contagem regressiva e cancelamento. |

### Energia: como funciona a segurança

Tudo que encerra a sessão abre uma janela que explica o efeito, lista as janelas abertas (podem ter
trabalho não salvo) e **só confirma se você segurar o botão por ~1,2 s**. Reiniciar/desligar/BIOS/avançado
podem ser agendados (10 s a 2 h); o agendamento aparece como contagem no cabeçalho em qualquer página e
dá para cancelar. Com atraso, o Windows força o fechamento dos apps (regra do `shutdown /t`); a janela
mostra isso. Para remover essas ações da API: `"powerControls": false` no `config.json`.

### Fontes de dados opcionais

- **CPU temperatura/potência/clock real:** o Windows não expõe sensores do Ryzen. O painel lê do
  **MSI Afterburner** (memória compartilhada) quando ele está aberto; sem ele, esses campos ficam em "–".
- **GPU:** vem do `nvidia-smi` (placas NVIDIA). Sem ele, o cartão da GPU fica vazio.

### Cabeçalho

Discreto de propósito: o ícone do PC com uma luz de status (o texto só aparece se algo estiver errado), as abas, e à direita **microfone** (alterna o mudo do microfone padrão; fica vermelho e riscado quando mutado), **play/pause** do que estiver tocando (toque = play/pause, segurar = abrir o Som; some quando nada toca; ao mudar de faixa aparece um aviso rápido com o título) e o menu **⋯** (nome do PC, Sobre este PC, Atualizar e, no app, Endereço do PC). Durante um desligamento agendado aparece a contagem regressiva.

## Rodando o servidor

```powershell
cd server
npm run phone      # servidor + abre o painel no celular via USB
npm start          # só o servidor
```

Na primeira execução é gerado um token em `server/data/config.json` e impresso o endereço de pareamento.

### Iniciar com o Windows

```powershell
npm run autostart:install     # registra uma tarefa agendada (pede UAC uma vez)
npm run autostart:status
npm run autostart:uninstall
```

A tarefa roda no logon, **sem janela**, como administrador (necessário para os atalhos chegarem a janelas
elevadas) e escreve em `server/data/server.log` (rotaciona em 2 MB). Pare o servidor manual antes: só uma
instância pode usar a porta.

A tarefa inicia um **supervisor** (`src/supervisor.js`) que sobe o servidor e o reinicia sozinho se ele cair ou for encerrado
(espera 2 s, aumentando até 30 s se falhar logo ao iniciar). O motivo de cada parada fica no `server.log`
(`[server] stopping (SIGTERM)`, `[server] uncaught exception…`, `[supervisor] server exited (code …)`). Para reiniciar de propósito,
encerre o processo do servidor (o supervisor o sobe de novo) ou pare a tarefa e inicie-a outra vez.

### Abrir no celular via USB

Com a depuração USB ativa, `npm run phone` fica vigiando o `adb` (usa `.tools/platform-tools/adb.exe` se
existir, senão o do PATH). Ao plugar o celular ele faz `adb reverse` e abre o **app** (se instalado, já
pareado por intent) ou o navegador. Em `127.0.0.1` o navegador trata a página como contexto seguro, então
ela mantém a tela ligada sozinha.

### Segurança

- **Por padrão só escuta em `127.0.0.1`** (PC e USB). Para Wi-Fi: `"lan": true` — e aí qualquer aparelho
  da rede que tiver o token controla o PC. HTTP puro: use só em rede de confiança.
- Toda requisição exige o token (cookie, header `x-token` ou `?token=`); 10 falhas bloqueiam o IP por 1 min.
- Cabeçalho `Host` é validado (contra DNS rebinding) e `POST` de outra origem é recusado.
- O cliente só dispara o que está nas listas do servidor, por id: apps da barra de tarefas, atalhos do
  `config.json`, dispositivos de áudio existentes. Nunca caminhos ou teclas arbitrárias.

## Configuração (`server/data/config.json`)

| Campo | Descrição |
|---|---|
| `port` | Porta (padrão `7878`; `SSD_PORT` sobrescreve só naquela execução). |
| `lan` | `true` para aceitar conexões pela rede local (padrão `false`). |
| `hidden` | Ids de apps a esconder (veja `GET /api/apps`). |
| `editor` | `false` desliga o editor de botões do app (atalhos, macros e apps só mudam aqui no arquivo). Padrão: `true`. |
| `macros` | Macros criadas no editor: `{ id, label, page, steps }` (veja "Editor de botões e macros"). |
| `tileOrder` | Posição dos botões nas telas Apps e Atalhos (`{ apps: [...], shortcuts: [...] }`, chaves `a:<app>`, `s:<atalho>`, `m:<macro>`, `c:camera`). Salvo ao arrastar; não precisa editar à mão. |
| `shortcuts` | Atalhos: `{ "id", "label", "keys" }`, com `keys` como `ctrl+shift+esc`. |
| `powerControls` | `false` remove as ações de energia da API. |
| `miniPlayer` | `false` desliga o botão play/pause do cabeçalho (e dispensa manter o helper de mídia ligado, ~90 MB). |
| `autoOpenPhone` | `true` para sempre abrir no celular via USB ao iniciar. |
| `token` | Token de pareamento. Apague e reinicie para gerar outro. |

Atalhos: teclas em `server/src/keys.js` (`ctrl`, `shift`, `alt`, `win`, letras, números, `f1`–`f24`, setas,
`esc`, `tab`, `enter`, `space`, `printscreen`, teclas de mídia…). Atalhos inválidos são ignorados com aviso.

## Verificação

`npm run check` carrega todos os scripts da interface (na mesma ordem do `index.html`) contra um DOM de mentira e falha se algum quebrar ao iniciar ou se uma página não for registrada. Pega erros que `node --check` (só sintaxe) não vê.

## Como funciona por dentro

PowerShell leva ~1–7 s para iniciar e compilar código nativo, então cada tipo de trabalho tem um **helper
de longa duração** (`server/scripts/*.ps1`, falando JSON por linha) que um erro ou lentidão em um não
atrapalha os outros:

| Helper | Faz |
|---|---|
| `input-host.ps1` | Teclas (`keybd_event`), janelas (listar, focar, minimizar, mover, fechar), monitores (brilho DDC/CI, desligar), áudio por Core Audio (dispositivos, `IPolicyConfig`, mixer por app). |
| `media-host.ps1` | Mídia via *System Media Transport Controls* (a mesma fonte do controle de mídia do Windows). |
| `monitor-host.ps1` | Contadores de desempenho, `nvidia-smi`, MSI Afterburner, CIM/WMI. |

## API

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/ping` · `/api/state` | Conexão; apps rodando/abertos e agendamento de energia |
| GET | `/api/apps` · `/api/icon/:id` | Lista e ícones (URL versionada por hash) |
| POST | `/api/launch/:id` · `/api/refresh` | Abre ou traz para a frente; relê a barra de tarefas |
| GET/POST | `/api/shortcuts` · `/api/shortcut/:id` | Lista e dispara atalhos |
| GET/POST | `/api/macros` · `/api/macro/:id` | Lista e executa macros (devolve o resultado de cada passo) |
| GET/POST | `/api/layout` | Posição dos botões: `{apps, shortcuts}`; POST `{page, order}` |
| GET/POST | `/api/editor` · `/api/editor/shortcuts` · `/macros` · `/apps` | Editor de botões: lê tudo; salva atalhos, macros, apps ocultos/ordem (validado no servidor) |
| GET/POST | `/api/volume` | `{level, muted}`; POST `{level}` e/ou `{muted: bool｜"toggle"}` |
| POST | `/api/mediakey/:key` | `prev`, `playpause`, `next` (teclas globais) |
| GET | `/api/audio` | Saídas, entradas e sessões por app |
| POST | `/api/audio/default` · `/device` · `/session` | Trocar padrão; volume/mudo de dispositivo; volume/mudo de app |
| GET | `/api/media` · `/api/media/art` | Sessões de mídia; capa (por `session` e `key`) |
| POST | `/api/media/control` | `{session, action: toggle｜play｜pause｜next｜previous｜seek, position?}` |
| GET | `/api/monitor/sample` · `/processes` · `/info` | Medições ao vivo; top processos; hardware (em cache) |
| GET/POST | `/api/power` | Estado; ação `{action, confirm: true, delaySec?, force?}` ou `{action: "cancel"}` |
| GET | `/api/windows` | Janelas abertas: `{handle, title, app, state, monitor, x, y, w, h}` (pixels reais) |
| POST | `/api/windows/place` · `/snap` | `{handle, x, y}`; `{handle, monitor, zone: left｜right｜full}` |
| POST | `/api/windows/action` · `/move` | `{handle, action: focus｜minimize｜maximize｜restore｜close}`; `{handle, monitor}` (só em janelas da lista atual) |
| GET | `/api/screens` | Monitores e brilho (DDC/CI); `?brightness=0` pula a leitura lenta do brilho |
| POST | `/api/mic` | `{muted: true｜false｜"toggle"}` no microfone padrão |
| POST | `/api/camera/frame` | Um quadro JPEG do celular (corpo binário) |
| GET | `/api/camera/stream` · `/status` | Stream MJPEG; estado (ao vivo, fps, KB/s, quem assiste) e o link para o OBS |
| POST | `/api/camera/copy-link` | Copia o link do OBS para a área de transferência do PC |
| POST | `/api/screens/brightness` · `/off` · `/project` | `{device, level}`; desligar telas; `{mode: extend｜clone｜first｜second}` (`first`/`second` com `confirm: true`) |

## Reorganizar os botões e editor de macros

**Mudar a posição:** nas telas **Apps** e **Atalhos**, segure um botão por meio segundo (ele levanta e o celular vibra), arraste e solte **sobre outro botão: os dois trocam de lugar**
(o botão de destino fica destacado enquanto você arrasta). Soltar em um espaço vazio manda o botão para o fim; soltar em qualquer outro lugar não muda nada. A ordem é salva ao soltar.
Segurar sem mover não faz nada, e o toque que termina o arraste não abre o app. Vale para apps, atalhos, macros e a tecla da câmera.

Menu **⋯ → Editar botões** (ou `config.json`). Três abas:

- **Atalhos:** criar, renomear e excluir atalhos de teclado (modificadores Ctrl/Shift/Alt/Win + uma tecla). **Testar** salva e aperta uma vez.
- **Macros:** uma macro é uma lista de passos executados em ordem com um toque (a tecla mostra "n passos"; fica marcada enquanto roda). Passos disponíveis:
  abrir/focar um app, posicionar a janela de um app (metade esquerda/direita ou tela cheia em uma tela), pressionar teclas, tecla de mídia, definir o volume,
  mudo do som, mudo do microfone, trocar a saída/entrada de áudio padrão, esperar (0,5 a 10 s) e ligar/desligar a câmera do celular.
  Cada macro escolhe em qual tela aparece (Atalhos ou Apps). Se um passo falha (app fechado, dispositivo ausente), os outros continuam e o aviso diz quantos falharam.
- **Apps:** ocultar/mostrar os apps da barra de tarefas.

**Segurança:** o servidor só aceita passos de uma lista fixa e confere tudo ao salvar: apps por id da barra de tarefas, dispositivos por id da lista atual, teclas pelos nomes conhecidos.
Não existe passo de linha de comando, caminho de arquivo, texto digitado ou energia (desligar/reiniciar). Mesmo assim, quem tem o token passa a poder montar atalhos de teclado
pelo celular; se não quiser isso, ponha `"editor": false` no `config.json`.

## Câmera do celular (webcam do PC)

O celular vira a webcam do PC. O jeito mais rápido é a tecla **Câmera** na tela de Apps: um toque liga ou desliga a transmissão (fica
vermelha enquanto transmite). As opções abrem pelo ícone vermelho do cabeçalho ou pelo menu **⋯ → Câmera do celular → Transmitir ao PC**. O app pede a permissão da câmera na primeira vez
("Durante o uso do app"). O deck manda os quadros em JPEG para o servidor (`POST /api/camera/frame`) e o servidor os republica como
um stream MJPEG (`GET /api/camera/stream`). Enquanto transmite, um ícone vermelho de câmera aparece no cabeçalho para voltar à tela.

Há duas saídas para os apps do PC enxergarem a imagem como câmera, e as duas funcionam ao mesmo tempo:

- **Câmera virtual direta (sem OBS):** na tela da câmera, segure **Segure p/ instalar** (uma vez). Instala o filtro de código aberto
  [UnityCapture](https://github.com/schellingb/UnityCapture) (DLL de 157 KB, baixada de um commit fixo, conferida por SHA-256 e registrada com
  `regsvr32`; precisa de administrador, que o servidor já tem pela tarefa de autostart). Depois aparece uma câmera chamada **Stream Deck Camera**
  no Discord, Zoom, navegador etc., ao lado das webcams reais. **Segure p/ remover** desfaz. Quadros só são enviados ao driver enquanto algum app
  está usando a câmera.
- **Via OBS:** na tela da câmera toque em **Copiar link**, no OBS adicione uma fonte **Captura de navegador** e cole o link (Ctrl+V), depois clique
  em **Iniciar câmera virtual** e escolha **OBS Virtual Camera** no app.

Sem sinal do celular, o stream mostra uma imagem "Sem sinal". Controles: **Virar câmera** (frontal/traseira) e qualidade **480p/720p**.
O celular precisa ficar com o app aberto e a tela ligada enquanto transmite; nada é gravado nem guardado, só o último quadro fica em memória.

## Compilando o APK

O toolchain (JDK 17, Gradle 8.7, Android SDK 34, adb) fica em `.tools/`, fora do git:

```powershell
$t = "D:\Workspace\self-stream-deck\.tools"
$env:JAVA_HOME = "$t\jdk17"; $env:ANDROID_SDK_ROOT = "$t\android-sdk"
cd android
& "$t\gradle-8.7\bin\gradle.bat" assembleDebug
& "$t\platform-tools\adb.exe" install -r app\build\outputs\apk\debug\app-debug.apk
```

Com o app instalado, `npm run phone` abre o app (já pareado, via intent `--es url`) em vez do navegador.
O app expõe duas funções à página: `Android.openSettings()` e `Android.vibrate(ms)`, e libera a câmera do celular só para a página do PC pareado (permissão CAMERA).
