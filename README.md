# self-stream-deck

> O agente do PC é um programa em Rust (`agent/`), a interface é React + TypeScript (`web/`), o app é Android (`android/`). O contrato da API fica em `contracts/`, os verificadores em `tools/` e as decisões em `docs/adr/`. O plano e o estado das fases estão em [docs/plano-reestruturacao.md](docs/plano-reestruturacao.md). O comando único de verificação é `node tools/check.js`.

Transforma um celular Android (feito para o Galaxy A31) em um painel de controle do PC com Windows:
abrir/focar aplicativos, atalhos de teclado, volume e áudio avançado, mídia tocando agora, monitor do
sistema e controles de energia.

```
┌──────────────┐   HTTP (USB/adb reverse) ou HTTPS (Wi-Fi opcional)   ┌──────────────────────────┐
│ App Android  │ ───────────────────────────────────────────▶ │ ssd.exe (Rust, no PC)    │
│ (WebView)    │ ◀── interface web, ícones, dados ─────────── │  • Windows por API direta │
└──────────────┘                                               └──────────────────────────┘
```

- `agent/` — o agente no PC (`ssd.exe`, Rust). Um só processo (~60 MB), **sem Node e sem instalar nada além dele** (só os scripts de certificado e do firewall usam o PowerShell que já vem no Windows).
  A interface web (o build de `web/`) vai **dentro** do `.exe`, então a lógica do painel fica toda no PC.
- `web/` — a interface (React + TypeScript, PWA).
- `android/` — app Android fino (Kotlin, sem bibliotecas além do Android): guarda o endereço do PC, mantém a tela ligada,
  vibra ao toque, mostra a página e um **relógio** pequeno na lateral (hora `00:00`–`23:59` e data `dia/mês`, em 24 h qualquer que seja o idioma do celular; some junto com o escurecimento). Ao abrir, o app **testa os endereços** (USB e Wi-Fi) antes de mostrar o painel, com uma tela "Conectando ao PC…" no visual do painel; o Wi-Fi é conferido pelo certificado pareado. Com o painel já aberto, a barra vermelha "PC desconectado" tem **Tentar agora** e, dentro do app, **Bloquear tela**. Se nenhum endereço responde ao abrir, aparece a tela **"Sem conexão com o PC"** (sem a página de erro do navegador), que **tenta de novo sozinha a cada 5 s** e abre o painel assim que o PC volta, com os botões **Tentar agora**, **Configurar endereço** e **Bloquear tela**; este último bloqueia o celular e, na primeira vez, pede para ativar o app como administrador do aparelho (só a permissão de bloquear a tela, que dá para desativar em Configurações → Segurança → Apps administradores do dispositivo, e precisa estar desativada antes de desinstalar o app). Mudar a interface **não exige recompilar o APK**.

## Páginas

Não há rolagem na tela principal: o painel é dividido em **páginas**, agrupadas em **6 abas** fixas no
topo para não ser preciso ficar deslizando até achar a certa:

| Aba | Páginas |
|---|---|
| **Apps** | Aplicativos |
| **Atalhos** | Atalhos de teclado (a grade inteira) |
| **Som** | Mídia e áudio numa tela só |
| **Desempenho** | Desempenho ("Sobre este PC" é o painel Sistema da aba PC) |
| **Energia** | Energia |
| **Processos** | Processos |

Tocar numa aba vai direto para ela (na última página que você tinha aberto ali); tocar na aba **ativa**
avança para a próxima página do grupo; os pontinhos sob a aba ativa mostram onde você está, e o nome da
aba vira o da página atual. Arrastar percorre todas as páginas em ordem: para os lados em retrato e para cima/baixo em paisagem (onde as abas ficam num trilho vertical) (o mapa de janelas abre numa folha própria, então o arrasto dele nunca briga com a troca de página).
Apps fica numa página só, com todos os apps de uma vez (as teclas encolhem para caber; só com muitíssimos apps ela rola na vertical); a grade de apps/atalhos é calculada pelo tamanho real da tela e funciona deitado ou em pé.
Um módulo novo escolhe a aba com `Deck.addPage({ section: 'pc', ... })`.

