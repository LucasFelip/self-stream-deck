# 0003. OpenAPI como fonte única do contrato

Estado: **aceito**, em uso desde a Fase 0.

## Contexto

A interface e o agente conversavam por convenção. Rotas, formatos e validações só existiam no código (`routes/*.js`, `validate.js`) e nos testes, e já
houve divergências (`iconVersion` número num lado e texto no outro; `fastStartup` ausente).

## Decisão

`contracts/openapi.yaml` (OpenAPI 3.1) descreve as 51 operações, os 9 tópicos de SSE (`x-events`) e a segurança. `contracts/fixtures/fake-pc.json` é o PC de mentira
que qualquer agente precisa apresentar. `tools/contract-test` confere uma implementação contra os dois; a lista de rotas do código e a do contrato
precisam ser a mesma. Tipos TypeScript são gerados do OpenAPI; no Rust, `utoipa` gera o YAML e um teste confere que não divergiu.

## Consequências

- Rota nova sem contrato quebra o teste. Mudar a API é mudar o YAML, a fixture (se preciso) e os casos.
- O agente em Rust herda os casos prontos; basta um modo `--fake-platform`.
- Casos que dependem de ganchos do Node ficam como `skip` para outros agentes até haver injeção de falhas equivalente.
