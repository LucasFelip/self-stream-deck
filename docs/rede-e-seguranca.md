# Rede e segurança

## Como o celular chega ao PC

O agente escuta em `127.0.0.1:7878` (HTTP). Há dois caminhos até ele, e o app Android tenta os dois, nesta ordem:

1. **USB** (`http://127.0.0.1:7878`): o celular, com a depuração USB ativa, encaminha a porta para o PC. É o primeiro porque **falha na hora** quando não há cabo.
2. **Wi-Fi da casa** (`https://IP:7879`): HTTPS, opcional.

Ao abrir, o app **testa** os endereços e só entrega ao painel um que respondeu, então a página de erro do navegador nunca aparece. Se nenhum responde, mostra a tela "Sem conexão com o PC", que tenta de novo a cada 5 s e abre o painel assim que o PC volta. Se o PC some por uns 12 s com o painel aberto, a página pede ao app para trocar de caminho (USB ↔ Wi-Fi), se o outro responder.

## USB

Com a depuração USB ativa no celular (e o `adb`, das *platform-tools* do Android, no PC):

```powershell
adb reverse tcp:7878 tcp:7878
```

Rode uma vez a cada vez que plugar o cabo e abra o app. Em `127.0.0.1` o navegador trata a página como contexto seguro, então ela mantém a tela ligada sozinha. *(O vigia que fazia isso automaticamente era do servidor Node antigo e não foi portado.)*

## Wi-Fi (Android)

Edite o `config.json`, ligue o Wi-Fi e reinicie o agente:

```json
{ "lan": true }
```

- O agente passa a escutar HTTPS na porta 7879 e cria a regra de firewall "Self Stream Deck (rede local)": só TCP, só da **sub-rede local** (nunca da internet), em qualquer perfil (a rede da casa costuma estar como "Pública"). Isso exige administrador, que a tarefa já tem. O HTTP da 7878 continua só em `127.0.0.1`.
- O **certificado é próprio** (RSA 2048, 5 anos), criado na primeira vez em `%APPDATA%\SelfStreamDeck\tls\`, **sem IPs dentro**, então trocar o IP do PC não pede um novo.
- O app **fixa a impressão digital SHA-256** do certificado: só aceita exatamente aquele. Ninguém na rede consegue se passar pelo servidor, e o HTTPS permite a câmera do celular (que exige contexto seguro).
- **Parear:** o `server.log` e o ícone da bandeja mostram o link `https://IP:7879/?token=…&fp=…`. Cole-o na tela "Conectar ao PC" do app (ou ⚙ → *Endereço do PC…*). Se o celular está ligado por USB, o app recebe os dois endereços sozinho.
- **Reserve o IP do PC no roteador** (DHCP fixo) para o endereço não mudar; se mudar, cole o link novo.
- Para desligar: `"lan": false`.

## iPhone (Safari e tela de início)

O iPhone não tem o app Android nem o `adb reverse`: ele abre o painel no **Safari** pelo Wi-Fi e pode virar um app em tela cheia na Tela de Início. Precisa de iOS 16.4+ (a tela fica ligada pela *Wake Lock*; o toque de háptico só no iOS 18+). Ligue com `"ios": true` e reinicie o agente.

1. **Instale o certificado uma vez.** No Safari abra `http://IP-DO-PC:7881/` (ou `http://nome-do-pc.local:7881/`; os links estão no `server.log`), confira a impressão digital da página com a do registro, toque em *Baixar certificado*, depois *Ajustes → Perfil Baixado → Instalar* e *Ajustes → Geral → Sobre → Ajustes de Confiança do Certificado* → ativar. Esse certificado é só a **autoridade** (AC) do painel: não muda quando o IP do PC muda.
2. **Abra o painel:** `https://IP-DO-PC:7880/?token=…` (o link está no registro). Aceite o aviso de *Rede Local*. Depois, *Compartilhar → Adicionar à Tela de Início*.
3. **Se o app da Tela de Início pedir o código** (ele guarda cookies separados do Safari): no Safari abra ⚙ → *Código de pareamento* (copia o código), abra o app e cole na tela de pareamento (vale colar o link inteiro).

**Por que uma porta própria.** O Safari confere os nomes dentro do certificado, ao contrário do app Android (que fixa a impressão digital). Por isso o iPhone tem o **seu** HTTPS (7880) com um certificado de 1 ano que lista o nome do PC, `nome.local` e os IPs atuais, assinado por uma AC local criada na primeira vez em `tls\ios\`. A porta HTTP 7881 só entrega o certificado público da AC, sem token; **a chave privada nunca sai da pasta**.

**Limites no iPhone:** sem vibração do navegador (o háptico usa um truque do iOS 18); a tela só fica ligada com a Wake Lock; o escurecimento é um véu preto, sem baixar o brilho; por USB não há equivalente ao `adb reverse` (use o Wi-Fi, ou o *Acesso Pessoal* por USB com o Apple Devices/iTunes no Windows).

**Limite do certificado:** ele só é refeito quando falta, não quando o IP do PC muda. O nome `.local` continua valendo; para o IP novo entrar, apague a pasta `tls\ios\` (menos `ca.*`, a autoridade já instalada no iPhone) e reinicie o agente.

## O modelo de segurança

O alvo é uma máquina de uma pessoa, na rede da casa: o painel dá controle do PC a quem tiver o **token**.

| Camada | O que faz |
|---|---|
| Escuta | só em `127.0.0.1` por padrão; o Wi-Fi e o iPhone são opcionais, em portas próprias |
| Token | todo pedido o exige (cabeçalho `x-token`, `?token=` ou cookie `HttpOnly`/`SameSite=Lax`); só o manifesto, os ícones e o `pair.js` abrem sem token (nada privado), e quem abre `/` sem token vê a página de pareamento |
| Bloqueio | dez falhas de token em um minuto bloqueiam o endereço por um minuto, **mesmo para o token certo** |
| `Host` | validado (IP, `localhost`, nome do PC, `nome.local`): protege contra *DNS rebinding* |
| `Origin` | um `POST` de outro site é recusado |
| Entrada | o celular só dispara o que o agente **lista**: apps da barra de tarefas por identificador, atalhos do `config.json`, dispositivos de áudio que existem, passos de macro de uma lista fixa. **Nunca** caminhos, comandos, texto digitado ou teclas arbitrárias |
| Cabeçalhos | CSP restritiva, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, `no-store` |
| Corpo | tamanho limitado por rota; JSON inválido é 400 |
| Arquivos | só os do painel, de tipos conhecidos; nada fora da pasta, nem por `..` codificado |
| Câmera | o app só libera a câmera do celular para a página do PC pareado |
| Atualização | só HTTPS (HTTP só para o próprio PC, em testes), SHA-256 do manifesto e assinatura **do mesmo certificado do agente** |

### O que o agente nunca faz

Não abre portas na internet, não fala com serviços de terceiros (a única exceção é o download do filtro da câmera virtual, de um commit fixo e conferido por SHA-256, quando você pede para instalá-lo; e o endereço de atualização, se você configurar um), não grava nada da câmera (só o último quadro fica em memória) e não executa comandos que vieram do celular.

### Trocar o token

Apague a chave `token` do `config.json` e reinicie o agente: um novo é gerado e **todos os celulares precisam parear de novo**.

### O Windows "editor desconhecido"

O instalador e o `.exe` são assinados com um certificado **próprio** (`CN=Self Stream Deck`), que o Windows não conhece em outros PCs. Para distribuir, assine com o certificado de uma autoridade (`sign.ps1 -Pfx ...`).
