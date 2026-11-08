# 0007. Migração incremental (strangler)

Estado: **aceito**.

## Decisão

Interface e agente trocam por partes, atrás do mesmo contrato HTTP:

1. Fase 0: contrato e testes de contrato (feita).
2. Fase 2: interface nova em `/v2/` ao lado da antiga, até a paridade.
3. Fase 3: o agente Rust sobe o Node como filho e repassa as rotas ainda não portadas; cada rota portada sai do proxy.
4. Só então o código antigo (`legacy/`) é removido.

## Consequências

- Em nenhum momento falta uma rota; cada fase é reversível (ver "Reversão" em `docs/plano-reestruturacao.md`).
- `legacy/server` continua aceitando correções pequenas durante a migração, que são portadas depois.
- Escopo novo vai para o backlog: cada fase só entrega paridade.
