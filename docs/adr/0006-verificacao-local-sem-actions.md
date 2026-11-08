# 0006. Verificação local e hook de pre-push, sem GitHub Actions por ora

Estado: **aceito**; reavaliar quando o dono quiser ligar o CI.

## Contexto

`docs/plano-qualidade.md` registra que o dono decidiu não criar workflow do GitHub Actions. Parte dos testes precisa do Windows real (helpers nativos) ou de um navegador.

## Decisão

Um comando único, `node tools/check.js`, roda lint, testes unitários, testes de contrato e, opcionalmente, UI e integração. Um hook de `pre-push`
(`git config core.hooksPath tools/hooks`) roda a versão rápida. O workflow equivalente fica pronto e **desligado** em `docs/ci/`, para ligar copiando para
`.github/workflows/`.

## Consequências

- Nada roda sozinho em nuvem; a disciplina vem do hook e do hábito de rodar o `check` antes de commitar.
- Ligar o Actions depois é copiar um arquivo; o runner Windows já está previsto.
