# Solução de problemas

Primeiro passo para quase tudo: rode o relatório e olhe o registro.

```powershell
& "C:\Program Files\Self Stream Deck\ssd.exe" diagnose
```

Ele mostra a versão, a configuração (token mascarado), quais portas respondem, os certificados, a tarefa agendada, as regras de firewall, o que cada parte do PC respondeu e o fim do `server.log` (em `%APPDATA%\SelfStreamDeck\`). Para anexar a um relato: `ssd.exe diagnose --out relatorio.txt`. Para ver também os erros que o agente ignora de propósito, rode o agente com `SSD_LOG=debug`.

## O app mostra "Sem conexão com o PC"

| Confira | Como |
|---|---|
| O agente está rodando? | ícone perto do relógio; ou `Get-Process ssd` (o `wscript` ao lado é o vigia que o reinicia). Se não, `Start-ScheduledTask "Self Stream Deck"`. |
| Por USB | a depuração USB está ativa e você rodou `adb reverse tcp:7878 tcp:7878` **depois** de plugar? Sem isso o app tenta o Wi-Fi. |
| Por Wi-Fi | `"lan": true` no `config.json` e agente reiniciado; celular e PC na mesma rede; IP do PC igual ao do link (reserve o IP no roteador); a regra "Self Stream Deck (rede local)" existe (`ssd.exe diagnose`). |
| O token ainda vale? | se o `config.json` perdeu o `token` e o agente gerou outro, o celular precisa parear de novo (menu ⚙ → *Endereço do PC…*). |

A tela "Sem conexão" tenta de novo a cada 5 s e abre o painel assim que o PC responde; **Tentar agora** repete na hora, **Configurar endereço** abre o pareamento e **Bloquear tela** bloqueia o celular.

## A porta 7878 está ocupada

O agente avisa "port 7878 is not available" e encerra. Algo mais usa a porta: um agente de teste esquecido (`Get-Process ssd`), a versão antiga em Node, ou outro programa. Encerre-o, ou mude `port` no `config.json`.

## O agente caiu

O lançador o sobe de novo em ~3 segundos e escreve no `server.log` uma linha `[launcher] ssd.exe ended with code …; starting it again`. Se ele cai logo ao iniciar 5 vezes seguidas, o lançador desiste (algo está errado e reiniciar não resolve: o log diz o quê). Para investigar uma queda, junte o `ssd.exe diagnose` e o evento do Windows (*Visualizador de Eventos → Aplicativo → Application Error*, procure `ssd.exe`).

Um **"Sair"** pelo ícone da bandeja encerra o agente de vez (código 0, sem reinício); ele volta no próximo logon ou com `Start-ScheduledTask "Self Stream Deck"`.

## A câmera virtual mostra listras verdes no Meet

A mensagem "Unity has not started sending image data" quer dizer que o filtro da câmera está aberto, mas nenhum quadro chega a ele.

1. A transmissão do celular está ligada? (tecla de câmera vermelha; na página da câmera a linha de status deve mostrar "Transmitindo".)
2. A linha mostra "câmera direta em uso"? Se mostra "nenhum app usando ainda", o app do outro lado não abriu o filtro: **desligue e ligue a câmera dele** (o Meet solta a câmera quando o fluxo para, por exemplo depois de reiniciar o agente).
3. O app mostra a lista de câmeras só ao abrir: se "Stream Deck Camera" não aparece, instale a câmera (*Segure p/ instalar*) e reabra o app.

(Já houve um defeito em que o agente descartava os quadros quando o filtro estava registrado numa pasta antiga: foi corrigido na 0.1.6.)

## A câmera está em 1 fps

É o modo de espera: nenhum app usa a imagem. Abra a câmera "Stream Deck Camera" no app que vai usá-la; o celular volta ao ritmo cheio sozinho.

## A câmera engasga ou tem poucos quadros

Veja [câmera → como melhorar](camera.md#como-melhorar). Na linha de status, "câmera N fps" baixo quer dizer pouca luz; "cod." alto, codificação lenta.

## As temperaturas ou a potência aparecem como "–"

O Windows não expõe esses sensores de todo processador. Abra o **MSI Afterburner** (o painel o lê pela memória compartilhada); a GPU vem do `nvidia-smi` (placas NVIDIA). O FPS do jogo vem do RTSS.

## O brilho de um monitor não muda

O brilho usa DDC/CI: só funciona em monitores que o aceitam e com o recurso ligado no menu do monitor. Telas de notebook e alguns monitores não respondem.

## O Windows mostra "editor desconhecido" (SmartScreen)

O instalador e o `ssd.exe` estão assinados com um certificado próprio. Escolha *Mais informações → Executar assim mesmo*. Para distribuir sem o aviso, assine com o certificado de uma autoridade.

## `msiexec /x arquivo.msi` dá erro 1605

O código do produto muda a cada compilação; desinstale por *Aplicativos instalados* ou `msiexec /x "{ProductCode}"`.

## A atualização é recusada

`ssd.exe update --apply` diz o motivo:

| Mensagem | Significa |
|---|---|
| "no update address" | falta `update.url` no `config.json` |
| "this agent is not signed and no `update.signer`" | o agente instalado não tem assinatura e não há `signer` configurado |
| "this agent is not signed, so it does not update by itself" | a atualização automática só aceita o certificado do próprio agente; com um agente sem assinatura, use `ssd update --apply` |
| "the \"update\" folder beside ssd.exe cannot be written" | o agente roda como administrador e não conseguiu criar `update\` na pasta do programa; ele não instala a partir de pasta temporária |
| "the package is signed by X, not by Y" | o pacote foi assinado por outro certificado |
| "the package does not match the manifest" | o SHA-256 do arquivo não bate com o do manifesto |
| "the signature of the package is not good (HashMismatch)" | o pacote foi alterado depois de assinado |
| "only https:// addresses are accepted" | o manifesto ou o pacote não vêm por HTTPS |

## O iPhone não abre depois de o IP do PC mudar

O nome `nome-do-pc.local` continua valendo. Para o IP novo entrar no certificado, apague a pasta `%APPDATA%\SelfStreamDeck\tls\ios\` **menos** os arquivos `ca.*` (a autoridade já instalada no iPhone) e reinicie o agente.

## O token foi exposto ou perdido

Apague a chave `token` do `config.json` e reinicie o agente: um novo é gerado; depois pareie os celulares de novo. Para ver o atual: ícone da bandeja → *Mostrar código de pareamento*.

## O `adb` perdeu o celular durante os testes

Reinicie o servidor do `adb` (`adb kill-server`, depois `adb start-server`). Isso não afeta o app nem o agente.
