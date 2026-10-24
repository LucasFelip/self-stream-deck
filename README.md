# self-stream-deck

Transforma um celular Android (feito para o Galaxy A31) em um painel de controle do PC com Windows:
abrir/focar aplicativos, atalhos de teclado, volume e áudio avançado, mídia tocando agora, monitor do
sistema e controles de energia.

```
┌──────────────┐   HTTP (USB/adb reverse) ou HTTPS (Wi-Fi opcional)   ┌──────────────────────────┐
│ App Android  │ ───────────────────────────────────────────▶ │ server/ (Node, no PC)    │
│ (WebView)    │ ◀── interface web, ícones, dados ─────────── │  • helpers nativos        │
└──────────────┘                                               └──────────────────────────┘
```

- `server/` — servidor no PC. Node 20+, **sem dependências** (não precisa de `npm install`).
  Serve também a interface web (`server/public/`), então a lógica do painel fica toda no PC.
- `android/` — app Android fino (Java, sem libs): guarda o endereço do PC, mantém a tela ligada,
  vibra ao toque e mostra a página. Mudar a interface **não exige recompilar o APK**.

## Páginas

Não há rolagem na tela principal: o painel é dividido em **páginas**, agrupadas em **6 abas** fixas no
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

O log mostra o essencial; `SSD_LOG=debug` (variável de ambiente) mostra também os erros que o servidor ignora de propósito, útil para investigar algo estranho.

A tarefa inicia um **supervisor** (`src/supervisor.js`) que sobe o servidor e o reinicia sozinho se ele cair ou for encerrado
(espera 2 s, aumentando até 30 s se falhar logo ao iniciar). O motivo de cada parada fica no `server.log`
(`[server] stopping (SIGTERM)`, `[server] uncaught exception…`, `[supervisor] server exited (code …)`). Para reiniciar de propósito,
encerre o processo do servidor (o supervisor o sobe de novo) ou pare a tarefa e inicie-a outra vez.

### Abrir no celular via USB

Com a depuração USB ativa, `npm run phone` fica vigiando o `adb` (usa `.tools/platform-tools/adb.exe` se
existir, senão o do PATH). Ao plugar o celular ele faz `adb reverse` e abre o **app** (se instalado, já
pareado por intent) ou o navegador. Em `127.0.0.1` o navegador trata a página como contexto seguro, então
ela mantém a tela ligada sozinha.

### Conectar pelo Wi-Fi (rede da casa)

Além do USB, o celular pode falar com o PC pela rede local, sem cabo e sem serviços de terceiros:

```powershell
cd server
npm run lan -- on        # liga (config.json: "lan": true); depois reinicie o servidor (encerre o processo: o supervisor o sobe)
npm run lan -- status    # mostra a regra de firewall, a impressão digital do certificado e o link de pareamento
```

- **HTTPS na porta 7879** (`httpsPort`), só quando `lan` está ligado. O servidor HTTP da porta 7878 continua **só em 127.0.0.1**.
- **Certificado próprio** (RSA 2048, 5 anos), criado na primeira vez em `server/data/tls/`. O app **fixa a impressão digital (SHA-256)** do
  certificado: só aceita exatamente aquele, então ninguém na rede consegue se passar pelo servidor, e a câmera do celular funciona (precisa de HTTPS).
  O certificado não contém IPs, então trocar o IP do PC não exige gerar outro.
- **Firewall:** o servidor cria a regra "Self Stream Deck (rede local)": só TCP 7879, só da **sub-rede local** (não da internet), em qualquer perfil
  (a rede da casa costuma estar como "Pública"). Precisa de administrador, que a tarefa de autostart já tem.
- **Parear sem digitar nada:** plugue o celular **uma vez** com `npm run phone` rodando (ou com o autostart): o app recebe o endereço USB e o do Wi-Fi.
  Depois funciona sem cabo. Sem cabo, dá para colar o link `https://IP:7879/?token=…&fp=…` na tela "Conectar ao PC" do app.
- **Qual endereço o app usa:** tenta primeiro o USB (`127.0.0.1`, que falha na hora sem cabo) e depois o Wi-Fi. Se o PC some por uns 12 s, a página pede
  ao app para trocar de caminho (USB ↔ Wi-Fi).
