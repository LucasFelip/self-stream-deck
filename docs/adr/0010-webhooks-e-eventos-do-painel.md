# 0010. Webhooks e eventos do painel

Estado: **aceito**.

## Contexto

Hoje o painel só reage a toques e ao que o próprio PC emite. Scripts, CI e automações da casa (Home Assistant, `curl` numa tarefa agendada) não têm como
mostrar um aviso, trocar de página ou deixar um valor no painel. Usar o token do celular para isso o espalharia por scripts e logs de terceiros.

## Decisão

1. Um conjunto de rotas `/api/hook/*` (aviso, ir para página, recarregar, valores com TTL) com **chave própria** (`webhookKey` no `config.json`).
2. A chave do webhook abre **somente** `/api/hook/*`; o token do celular continua abrindo tudo, inclusive essas rotas.
3. Um webhook só afeta o **painel**: mostra um aviso, troca de página, recarrega, guarda ou remove um valor. Ele **nunca** dispara atalho, macro, energia,
   abrir aplicativo ou câmera.
4. A chave pode ir em `Authorization: Bearer`, em `x-token` ou, para quem não consegue mandar cabeçalho, em `?key=`, e só nessas rotas. A chave é trocável
   a qualquer momento pela bandeja sem invalidar o pareamento dos celulares.
5. O mesmo `Origin`, o bloqueio por falhas e a trilha de auditoria valem para as rotas novas.
6. O `?token=` do celular na query passa a valer só no link de pareamento (`GET /`) e no `GET /api/ping`; em qualquer outra rota é cabeçalho ou cookie.

## Consequências

- Quem tem a chave do webhook pode, no máximo, poluir o painel; não controla o PC.
- A chave pode aparecer em logs de quem envia (`?key=`); por isso a troca é um clique e o escopo é pequeno.
- Dois tópicos novos no SSE (`push` e `panel`); o contrato os descreve e o teste de contrato confere o primeiro valor.
- Restringir o `?token=` pode quebrar um cliente que o usava em outras rotas: a mudança vai num commit separado, coberta pelo `tools/agent-check`.
