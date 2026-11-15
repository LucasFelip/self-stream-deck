# Webhooks

Scripts, CI e automações da casa (Home Assistant, uma tarefa agendada com `curl`) podem **mostrar um aviso**, **trocar a página** do painel e **deixar valores** para ele exibir. Tudo com uma chave própria, que não abre mais nada do PC. A decisão está em [ADR 0010](adr/0010-webhooks-e-eventos-do-painel.md).

## A chave

Cada instalação tem uma `webhookKey` no `config.json`, gerada na primeira execução. Para ver a chave e um exemplo de `curl`:

```bash
ssd.exe webhook
```

O mesmo está no ícone da bandeja (*Mostrar chave de webhook*). Para trocá-la (os celulares pareados não são afetados):

```bash
ssd.exe webhook --rotate
```

Depois escolha *Sair* na bandeja: o agente volta sozinho com a chave nova.

A chave abre **somente** `/api/hook/*`. Ela não abre `/api/volume`, `/api/power` nem nenhuma outra rota; o token do celular continua abrindo tudo, inclusive as rotas de webhook.

## Como mandar a chave

Em qualquer uma destas formas:

| Forma | Exemplo |
|---|---|
| Cabeçalho `Authorization` | `-H "Authorization: Bearer <chave>"` |
| Cabeçalho `X-Token` | `-H "X-Token: <chave>"` |
| Query `?key=` | `.../api/hook/notify?key=<chave>` (para quem não consegue mandar cabeçalho; endereços vão para logs, então prefira o cabeçalho) |

## Rotas

| Rota | O que faz |
|---|---|
| `POST /api/hook/notify` | Mostra um aviso no painel (com uma vibração curta). Corpo: texto puro ou `{ "title"?, "text" }`; texto de até 500 caracteres. |
| `POST /api/hook/goto/{página}` | Abre uma página: `apps`, `shortcuts`, `windows`, `sound`, `pc`, `power` (ou `shortcuts-1`, a segunda página de Atalhos). Uma página que o painel não tem é ignorada. |
| `POST /api/hook/refresh` | O painel recarrega o que está mostrando. |
| `PUT` ou `POST /api/hook/push/{chave}` | Guarda um valor (JSON ou texto, até 8 KB). `?ttl=segundos` o apaga sozinho (até 30 dias); sem `ttl` ele fica até ser apagado. No máximo 200 valores. |
| `GET /api/hook/push/{chave}` · `GET /api/hook/push` | Lê um valor ou todos. |
| `DELETE /api/hook/push/{chave}` | Apaga um valor. |

A chave de um valor tem de 1 a 64 caracteres: letras, números, `.`, `_` e `-`. Os valores sobrevivem a um reinício (`data.json`, ao lado do `config.json`); os avisos não.

No painel, os valores aparecem em **PC › Painel**, que só existe enquanto houver algum valor (ou alguma [regra](regras.md)).

## Exemplos

```bash
curl -H "Authorization: Bearer <chave>" -d "build terminou" http://127.0.0.1:7878/api/hook/notify
```

```bash
curl -H "Authorization: Bearer <chave>" -H "Content-Type: application/json" -d '{"title":"CI","text":"verde"}' http://127.0.0.1:7878/api/hook/notify
```

```bash
curl -X PUT -H "Authorization: Bearer <chave>" -d 21.5 "http://127.0.0.1:7878/api/hook/push/temp.sala?ttl=300"
```

```bash
curl -X POST -H "Authorization: Bearer <chave>" http://127.0.0.1:7878/api/hook/goto/sound
```

## De outra máquina

O agente escuta só em `127.0.0.1`. Para chamar de outra máquina da casa, ligue o HTTPS do Wi-Fi (`"lan": true`, veja [rede e segurança](rede-e-seguranca.md#wi-fi-android)) e use a porta `7879`; o certificado é o do próprio agente, então o remetente precisa confiar nele (por exemplo `curl --cacert` com o certificado, ou `--insecure` se a rede é só sua).

## O que um webhook nunca faz

Mostra, troca de página, recarrega e guarda valores: **só isso**. Não aperta tecla, não roda macro, não abre programa e não mexe na energia. Quem tem a chave pode, no máximo, encher o painel de avisos; é por isso que ela pode ficar em scripts e em serviços de CI. Falhas de chave contam para o bloqueio (dez em um minuto bloqueiam o endereço), e um `POST` de outro site continua sendo recusado.