- **IP do PC:** reserve o IP no roteador (DHCP fixo) para o endereço não mudar; se mudar, plugue o celular de novo (ou cole o novo link).
- `npm run lan -- off` desliga e remove a regra de firewall.

### Segurança

- **Por padrão só escuta em `127.0.0.1`** (PC e USB). O Wi-Fi é opcional (`npm run lan -- on`) e usa **HTTPS** com certificado fixado pelo app,
  numa porta separada e com firewall só para a sub-rede local; quem estiver na rede ainda precisa do token para controlar o PC.
- Toda requisição exige o token (cookie, header `x-token` ou `?token=`); 10 falhas bloqueiam o IP por 1 min.
- Cabeçalho `Host` é validado (contra DNS rebinding) e `POST` de outra origem é recusado.
- O cliente só dispara o que está nas listas do servidor, por id: apps da barra de tarefas, atalhos do
  `config.json`, dispositivos de áudio existentes. Nunca caminhos ou teclas arbitrárias.

## Configuração (`server/data/config.json`)

| Campo | Descrição |
|---|---|
| `port` | Porta (padrão `7878`; `SSD_PORT` sobrescreve só naquela execução). |
| `lan` | `true` liga o acesso pelo Wi-Fi (HTTPS na `httpsPort`, padrão 7879). Use `npm run lan -- on/off/status`. Padrão `false`. |
| `httpsPort` | Porta do HTTPS da rede local (padrão `7879`). |
| `hidden` | Ids de apps a esconder (veja `GET /api/apps`). |
| `editor` | `false` desliga o editor de botões do app (atalhos, macros e apps só mudam aqui no arquivo). Padrão: `true`. |
| `macros` | Macros criadas no editor: `{ id, label, page, steps }` (veja "Editor de botões e macros"). |
| `tileOrder` | Posição dos botões nas telas Apps e Atalhos (`{ apps: [...], shortcuts: [...] }`, chaves `a:<app>`, `s:<atalho>`, `m:<macro>`, `c:camera`). Salvo ao arrastar; não precisa editar à mão. |
| `shortcuts` | Atalhos: `{ "id", "label", "keys" }`, com `keys` como `ctrl+shift+esc`. |
| `powerControls` | `false` remove as ações de energia da API. |
| `miniPlayer` | `false` desliga o botão play/pause do cabeçalho (e dispensa manter o helper de mídia ligado, ~90 MB). |
| `autoOpenPhone` | `true` para sempre abrir no celular via USB ao iniciar. |
| `token` | Token de pareamento. Apague e reinicie para gerar outro. |

Ao iniciar, o servidor confere o arquivo e avisa no log de valores errados (tipo errado, id repetido, texto com caracteres danificados), sem parar.
O editor do app recusa salvar algo assim. **Cada gravação guarda a versão anterior em `config.json.bak`**, e se o `config.json` ficar ilegível o servidor não sobe nem o sobrescreve
(isso trocaria o token): conserte-o ou copie o `.bak` por cima.

Atalhos: teclas em `server/src/keys.js` (`ctrl`, `shift`, `alt`, `win`, letras, números, `f1`–`f24`, setas,
`esc`, `tab`, `enter`, `space`, `printscreen`, teclas de mídia…). Atalhos inválidos são ignorados com aviso.

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
$t = "E:\Workspace\self-stream-deck\.tools"
$env:JAVA_HOME = "$t\jdk17"; $env:ANDROID_SDK_ROOT = "$t\android-sdk"
cd android
& "$t\gradle-8.7\bin\gradle.bat" assembleDebug
& "$t\platform-tools\adb.exe" install -r app\build\outputs\apk\debug\app-debug.apk
```

Com o app instalado, `npm run phone` abre o app (já pareado, via intent `--es url`) em vez do navegador.
O app expõe duas funções à página: `Android.openSettings()` e `Android.vibrate(ms)`, e libera a câmera do celular só para a página do PC pareado (permissão CAMERA).

## Para quem vai mexer no código

- [docs/ARQUITETURA.md](docs/ARQUITETURA.md): como o servidor, os helpers nativos, a atualização por push e a interface se encaixam; consumo medido; testes; variáveis de ambiente; a API completa.
- [CONTRIBUTING.md](CONTRIBUTING.md): como rodar os testes e o lint, e como adicionar uma rota, uma página ou uma operação de helper.

`npm run check` roda tudo (lint, testes de lógica, da interface e dos helpers nativos).
