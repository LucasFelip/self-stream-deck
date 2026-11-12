# 0009. CI no GitHub Actions

Estado: **aceito**. Substitui a parte "sem GitHub Actions" do [ADR 0006](0006-verificacao-local-sem-actions.md).

## Contexto

O ADR 0006 deixou a verificação só na máquina do dono: um comando único (`node tools/check.js`) e um hook de pre-push. Funcionou enquanto o
projeto era um diretório; deixou de bastar quando passou a gerar um instalador (MSI) e um app (APK): nada garantia que os dois compilavam
numa máquina limpa, e o `check` só rodava quando alguém lembrava de rodar a versão completa.

## Decisão

O workflow `.github/workflows/build.yml` roda a cada push na `main` e a cada pull request, em runner Windows:

- **check**: o mesmo `node tools/check.js --ci` da máquina local (lint, testes, contrato, conformidade e navegador) e a conferência de que os
  tipos gerados do contrato estão commitados.
- **msi** e **apk**: compilam o instalador e o app, para provar que o empacotamento funciona fora do PC do dono.
- **release**: na `main`, publica os dois artefatos na pré-release `latest-build`.

Regras do workflow:

- permissões mínimas (`contents: read`; só o job de release escreve) e nenhum secret;
- actions referenciadas pelo **commit**, com a versão no comentário; o Dependabot (`.github/dependabot.yml`) propõe as atualizações de
  actions, crates, pacotes npm e Gradle;
- o que é baixado fora de um gerenciador de pacotes (o WiX) é conferido por SHA-256;
- os artefatos **não são assinados**: a chave de assinatura não sai do PC do dono. Servem para testar, não para distribuir.

## Descartado

- **Assinar no CI**: exigiria guardar a chave privada como secret. O ganho (um MSI pronto para o atualizador) não paga o risco num projeto
  de uma pessoa; assinar continua sendo um passo local (`agent/scripts/sign.ps1`).
- **Runner Linux para o check**: o agente só existe para Windows e parte dos testes usa a API real do sistema.

## Consequências

- O comando único e o hook do ADR 0006 continuam: o CI roda o mesmo comando, não uma segunda definição de "está tudo certo".
- Um PR de dependência chega verificado; aceitar ou não vira uma decisão de minutos.
- Falta, e fica para um ADR próprio quando for feito: releases versionadas por tag, com changelog, e um APK de release com chave estável.