| Página | O que faz |
|---|---|
| **Aplicativos** | Apps fixados na barra de tarefas. Ponto verde = tem janela aberta (tocar traz para a frente); ponto cinza = processo rodando. |
| **Atalhos** | Atalhos de teclado (configuráveis) na grade inteira. O volume e o mudo ficam na aba Som. |
| **Janelas e telas** (folha aberta pelo botão Mapa) | Um **mapa em escala das suas telas** com cada janela desenhada onde ela está. **Arraste** uma janela para movê-la, inclusive de uma tela para a outra; arraste até a borda esquerda/direita de uma tela para **encaixar** (metade da tela) ou até o topo para **maximizar**. Toque numa janela para selecioná-la (e trazê-la para a frente); toque no vazio para desmarcar. **No topo** fica a lista de todas as janelas (inclusive minimizadas e escondidas) e **à direita**, em botões grandes com texto, as ações da selecionada: minimizar, maximizar/restaurar, esquerda, direita, outra tela e fechar (dois toques). Sem seleção, esse espaço mostra os controles das telas: desligar telas e projeção (estender/duplicar; "só tela 1/2" exigem segurar). O **brilho** de cada monitor (DDC/CI) fica logo abaixo dele no mapa. |
| **Som · mídia** (faixa no topo) | O que está tocando (Spotify, YouTube ou qualquer coisa no navegador, VLC…): capa, título, artista, barra de tempo com busca, anterior/play/próxima. Vários players viram abas. |
| **Som · áudio** (Saída, Entrada e Aplicativos, abaixo) | Saída e entrada padrão (trocar dispositivo, volume, mudo — inclusive o microfone) e mixer de volume por aplicativo. |
| **Desempenho** | CPU (total e por núcleo, clock, temperatura e potência), memória, GPU, disco e rede, ao vivo, em cartões compactos de tamanho parecido. Com um jogo desenhando quadros, o cartão da GPU mostra o FPS e o tempo de quadro (lido do RTSS, que acompanha o MSI Afterburner). |
| **Sobre este PC** (aba PC, painel Sistema) | Hardware e Windows: processador, memória (módulos), vídeo, placa-mãe/BIOS, armazenamento, rede, monitores, uptime, em cartões temáticos que cabem na tela sem rolar em paisagem. |
| **Processos** | Maiores usos de CPU e de memória. |
| **Energia** | Teclas (4x2 deitado, 2x4 em pé): bloquear, suspender, hibernar, sair da conta, reiniciar, desligar, reiniciar para a BIOS e para o menu avançado, com atraso, contagem regressiva e cancelamento. |

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

Discreto de propósito: as abas e o menu **⚙** Configurações (nome do PC, Editar botões, Câmera do celular, Escurecer após… (apaga a tela depois de 1, 2 ou 5 min sem toque; o primeiro toque só acorda), Endereço do PC no app e Atualizar; em retrato abre como folha inferior). Durante um desligamento agendado aparece a contagem regressiva.

## Instalando e rodando o agente

**Instalar com o MSI:** `powershell -File agent/scripts/msi/build-msi.ps1` gera `dist/SelfStreamDeck-<versão>.msi` (precisa do WiX, veja o CONTRIBUTING); dê dois cliques ou rode `msiexec /i SelfStreamDeck-0.1.0.msi [MIGRATEFROM="pasta\de\dados\antiga"]`. Ele faz o mesmo que o `install.ps1` abaixo e desinstala pelo "Aplicativos instalados" do Windows.

