# Desenvolvimento

Para entender como as peças se encaixam, leia a [arquitetura](ARQUITETURA.md). Para as convenções e as receitas ("como acrescento uma rota"), o [CONTRIBUTING](../CONTRIBUTING.md). Este guia cobre o ambiente, os comandos, os testes, o empacotamento e a publicação.

## Ambiente

| Para | Precisa de |
|---|---|
| Agente (Rust) | `rustup` com o Rust estável. O arquivo [`rust-toolchain.toml`](../rust-toolchain.toml) fixa a **versão exata** do compilador e os componentes (`rustfmt`, `clippy`); o `rustup` a instala sozinho. Compila com os dois alvos: `x86_64-pc-windows-gnu` (MinGW; o desenvolvimento e os pacotes assinados são feitos assim, sem Visual Studio) e `x86_64-pc-windows-msvc` (o do runner do CI) |
| Painel e ferramentas | Node 20+ (`npm`) |
| Testes de navegador e capturas | Chrome, Brave ou Edge (`CHROME_PATH` aponta outro) |
| App Android | JDK 17, Gradle 8.7, Android SDK 34 (a pasta `.tools/`, fora do git, guarda os seus) |
| Instalador MSI | WiX Toolset 3.14 em `.tools/wix` |
| Assinatura | PowerShell 5.1 (já vem no Windows) |

Só o Windows é suportado para o agente (ele usa as APIs do Windows). O painel e o contrato podem ser trabalhados em qualquer sistema.

## Os comandos do dia a dia

```powershell
# o agente
cd agent
cargo build --release                       # agent\target\release\ssd.exe, com web\dist embutido
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# o painel
cd web
npm install
npm run dev                                 # recarga automática
npm test                                    # tipos gerados do contrato + tsc --strict + ESLint + Vitest
npm run build                               # web\dist
npm run test:e2e                            # o painel num navegador sem tela

# tudo de uma vez
node tools/check.js                         # rápido: o que o hook de pre-push roda
node tools/check.js --full                  # inclui os testes de navegador
```

O agente embute `web/dist` no `.exe` na compilação (`rust-embed`); por isso **compile o painel antes do agente** quando quiser a interface nova dentro dele. Para trabalhar no painel sem recompilar o agente, rode o agente servindo a pasta:

```powershell
agent\target\release\ssd.exe --data-dir .\dados-teste --web-dir web\dist --port 7878
```

`--fake-platform` troca o PC por um PC de mentira em memória (sem tocar no Windows): é o que os testes usam.

