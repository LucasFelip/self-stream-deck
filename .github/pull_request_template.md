## O que muda

<!-- Uma ou duas frases: o que a pessoa que usa (ou quem mexe no código) passa a ver de diferente. -->

## Por quê

<!-- O problema, não a solução. Se há um ADR ou uma issue, aponte. -->

## Como foi verificado

- [ ] `node tools/check.js` passou (`--full` se mexeu no painel)
- [ ] Testado de verdade no PC / no celular: <!-- o que foi feito -->

## Lista

- [ ] O título segue `tipo(escopo): o que mudou` (ele vira o commit do squash)
- [ ] `CHANGELOG.md` ("Não lançado") atualizado, se quem usa percebe a mudança
- [ ] Contrato (`contracts/openapi.yaml`) e documentação atualizados, se a API ou o `config.json` mudaram
- [ ] Nenhum dado da máquina ou pessoal (token, nome do PC, IP) no código, nos testes ou nas capturas
