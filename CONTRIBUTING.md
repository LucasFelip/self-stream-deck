# Mexendo no código

Para entender como as peças se encaixam, leia [docs/ARQUITETURA.md](docs/ARQUITETURA.md); o ambiente, os testes e o empacotamento estão em [docs/desenvolvimento.md](docs/desenvolvimento.md) e o índice de toda a documentação em [docs/README.md](docs/README.md). Aqui está só o que se faz no dia a dia.

## Rodando

O Rust e o Node ficam no PATH. O Rust vem do `rustup`, na versão exata de `rust-toolchain.toml`; o agente compila com os dois alvos do Windows: `x86_64-pc-windows-msvc` (o do CI) e `x86_64-pc-windows-gnu` (MinGW, sem Visual Studio).

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

## Commits, branches e versões

- **Um branch por mudança, um pull request por branch.** A `main` só recebe PRs com o workflow `build` verde, por *squash*: o título do PR vira o commit.
- **Mensagens no padrão [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/):** `tipo(escopo): o que mudou`, em português, no presente, sem ponto final.
  Tipos: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Escopos: `agent`, `web`, `android`, `contract`, `tools`, `docs`, `ci`, `release`, `deps`.
  Exemplos: `feat(web): o editor pergunta antes de descartar alterações`, `fix(agent): a câmera virtual conta como instalada onde o Windows a registrou`.
  O hook `commit-msg` (`git config core.hooksPath tools/hooks`, o mesmo do `pre-push`) recusa o que foge disso.
- **O que quem usa percebe entra no [CHANGELOG](CHANGELOG.md)**, em "Não lançado", no mesmo PR.
- **A versão é uma só** (`agent/Cargo.toml`, repetida em `web/package.json` e no `build.gradle.kts` do Android; `tools/version-check` confere) e só muda no commit de release: [como publicar uma versão](docs/desenvolvimento.md#publicar-uma-versão).

## Convenções

- **Comentários e identificadores em inglês; textos que a pessoa vê em português do Brasil.**
- **O contrato manda.** Uma rota nova entra primeiro em `contracts/openapi.yaml`; a interface gera os tipos a partir dele (`npm run gen:api` em `web/`) e o `contract-test` confere o agente contra ele.
- **O cliente só dispara o que o agente lista.** Uma rota nova valida tudo que recebe (ids contra as listas do agente, números com limites) e devolve 400/404 com um motivo.
- **O Windows fica atrás de uma porta.** A lógica (`agent/crates/core`) só conhece os traits de `ports.rs` e tem um `Fake*` de cada; só `agent/crates/platform-windows` chama a API do Windows. Assim tudo se testa sem tocar no PC (`--fake-platform`).
- **`unsafe` só no `platform-windows`, com um comentário do que o Windows promete.**
- **Sem `lock().unwrap()`:** use `locked()` (`ssd_core::sync::Locked`). **Sem `Result<_, String>` em código novo:** um erro que o código distingue tem um tipo (`thiserror`).
- **No painel, toda mensagem de erro passa por `errorText` (`web/src/lib/errors.ts`)**, e toda camada (`z-index`) é um dos tokens `--z-*` de `style.css`.
- **Não coloque dados da máquina ou pessoais no código nem nos testes** (token, nome do PC, IPs, números de série).

## Adicionar uma rota

1. Descreva em `contracts/openapi.yaml` (caminho, corpo, respostas, `operationId`, tag) e rode `npm run gen:api` em `web/`.
2. Se for uma operação do PC, acrescente o método ao trait certo em `agent/crates/core/src/ports.rs` (e ao `Fake*` dele).
3. Registre a rota na tabela do módulo do assunto, em `agent/crates/api/src/` (a função `routes()` de `audio`, `media`, `shortcuts`, `apps`, `winroutes`, `powerroutes`, `monitorroutes`, `editor` ou `camera`; um assunto novo ganha um módulo e uma linha em `routes::table`). Valide o corpo antes de usar e devolva 400/404 com `error`; se a rota muda algo que merece rastro, acrescente o caminho a `access::is_audited`.
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

## Licença

O projeto é MIT ([LICENSE](LICENSE)). Ao enviar uma contribuição você concorda que ela seja distribuída sob a mesma licença.
