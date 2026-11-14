# Configuração

Tudo fica em `%APPDATA%\SelfStreamDeck\config.json`. O agente lê o arquivo ao iniciar: depois de editar, **reinicie o agente** (encerre o processo `ssd.exe`: o lançador o sobe de novo em segundos, ou use `Stop-ScheduledTask`/`Start-ScheduledTask` no nome "Self Stream Deck").

O arquivo aceita BOM e é conferido ao iniciar: valores de tipo errado, ids repetidos e textos com caracteres danificados viram aviso no log, sem parar o agente. O editor do app recusa salvar algo assim. **Cada gravação guarda a versão anterior em `config.json.bak`**, e se o `config.json` ficar ilegível o agente não sobe nem o sobrescreve (isso trocaria o token): conserte-o ou copie o `.bak` por cima.

## Chaves

| Chave | Padrão | Descrição |
|---|---|---|
| `token` | gerado | O código de pareamento. Apague a chave e reinicie para gerar outro (todos os celulares precisarão parear de novo). |
| `port` | `7878` | Porta HTTP, **só em `127.0.0.1`**. |
| `lan` | `false` | `true` liga o HTTPS do Wi-Fi na `httpsPort`. |
| `httpsPort` | `7879` | Porta do HTTPS da rede local. |
| `ios` | `false` | `true` liga o acesso do iPhone: HTTPS na `iosPort` e a porta HTTP `iosCaPort`, que só entrega o certificado da autoridade. |
| `iosPort` | `7880` | HTTPS do iPhone. |
| `iosCaPort` | `7881` | HTTP que só serve o certificado público da autoridade (sem token, sem segredo). |
| `hidden` | `[]` | Identificadores de apps da barra de tarefas a esconder (veja `GET /api/apps`). |
| `editor` | `true` | `false` desliga o editor de botões: atalhos, macros e apps só mudam editando o arquivo. |
| `powerControls` | `true` | `false` remove as ações de energia da API. |
| `shortcuts` | exemplos | Lista de `{ "id", "label", "keys" }`, com `keys` como `ctrl+shift+esc`. |
| `macros` | `[]` | Criadas no editor: `{ "id", "label", "page", "steps" }`. |
| `tileOrder` | `{}` | Posição dos botões: `{ "apps": [...], "shortcuts": [...] }` com chaves `a:<app>`, `s:<atalho>`, `m:<macro>`, `c:camera`. Salvo ao arrastar; não precisa editar à mão. |
| `notifications` | `{ "enabled": true, "apps": ["whatsapp"] }` | Veja abaixo. |
| `miniPlayer` | `true` | `false` desliga o aviso de faixa nova. |
| `typingKeys` | `false` | `true` deixa o editor do celular criar atalhos com letra, número, Enter ou Espaço **sozinhos**. Veja abaixo. |
| `update` | desligado | Atualização do agente. Veja abaixo. |

### Teclas dos atalhos

`ctrl`, `shift`, `alt`, `win`, letras, números, `f1`–`f24`, setas, `esc`, `tab`, `enter`, `space`, `printscreen` e as teclas de mídia, combinadas com `+`. A lista completa está em `agent/crates/core/src/keys.rs`. Atalhos inválidos são ignorados com um aviso no log.

O que é criado **pelo editor do celular** precisa segurar `ctrl`, `alt` ou `win`, ou ser uma tecla que não escreve (`f5`, `esc`, setas, mídia). Letra, número, `enter` ou `space` sozinhos (ou só com `shift`) são recusados: vários deles em sequência digitam um comando, e o agente roda como administrador. O que está escrito à mão no `config.json` não passa por essa regra, e `"typingKeys": true` a desliga para o editor (essa chave só muda no PC).

### Notificações

```json
"notifications": { "enabled": true, "apps": ["whatsapp"] }
```

Mostra no painel as notificações do Windows dos aplicativos cujo nome ou identificador contém uma dessas palavras, mesmo com Não Incomodar ou um jogo ligado. O WhatsApp Web no navegador chega como o app do navegador e o texto não cita o WhatsApp: use `["brave"]` (ou `"chrome"`, `"edge"`), o que mostra as notificações de qualquer site desse navegador. `"enabled": false` desliga.

### Atualização

```json
"update": { "url": "https://exemplo.com/ssd/manifest.json", "channel": "stable", "auto": false, "signer": "" }
```

| Campo | Significado |
|---|---|
| `url` | O manifesto. **Sem `url` o agente não contata ninguém.** |
| `channel` | `stable` (padrão) ou `test`, os canais do manifesto. |
| `auto` | `true`: uma verificação um minuto depois de o agente subir e uma por dia; uma versão mais nova é instalada na hora. |
| `signer` | Impressão digital (SHA-1) do certificado que deve ter assinado o pacote. Só vale para o `ssd update --apply` **digitado por uma pessoa**; sem ele, vale o certificado do próprio agente. A atualização automática aceita apenas o certificado do **próprio agente** e ignora este campo (o `config.json` é gravável por qualquer programa, e o agente instala como administrador); um agente sem assinatura não se atualiza sozinho. |

Como gerar e publicar o manifesto: [desenvolvimento](desenvolvimento.md#publicar-atualizações).

## Argumentos do `ssd.exe`

| Argumento | Efeito |
|---|---|
| `--data-dir DIR` | Outra pasta de dados (padrão `%APPDATA%\SelfStreamDeck`). |
| `--web-dir DIR` | Serve o painel de uma pasta (por exemplo `web\dist`) em vez do embutido no `.exe`. |
| `--port N` | Porta HTTP só desta execução. |
| `--no-tray` | Não cria o ícone da bandeja. |
| `--migrate-from DIR` | Copia `config.json` e `tls\` de outra pasta, se a de dados ainda não tem config. |
| `--fake-platform` | Troca o PC por um PC de mentira em memória (é o que os testes usam). |
| `diagnose [--out ARQ]` | Relatório de diagnóstico. |
| `update [--apply] [--no-install] [--channel NOME] [--url ENDEREÇO]` | Procura, baixa, confere e instala uma versão. |
| `--version`, `--help` | Versão e uso. |

## Variáveis de ambiente

| Variável | Efeito |
|---|---|
| `SSD_PORT` | Porta HTTP só desta execução (não vai para o `config.json`). |
| `SSD_LOG` | `debug`, `info` (padrão), `warn` ou `error`. `debug` mostra também os erros que o agente ignora de propósito. |
| `SSD_DATA_DIR` | Outra pasta de dados. |
| `SSD_WEB_DIST` | Serve o painel desta pasta em vez do embutido. |
| `SSD_NO_FIREWALL` | Não mexe nas regras do firewall (os testes usam outras portas). |
| `SSD_AGENT_EXE` | Outro `ssd.exe` para o `contract-test` e o `agent-check`. |
| `CHROME_PATH` | Navegador para os testes e as capturas de tela. |

## Portas

| Porta | Quem | Quando |
|---|---|---|
| 7878 | HTTP, **só `127.0.0.1`** (PC e o túnel USB) | sempre |
| 7879 | HTTPS do Wi-Fi (Android) | `lan: true` |
| 7880 | HTTPS do iPhone | `ios: true` |
| 7881 | HTTP que entrega o certificado da autoridade do iPhone | `ios: true` |

As regras de firewall são "Self Stream Deck (rede local)" (7879) e "Self Stream Deck (iPhone)" (7880 e 7881): só TCP, só da **sub-rede local**, em qualquer perfil de rede.
