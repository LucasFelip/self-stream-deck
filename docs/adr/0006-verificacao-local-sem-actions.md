# 0006. Verificação local e hook de pre-push (e, depois, GitHub Actions)

Estado: **aceito**; a parte "sem Actions" foi **superada**: o workflow `.github/workflows/build.yml` foi ligado (roda o `check.js --ci` e compila o MSI e o APK). O hook de pre-push continua valendo.

## Contexto

`docs/plano-qualidade.md` registra que o dono decidiu não criar workflow do GitHub Actions. Parte dos testes precisa do Windows real (helpers nativos) ou de um navegador.

## Decisão

Um comando único, `node tools/check.js`, roda lint, testes unitários, testes de contrato e, opcionalmente, UI e integração. Um hook de `pre-push`
(`git config core.hooksPath tools/hooks`) roda a versão rápida. O workflow equivalente fica pronto e **desligado** em `docs/ci/`, para ligar copiando para
`.github/workflows/`.

## Consequências

- Nada roda sozinho em nuvem; a disciplina vem do hook e do hábito de rodar o `check` antes de commitar.
- Ligar o Actions depois é copiar um arquivo; o runner Windows já está previsto.