**Instalar (zip com script):** gere o pacote com `powershell -File agent/scripts/package.ps1` (cria `dist/SelfStreamDeck-<versão>.zip`), descompacte e rode:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 [-From "pasta\de\dados\antiga"]
```

Pede UAC uma vez e: copia o `ssd.exe` para `Program Files\Self Stream Deck`, traz o token e os certificados de uma instalação anterior (`-From`: o celular continua pareado),
registra a tarefa "Self Stream Deck" (no logon, **sem janela**, como administrador, reinicia sozinha até 3 vezes se cair) e cria o atalho no Menu Iniciar.
`uninstall.ps1` desfaz (os dados em `%APPDATA%\SelfStreamDeck` ficam, a menos de `-RemoveData`).

- **Dados:** `%APPDATA%\SelfStreamDeck\` (`config.json` com o token, `tls/`, `icons/`, `vcam/`, `server.log`, que gira em 2 MB). Fora do git.
- **Ícone na bandeja:** abrir painel, mostrar o código de pareamento, abrir o registro, sair.
- **Algo errado?** `ssd.exe diagnose` (ou `diagnose --out arquivo.txt`) junta versão, config (token mascarado), portas, certificados, tarefa, firewall, o que cada parte do PC responde e o fim do log.
- `SSD_LOG=debug` (variável de ambiente) mostra também os erros que o agente ignora de propósito.
- **Assinatura:** `agent/scripts/sign.ps1` assina o `.exe` (certificado próprio, ou um `.pfx` com `-Pfx`); `package.ps1 -Sign` faz isso ao empacotar.

**Rodar direto do código** (desenvolvimento):

```powershell
cd agent; cargo build --release
.\target\release\ssd.exe --data-dir .\dados-teste --port 7878    # --web-dir ..\web\dist serve a interface de uma pasta
```

`--fake-platform` troca o PC por um PC de mentira (é o que os testes usam); `--no-tray` não cria o ícone.

### Atualizações

O agente só procura versões novas se você apontar um manifesto em `update.url` do `config.json`; **não há servidor padrão**. O manifesto é um JSON pequeno, que `agent/scripts/make-manifest.ps1` gera a partir de um MSI assinado:

```json
{ "channels": { "stable": { "version": "0.2.0", "url": "https://exemplo.com/SelfStreamDeck-0.2.0.msi", "sha256": "…64 dígitos…" },
                "test":   { "version": "0.3.0-rc1", "url": "https://…", "sha256": "…" } } }
```

- `ssd.exe update` mostra se há versão nova no canal (`update.channel`, padrão `stable`; `--channel test` troca); `ssd.exe update --apply` baixa, confere e instala (o instalador para o agente e sobe o novo em segundos); `--no-install` só baixa e confere.
- `"update": { "auto": true }` faz isso sozinho: uma verificação um minuto depois de o agente subir e uma por dia. O resultado aparece no `server.log`.
- **Antes de instalar qualquer coisa:** manifesto e pacote vêm por **HTTPS** (HTTP só para este PC, em testes); a versão é mais nova; o pacote tem o **SHA-256** do manifesto; e o pacote está **assinado pelo mesmo certificado do agente em execução** (ou pela impressão digital em `update.signer`). Um manifesto num servidor invadido não faz o agente instalar nada que você não assinou, e um agente sem assinatura e sem `update.signer` **recusa** atualizar.
- Para assinar: `build-msi.ps1 -Sign` (certificado próprio, ou um `.pfx` pelo `sign.ps1`). Num PC que recebe a atualização, o agente instalado precisa ter sido assinado pelo mesmo certificado, ou ponha a impressão digital em `update.signer`.

### Abrir no celular via USB

Com a depuração USB ativa, rode uma vez a cada vez que plugar: `adb reverse tcp:7878 tcp:7878` (o `adb` de `.tools/platform-tools/` serve) e abra o app.
Em `127.0.0.1` o navegador trata a página como contexto seguro, então ela mantém a tela ligada sozinha. (O vigia que fazia isso sozinho era do servidor Node e ainda não foi portado; pelo Wi-Fi não precisa de nada disso.)

### Conectar pelo Wi-Fi (rede da casa)

Além do USB, o celular pode falar com o PC pela rede local, sem cabo e sem serviços de terceiros. Edite o `config.json` e reinicie o agente (encerre o processo: a tarefa o sobe de novo):

- `"lan": true` liga o **HTTPS na porta 7879** (`httpsPort`). O HTTP da porta 7878 continua **só em 127.0.0.1**.
- **Certificado próprio** (RSA 2048, 5 anos), criado na primeira vez em `%APPDATA%\SelfStreamDeck\tls\`. O app **fixa a impressão digital (SHA-256)** do
  certificado: só aceita exatamente aquele, então ninguém na rede consegue se passar pelo servidor, e a câmera do celular funciona (precisa de HTTPS).
  O certificado não contém IPs, então trocar o IP do PC não exige gerar outro.
- **Firewall:** o agente cria a regra "Self Stream Deck (rede local)": só TCP 7879, só da **sub-rede local** (não da internet), em qualquer perfil
  (a rede da casa costuma estar como "Pública"). Precisa de administrador, que a tarefa já tem.
- **Parear:** o registro (`server.log`) e o menu da bandeja mostram o link `https://IP:7879/?token=…&fp=…`; cole-o na tela "Conectar ao PC" do app. Plugando o celular uma vez
  com o USB e `adb reverse`, o app recebe os dois endereços sozinho.
