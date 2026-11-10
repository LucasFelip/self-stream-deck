# Instalação

## O que é instalado

Um único programa, `ssd.exe`, com o painel dentro. Ele roda **sem janela**, inicia com o Windows (tarefa agendada, como administrador) e mostra um ícone perto do relógio. Precisa de administrador para que os atalhos de teclado também alcancem janelas elevadas, para o desligar e reiniciar não pedirem confirmações extras e para criar as regras de firewall do celular.

| O quê | Onde |
|---|---|
| Programa | `C:\Program Files\Self Stream Deck\` (`ssd.exe`, `launch-hidden.vbs` e os scripts da tarefa) |
| Dados | `%APPDATA%\SelfStreamDeck\` |
| Tarefa | "Self Stream Deck" (no logon, oculta, administrador; o lançador reinicia o agente se ele cair) |
| Atalho | Menu Iniciar → Self Stream Deck |

Dentro de `%APPDATA%\SelfStreamDeck\`: `config.json` (com o token de pareamento) e `config.json.bak`, `tls\` (os certificados que os celulares fixam), `icons\`, `vcam\` (o filtro da câmera), `server.log` (gira a 2 MB, guardando `server.log.old`).

## Instalar com o MSI

```powershell
msiexec /i SelfStreamDeck-0.1.7.msi
```

(ou dois cliques). O MSI:

1. para o agente anterior, se houver, e remove a tarefa velha;
2. copia os arquivos para `Program Files` e cria o atalho do Menu Iniciar;
3. registra a tarefa e **inicia o agente** (se o Agendador ignorar o início, um gatilho único 25 s depois o sobe).

Opções (propriedades do MSI):

| Propriedade | Efeito |
|---|---|
| `MIGRATEFROM="C:\pasta\antiga"` | copia `config.json` e `tls\` de uma instalação anterior: o token **não muda** e o celular continua pareado |
| `NOSTART=1` | registra a tarefa sem iniciar o agente |

Com log: `msiexec /i SelfStreamDeck-0.1.7.msi /l*v "$env:TEMP\ssd-msi.log"`. Atualizar é instalar o MSI novo por cima (a mesma versão também vale). Instalar de novo reinicia o agente: a transmissão da câmera do celular precisa ser ligada de novo.

> **Gerar o MSI.** O MSI não é distribuído pronto: `powershell -File agent/scripts/msi/build-msi.ps1 [-Sign]` o cria em `dist\` (precisa do WiX 3.14; veja [desenvolvimento](desenvolvimento.md#empacotar)).

## Instalar com o zip

Alternativa sem MSI: `powershell -File agent/scripts/package.ps1 [-Sign]` cria `dist\SelfStreamDeck-<versão>.zip`. Descompacte e rode (pede administrador uma vez):

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 [-From "pasta\antiga"] [-NoStart]
```

Faz o mesmo que o MSI. `uninstall.ps1 [-RemoveData]` desfaz.

## Primeira execução e pareamento

Na primeira vez o agente cria o `config.json` com um **token** novo. Para ver o endereço de pareamento:

- ícone da bandeja → **Mostrar código de pareamento**; ou
- `server.log` (as linhas "listening on…" e os links do Wi-Fi e do iPhone); ou
- no celular já pareado: menu ⚙ → *Código de pareamento* (iPhone).

Depois, [conecte o celular](rede-e-seguranca.md).

## Ícone da bandeja

Clique duplo ou *Abrir painel*: abre o painel no navegador do PC. *Mostrar código de pareamento*, *Abrir registro (log)* e *Sair* (encerra o agente de vez, sem reinício; ele volta no próximo logon).

## Linha de comando

```
ssd.exe                       roda o agente (é o que a tarefa faz)
ssd.exe --version
ssd.exe diagnose [--out ARQ]  relatório para investigar problemas
ssd.exe update [--apply] ...  procura (e instala) uma versão nova
```

Opções do agente: `--data-dir DIR`, `--web-dir DIR` (serve o painel de uma pasta em vez do embutido), `--port N`, `--no-tray`, `--migrate-from DIR`, `--fake-platform` (um PC de mentira, para testes). Mais em [configuração](configuracao.md#argumentos-do-ssdexe).

### `ssd diagnose`

Imprime (ou grava com `--out`) a versão, as pastas, a configuração com o token **mascarado**, quais portas respondem, as impressões digitais dos certificados, a tarefa agendada, as regras de firewall, o que cada parte do PC (áudio, mídia, janelas, telas, monitor, câmera) respondeu e o fim do log (com o token trocado por `***`). Nada secreto sai nele; é o que se anexa a um relato de problema.

## Atualizar

- **Manualmente:** instale o MSI novo por cima.
- **Pelo próprio agente:** aponte `update.url` para um manifesto e rode `ssd.exe update --apply`, ou ligue `"auto": true`. Só é instalado um pacote por HTTPS, com o SHA-256 do manifesto e **assinado pelo mesmo certificado do agente**. Detalhes em [configuração](configuracao.md#atualização) e [desenvolvimento](desenvolvimento.md#publicar-atualizações).

## Desinstalar

*Configurações → Aplicativos → Aplicativos instalados → Self Stream Deck → Desinstalar*, ou `msiexec /x "{ProductCode}"` (o código do produto aparece no registro do Windows). Isso para o agente, remove a tarefa, o atalho, as regras de firewall e os arquivos do programa. **Os dados ficam** (`%APPDATA%\SelfStreamDeck`), então reinstalar não exige parear de novo; apague a pasta para zerar tudo.

> `msiexec /x arquivo.msi` com um pacote recompilado falha com o erro 1605: o código do produto muda a cada compilação. Desinstale pelo código ou pela interface do Windows.

## Vindo de uma versão anterior (servidor Node)

Instale o MSI com `MIGRATEFROM` apontando para a pasta de dados antiga (a que tinha `config.json`): o token e os certificados vêm junto. A câmera virtual direta continua registrada no caminho antigo e **funciona assim mesmo**; para registrá-la na pasta nova, no app, em *Câmera do celular*, segure "Segure p/ instalar".
