# Mexendo no código

Para entender como as peças se encaixam, leia [docs/ARQUITETURA.md](docs/ARQUITETURA.md). Aqui está só o que se faz no dia a dia.

## Rodando

O Rust e o Node ficam no PATH (o Rust vem do `rustup`; o alvo é `x86_64-pc-windows-gnu`, veja `rust-toolchain.toml`).

```powershell
cd agent
cargo build --release                       # o agente (ssd.exe), com a interface de web/dist dentro
cargo fmt --all                             # formatação (a verificação usa --check)
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace                      # lógica pura, rotas com portas falsas, TLS, eventos

cd ..\web
npm install
npm run dev                                 # a interface com recarga automática
npm test                                    # tipos gerados do contrato, tsc --strict, ESLint, Vitest
npm run test:e2e                            # build e a interface num navegador sem tela (CHROME_PATH aponta outro)
```

Antes de abrir um commit, `node tools/check.js` (na raiz) precisa passar: formatação, lints e testes do Rust e da interface, e o agente **contra o contrato da API** (`tools/contract-test` sobe o `ssd.exe` num PC de mentira) e contra as checagens de fora para dentro (`tools/agent-check`: Host, token, pareamento, câmera, arquivos estáticos). `--full` inclui a interface num navegador. O hook de `pre-push` (`git config core.hooksPath tools/hooks`) roda a versão rápida. Mudou só texto ou documentação: o que mudou basta.

## Convenções

- **Comentários e identificadores em inglês; textos que a pessoa vê em português do Brasil.**
- **O contrato manda.** Uma rota nova entra primeiro em `contracts/openapi.yaml`; a interface gera os tipos a partir dele (`npm run gen:api` em `web/`) e o `contract-test` confere o agente contra ele.
- **O cliente só dispara o que o agente lista.** Uma rota nova valida tudo que recebe (ids contra as listas do agente, números com limites) e devolve 400/404 com um motivo.
- **O Windows fica atrás de uma porta.** A lógica (`agent/crates/core`) só conhece os traits de `ports.rs` e tem um `Fake*` de cada; só `agent/crates/platform-windows` chama a API do Windows. Assim tudo se testa sem tocar no PC (`--fake-platform`).
- **`unsafe` só no `platform-windows`, com um comentário do que o Windows promete.**
- **Não coloque dados da máquina ou pessoais no código nem nos testes** (token, nome do PC, IPs, números de série).

## Adicionar uma rota

1. Descreva em `contracts/openapi.yaml` (caminho, corpo, respostas, `operationId`, tag) e rode `npm run gen:api` em `web/`.
2. Se for uma operação do PC, acrescente o método ao trait certo em `agent/crates/core/src/ports.rs` (e ao `Fake*` dele).
3. Registre a rota em `agent/crates/api/src/routes.rs` (função `answer`, ou o módulo do assunto: `winroutes`, `powerroutes`, `monitorroutes`, `editor`, `camera`). Valide o corpo antes de usar e devolva 400/404 com `error`.
4. Acrescente os casos em `tools/contract-test/cases.js` (entrada inválida, id desconhecido, o caso de sucesso) e um teste de unidade ao lado do código.
5. Se for algo que a interface precisa saber na hora, avalie um tópico novo em `agent/crates/api/src/events.rs` (o produtor só roda enquanto alguém escuta).

## Adicionar uma operação do Windows

1. A API do Windows em `agent/crates/platform-windows/src/<assunto>.rs`, implementando o trait de `ports.rs`.
2. Um teste no PC de verdade só quando não houver como falsear; marque-o `#[ignore]` e documente como rodar.
3. Confira no seu PC com `ssd diagnose` (ele lê cada parte e mostra o que falhou).

## Adicionar uma página na interface

1. Crie `web/src/features/<nome>/` com o componente da página (`<Page section="..." id="...">`) e registre a seção em `web/src/shell/sections.ts`. Dados do PC vêm do cliente tipado (`api/client`), dados ao vivo de `useLiveQuery` (tópico do contrato).
2. Se for uma rota nova, ela entra primeiro em `contracts/openapi.yaml` e `npm run gen:api` regenera os tipos: rota ou corpo fora do contrato não compila.
3. Regras sem tela (ordem, geometria, formatação) ficam em módulos puros com teste Vitest ao lado.
4. Para algo que vale proteger de regressão no navegador, acrescente um caso em `web/e2e/*.e2e.cjs` (o servidor falso está em `web/e2e/harness.cjs`).

## Empacotar

`powershell -File agent/scripts/package.ps1 [-Sign]` constrói a interface e o agente (em `agent/target-pkg`, para não brigar com um agente em uso) e gera `dist/SelfStreamDeck-<versão>.zip` com `install.ps1` e `uninstall.ps1`.

O MSI vem de `powershell -File agent/scripts/msi/build-msi.ps1 [-Sign]` e precisa do WiX Toolset 3.14 em `.tools/wix` (descompacte `wix314-binaries.zip` do [release wix3141rtm](https://github.com/wixtoolset/wix3/releases/tag/wix3141rtm); a pasta `.tools/` fica fora do git).