- **Qual endereço o app usa:** tenta primeiro o USB (`127.0.0.1`, que falha na hora sem cabo) e depois o Wi-Fi. Se o PC some por uns 12 s, a página pede
  ao app para trocar de caminho (USB ↔ Wi-Fi).
- **IP do PC:** reserve o IP no roteador (DHCP fixo) para o endereço não mudar; se mudar, cole o novo link.
- `"lan": false` desliga.

### Abrir no iPhone (Safari / app na Tela de Início)

O iPhone não tem o app Android (nem `adb reverse`): ele abre o painel no **Safari** pelo Wi-Fi e pode virar um app em tela cheia na Tela de Início.
Serve o iOS que roda o Safari com HTTPS (Wake Lock a partir do 16.4; o toque de háptico, a partir do 18). Ligue com `"ios": true` no `config.json` e reinicie o agente.

1. **Instale o certificado uma vez.** No Safari do iPhone abra `http://IP-DO-PC:7881/` (ou o `nome-do-pc.local`; os links também estão no registro), confira a impressão digital da página com a
   do registro, toque em *Baixar certificado*, depois *Ajustes → Perfil Baixado → Instalar* e *Ajustes → Geral → Sobre → Ajustes de Confiança do
   Certificado* → ativar. Esse certificado é só a **autoridade** (AC) do deck: ele não muda quando o IP do PC muda.
2. **Abra o painel:** `https://IP-DO-PC:7880/?token=…` (o link aparece no registro). Aceite o aviso de *Rede Local*. Depois, *Compartilhar → Adicionar à Tela de Início*.
3. **Se o app da Tela de Início pedir o código** (ele guarda cookies separados do Safari): no Safari abra ⚙ → *Código de pareamento* (copia o código), abra o
   app e cole na tela de pareamento (vale também colar o link inteiro).