Para o `check.js` rodar sozinho antes de cada `git push`: `git config core.hooksPath tools/hooks` (pule uma vez com `git push --no-verify`). No GitHub, o fluxo `.github/workflows/build.yml` roda a cada push na `main` e em pull requests: `check.js --ci`, o MSI (WiX 3.14) e o APK de depuração, que ficam como artefatos da execução. Quando tudo passa na `main`, um quarto job atualiza a [versão `latest-build`](https://github.com/LucasFelip/self-stream-deck/releases/tag/latest-build) com o `SelfStreamDeck.msi` e o `SelfStreamDeck-debug.apk` do último commit (sempre os mais recentes, com `SHA256SUMS.txt`). Eles **não são assinados**: servem para testar e conferir que compilam ([ADR 0006](adr/0006-verificacao-local-sem-actions.md)).

## Testes

| O quê | Comando | Confere |
|---|---|---|
| Lógica e rotas do agente | `cargo test --workspace` (em `agent/`) | regras puras (atalhos, macros, energia, guarda), rotas com portas falsas, TLS, eventos, atualização |
| Painel | `npm test` (em `web/`) | tipos gerados do contrato, `tsc --strict`, ESLint, Vitest |
| Painel no navegador | `npm run test:e2e` (em `web/`) | cada página, o menu, as folhas, a câmera, o layout em vários tamanhos, contra um servidor falso que obedece ao contrato |
| **Contrato** | `npm test` em `tools/contract-test/` | o `ssd.exe` num PC de mentira contra `contracts/openapi.yaml`: cada operação, esquemas, segurança, eventos |
| De fora para dentro | `node tools/agent-check/run.js` | `Host`, token, pareamento, cookie, cabeçalhos, ETag, câmera, energia, editor, monitor, bloqueio |
| Atualização | `powershell -File tools/update-check/run.ps1` | contra um feed local: mesma versão, versão nova, sem assinatura, signatário certo e errado, hash errado, pacote adulterado |
| Links da documentação | `node tools/docs-check/run.cjs` | todo link relativo e toda âncora dos `.md` (o `check.js` roda isto) |
| Capturas de tela | `node tools/screenshots/run.cjs` | gera `docs/img/*.png` do PC de mentira |

O `contract-test` e o `agent-check` precisam do agente compilado (`cargo build --release`) e de `web/dist`. Detalhes do contrato em [contracts/README.md](../contracts/README.md).

## Empacotar

Todos os scripts ficam em `agent/scripts/`. O build de empacotamento usa `agent\target-pkg` para não brigar com um agente em uso (o `ssd.exe` em execução trava o arquivo).

| Script | Faz |
|---|---|
| `package.ps1 [-Sign] [-SkipWeb]` | compila o painel e o agente e cria `dist\SelfStreamDeck-<versão>.zip` (+ `.sha256`) com `ssd.exe`, `install.ps1`, `uninstall.ps1` e `launch-hidden.vbs` |
| `msi\build-msi.ps1 [-Sign] [-SkipBuild]` | cria `dist\SelfStreamDeck-<versão>.msi` (+ `.sha256`) |
| `sign.ps1 -File ARQ [-Pfx CERT.pfx -Password …] [-Timestamp]` | assina um arquivo com Authenticode |
| `make-manifest.ps1 -Msi ARQ -BaseUrl https://… [-Channel stable]` | gera o manifesto de atualização |

**A versão** vem de `agent/Cargo.toml` (`[workspace.package] version`); o MSI e o `ssd --version` a leem de lá.

### O MSI (WiX 3.14)

O WiX não faz parte do repositório. Baixe `wix314-binaries.zip` do [release wix3141rtm](https://github.com/wixtoolset/wix3/releases/tag/wix3141rtm) e descompacte em `.tools\wix` (os executáveis do WiX 3.14 não têm assinatura digital; o GitHub não publica um hash desse arquivo; o CI confere o SHA-256 `6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31`, o do arquivo de 41 297 555 bytes usado desde o primeiro MSI: `Get-FileHash wix314-binaries.zip`). Depois: `powershell -File agent/scripts/msi/build-msi.ps1 -Sign`.

O instalador está em `agent/scripts/msi/ssd.wxs`: copia os arquivos, cria o atalho e roda duas ações (`task-register.ps1` e `task-remove.ps1`) que registram e removem a tarefa e as regras de firewall. Atualizar por cima funciona também com a mesma versão (`AllowSameVersionUpgrades`).

### Assinar

`sign.ps1` assina com um certificado de código **próprio** (`CN=Self Stream Deck`, criado uma vez no repositório de certificados do usuário) ou com um `.pfx` seu (`-Pfx`, `-Password`). O Windows mostra "não confiável" para certificado próprio em outros PCs, o que é esperado; um certificado de uma autoridade remove o aviso. `-Timestamp` pede o carimbo de data ao servidor da DigiCert e é opcional (envia só o hash).

## Publicar uma versão

1. No `CHANGELOG.md`, renomeie "Não lançado" para `## [X.Y.Z] - AAAA-MM-DD`, abra um "Não lançado" vazio acima e acrescente o link de comparação no fim do arquivo.
2. Mude a versão em `agent/Cargo.toml` (e rode `cargo build` para o `Cargo.lock`), `web/package.json` (`npm install --package-lock-only` em `web/`) e `android/app/build.gradle.kts` (`versionName` e `versionCode` = maior×10000 + menor×100 + correção). `node tools/version-check/run.cjs` diz o que ficou de fora.
3. `node tools/check.js --full`, depois o commit `chore(release): vX.Y.Z` (por PR, como qualquer mudança).
4. Na `main`, com esse commit: `git tag -a vX.Y.Z -m "Self Stream Deck X.Y.Z"` e `git push origin vX.Y.Z`.

A tag dispara `.github/workflows/release.yml`: ele confere que a tag é a versão do projeto e que o CHANGELOG tem as notas, roda o mesmo `build` de todo commit e publica a release com `SelfStreamDeck-X.Y.Z.msi`, o APK, `SHA256SUMS.txt` e as notas.

- **O MSI da release não é assinado** (a chave não sai do seu PC). Para o atualizador automático, gere e assine localmente (`build-msi.ps1 -Sign`) e troque o arquivo: `gh release upload vX.Y.Z dist\SelfStreamDeck-X.Y.Z.msi --clobber`.
- **O APK sai assinado** quando o repositório tem os secrets `SSD_KEYSTORE_B64` (o `.jks` em base64), `SSD_KEYSTORE_PASSWORD`, `SSD_KEY_ALIAS` e `SSD_KEY_PASSWORD`; sem eles vai o APK de depuração, que não atualiza por cima de outro build (cada runner tem uma chave de depuração diferente). Crie a chave uma vez e guarde uma cópia fora do GitHub: perder a chave é não conseguir mais atualizar o app instalado.
  `keytool -genkeypair -v -keystore ssd-release.jks -alias ssd -keyalg RSA -keysize 4096 -validity 10000`
- A pré-release `latest-build` continua existindo: é o build do último commit da `main`, para testar, não uma versão.

## Publicar atualizações

O agente só contata um endereço se `update.url` estiver configurado. Para publicar:

1. Aumente a versão em `agent/Cargo.toml` e gere o MSI **assinado**: `build-msi.ps1 -Sign`.
2. Gere o manifesto: `make-manifest.ps1 -Msi dist\SelfStreamDeck-0.2.0.msi -BaseUrl https://seu-servidor/ssd -Channel stable`. Ele cria `manifest.json` ao lado do MSI, preservando os outros canais (`test`).
3. Publique o `.msi` e o `manifest.json` num servidor **HTTPS** estático.
4. Nos PCs: `"update": { "url": "https://seu-servidor/ssd/manifest.json" }` no `config.json`. `ssd.exe update` mostra se há versão; `--apply` instala; `"auto": true` faz sozinho, uma vez por dia.

O agente confere, nesta ordem: HTTPS, versão mais nova (`0.2.0-rc1` vale menos que `0.2.0`), tamanho e SHA-256 do manifesto e a assinatura do pacote **pelo mesmo certificado do agente que está rodando** (o `update.signer` vale só para o `ssd update --apply` manual; a atualização automática o ignora). Um agente sem assinatura e sem `signer` recusa atualizar, e nunca se atualiza sozinho. O pacote fica em `update\` ao lado do `ssd.exe`, pasta que só administrador escreve. O instalador é lançado fora do processo do agente para sobreviver a ele, e um gatilho único da tarefa o sobe de novo se o Agendador ignorar o início.

## App Android

```powershell
$t = "<repo>\.tools"
$env:JAVA_HOME = "$t\jdk17"; $env:ANDROID_SDK_ROOT = "$t\android-sdk"
cd android
.\gradlew testDebugUnitTest lint assembleDebug      # o Gradle Wrapper baixa o Gradle 8.7 (conferido por SHA-256) na primeira vez
& "$t\platform-tools\adb.exe" install -r app\build\outputs\apk\debug\app-debug.apk
```

`assembleRelease` gera o APK de release: assinado quando `SSD_KEYSTORE` (o caminho do `.jks`), `SSD_KEYSTORE_PASSWORD`, `SSD_KEY_ALIAS` e `SSD_KEY_PASSWORD` estão no ambiente, sem assinatura caso contrário.

As versões (AGP 8.5.2, Kotlin 1.9.24) ficam em `android/gradle/libs.versions.toml`. O app é uma casca: `MainActivity.kt` (a WebView, a ponte `Android.*`, o relógio, o bloqueio de tela), `Connection.kt` (o teste dos endereços e as telas "Conectando" e "Sem conexão") e `Pairing.kt` (o que não depende do Android e por isso tem testes em `app/src/test`: o formato do endereço, a ordem das tentativas, quais origens são o painel e a conferência do certificado fixado). A ponte que a página enxerga é `openSettings`, `reconnect`, `setDim`, `vibrate` e `lockScreen`; todos opcionais do lado do painel, porque um APK antigo não tem os mais novos (veja `web/src/lib/android.ts`).

Para parear por linha de comando (sem digitar):

```powershell
adb shell am start -n dev.selfstreamdeck/.MainActivity `
  --es url "http://127.0.0.1:7878/?token=<token>" `
  --es wifi "https://<IP>:7879/?token=<token>&fp=<impressão digital>"
```

O botão **Bloquear tela** usa o papel de administrador do aparelho, só com a política `force-lock` (`res/xml/device_admin.xml`); ele precisa ser desativado em *Configurações → Segurança → Apps administradores* antes de desinstalar o app.

## Estrutura do código

| Pasta | O que tem |
|---|---|
| `agent/crates/core` | a lógica sem Windows: `guard` (Host, token, bloqueio), `config`, `ports` (um trait por parte do PC e um `Fake*` de cada), teclas, macros, energia… |
| `agent/crates/api` | o HTTP (axum): o fluxo do pedido, as rotas, os eventos SSE, os arquivos estáticos (o painel embutido) |
| `agent/crates/platform-windows` | os adaptadores: Core Audio, SMTC, teclas, barra de tarefas, janelas, energia, monitor, notificações, câmera virtual, rede. É onde fica o `unsafe` da API do Windows |
| `agent/crates/agent` | o programa `ssd`: argumentos, bandeja, `diagnose`, atualização, HTTPS do Wi-Fi e do iPhone |
| `web/src` | `api/` (cliente gerado do contrato), `features/` (uma pasta por assunto), `shell/` (abas, menu, barra offline), `lib/` |
| `android/app/src/main` | `MainActivity.kt`, `Connection.kt`, `LockAdmin.kt` |

Mais em [ARQUITETURA.md](ARQUITETURA.md) e nas [decisões](adr/README.md).