Como funciona: o Safari confere os nomes dentro do certificado, ao contrário do app Android (que fixa a impressão digital). Por isso o iPhone tem **a sua
própria porta HTTPS** (`iosPort`, 7880) com um certificado de 1 ano que lista o nome do PC, `nome.local` e os IPs atuais, assinado por uma AC local criada na
primeira vez em `%APPDATA%\SelfStreamDeck\tls\ios\`. A porta HTTP `7881` (`iosCaPort`) só entrega o certificado público da AC, sem token; a chave privada nunca sai da pasta.
A regra de firewall "Self Stream Deck (iPhone)" libera só essas duas portas, só para a sub-rede local. **Limite atual:** o certificado do iPhone só é refeito quando falta; se o IP
do PC mudar, o nome `.local` continua valendo, mas o IP novo só entra no certificado se você apagar a pasta `tls\ios\` (menos `ca.*`) e reiniciar o agente.

Limites no iPhone: sem vibração do navegador (o háptico usa um truque do iOS 18); a tela só fica ligada com a Wake Lock; o escurecimento (⚙ → *Escurecer após…*) é um véu preto,
sem baixar o brilho. USB: não há equivalente ao `adb reverse`; use o Wi-Fi (ou o *Acesso Pessoal* por USB, com o Apple Devices/iTunes no Windows).

### Segurança

- **Por padrão só escuta em `127.0.0.1`** (PC e USB). O Wi-Fi é opcional (`"lan": true`) e usa **HTTPS** com certificado fixado pelo app,
  numa porta separada e com firewall só para a sub-rede local; quem estiver na rede ainda precisa do token para controlar o PC.
- Toda requisição exige o token (cookie, header `x-token` ou `?token=`); 10 falhas bloqueiam o IP por 1 min. Só o manifest, os ícones e o `pair.js` abrem sem token
  (nada privado), e quem abre `/` sem token no navegador vê a página de pareamento, não um erro. A porta HTTP do iPhone (7881) serve apenas o certificado público da AC.
- Cabeçalho `Host` é validado (contra DNS rebinding) e `POST` de outra origem é recusado.
- O cliente só dispara o que está nas listas do servidor, por id: apps da barra de tarefas, atalhos do
  `config.json`, dispositivos de áudio existentes. Nunca caminhos ou teclas arbitrárias.

## Configuração (`%APPDATA%\SelfStreamDeck\config.json`)

| Campo | Descrição |
|---|---|
| `port` | Porta (padrão `7878`; `SSD_PORT` sobrescreve só naquela execução). |
| `lan` | `true` liga o acesso pelo Wi-Fi (HTTPS na `httpsPort`, padrão 7879). Padrão `false`. |
| `httpsPort` | Porta do HTTPS da rede local (padrão `7879`). |
| `ios` | `true` liga o acesso do iPhone (HTTPS na `iosPort`, padrão 7880, e a porta HTTP `iosCaPort`, padrão 7881, que só entrega o certificado da AC). Padrão `false`. |
| `iosPort` / `iosCaPort` | Portas do iPhone (padrão `7880` e `7881`). |
| `hidden` | Ids de apps a esconder (veja `GET /api/apps`). |
| `editor` | `false` desliga o editor de botões do app (atalhos, macros e apps só mudam aqui no arquivo). Padrão: `true`. |
| `macros` | Macros criadas no editor: `{ id, label, page, steps }` (veja "Editor de botões e macros"). |
| `tileOrder` | Posição dos botões nas telas Apps e Atalhos (`{ apps: [...], shortcuts: [...] }`, chaves `a:<app>`, `s:<atalho>`, `m:<macro>`, `c:camera`). Salvo ao arrastar; não precisa editar à mão. |
| `shortcuts` | Atalhos: `{ "id", "label", "keys" }`, com `keys` como `ctrl+shift+esc`. |
| `powerControls` | `false` remove as ações de energia da API. |
| `notifications` | `{ "enabled": true, "apps": ["whatsapp"] }`: mostra no deck as notificações do Windows desses apps (palavras que casam com o nome ou o id do app), mesmo com Não Incomodar ou jogo ligado. WhatsApp Web no navegador chega como o app do navegador e o texto não cita o WhatsApp: use `["brave"]` (ou `"chrome"`, `"edge"`), o que mostra as notificações de qualquer site desse navegador. `enabled: false` desliga. |
| `miniPlayer` | `false` desliga o aviso de faixa nova . |
| `update` | Atualização (veja "Atualizações"): `{ "url": "https://…/manifest.json", "channel": "stable", "auto": false, "signer": "" }`. Sem `url` o agente não contata ninguém. |
| `token` | Token de pareamento. Apague e reinicie para gerar outro. |

Ao iniciar, o agente confere o arquivo e avisa no log de valores errados (tipo errado, id repetido, texto com caracteres danificados), sem parar.
O editor do app recusa salvar algo assim. **Cada gravação guarda a versão anterior em `config.json.bak`**, e se o `config.json` ficar ilegível o agente não sobe nem o sobrescreve
(isso trocaria o token): conserte-o ou copie o `.bak` por cima.

Atalhos: teclas em `agent/crates/core/src/keys.rs` (`ctrl`, `shift`, `alt`, `win`, letras, números, `f1`–`f24`, setas,
`esc`, `tab`, `enter`, `space`, `printscreen`, teclas de mídia…). Atalhos inválidos são ignorados com aviso.

## Reorganizar os botões e editor de macros

**Mudar a posição:** nas telas **Apps** e **Atalhos**, segure um botão por meio segundo (ele levanta e o celular vibra), arraste e solte **sobre outro botão: os dois trocam de lugar**
(o botão de destino fica destacado enquanto você arrasta). Soltar em um espaço vazio manda o botão para o fim; soltar em qualquer outro lugar não muda nada. A ordem é salva ao soltar.
Segurar sem mover não faz nada, e o toque que termina o arraste não abre o app. Vale para apps, atalhos, macros e a tecla da câmera.

Menu **⚙ → Editar botões** (ou `config.json`). Três abas:

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
vermelha enquanto transmite). As opções abrem pelo ícone vermelho do cabeçalho ou pelo menu **⚙ → Câmera do celular → Transmitir ao PC**. O app pede a permissão da câmera na primeira vez
("Durante o uso do app"). O deck manda os quadros em JPEG para o agente (`POST /api/camera/frame`) e o agente os republica como
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

O app expõe duas funções à página: `Android.openSettings()` e `Android.vibrate(ms)`, e libera a câmera do celular só para a página do PC pareado (permissão CAMERA).

## Para quem vai mexer no código

- [docs/ARQUITETURA.md](docs/ARQUITETURA.md): como o agente, a interface e o app se encaixam; consumo; testes; variáveis de ambiente; a API.
- [CONTRIBUTING.md](CONTRIBUTING.md): como rodar os testes e o lint, e como adicionar uma rota, uma página ou uma operação do Windows.

`node tools/check.js` (na raiz) roda tudo: formatação, lints e testes do Rust e da interface, e o agente contra o contrato da API (`--full` inclui a interface num navegador).
