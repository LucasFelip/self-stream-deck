# Plano de recursos

Objetivo: trazer para o self-stream-deck os recursos que a comparação com o projeto phonebox mostrou que valem a pena (webhooks, regras, demo publicada, `adb` automático, distribuição, vários PCs), sem abrir mão do que o projeto já tem de melhor: contrato OpenAPI, portas e adaptadores com `Fake*`, trilha de auditoria e atualização verificada.

Convenções: contrato primeiro (`contracts/openapi.yaml`, depois `npm run gen:api`); um branch e um PR por fase; commits semânticos; cada fase termina com `node tools/check.js --full` verde, `CHANGELOG.md` atualizado em *[Não lançado]*, `docs-check` passando e `graphify update .` rodado.

## Resumo

| Fase | Entrega | Tamanho | Depende de |
|---|---|---|---|
| 0 | ADRs e decisões de contrato | S | nada |
| 1 | Webhooks com chave própria e restrição do `?token=` | M | 0 |
| 2 | Regras de automação | L | 1 |
| 3 | Demo publicada e testes de interface sobre ela | M | nada |
| 4 | `adb` automático e atualização do APK | M | nada |
| 5 | Distribuição: Scoop, winget, proveniência, lint do Android | M | 4 |
| 6 | Vários PCs no app Android | M | nada |
| 7 | Spike de agente Linux | S | nada |

Ordem de valor: 1, 3, 4, 2, 6, 5, 7. As fases 3, 4 e 6 são independentes e podem andar em paralelo.

## Fase 0: ADRs (S)

- **ADR 0010, webhooks e eventos do painel.** Quem pode chamar, o que pode causar e o que nunca causa. Um webhook só afeta o painel (aviso, ir para página, valor); nunca roda atalho, macro, energia nem abrir app.
- **ADR 0011, regras.** As ações da v1 se limitam aos mesmos efeitos de painel.
- **ADR 0012, o agente fala com o `adb`.** Hoje o `adb reverse` é manual (não há chamada a `adb` em `agent/crates`). Registrar o processo filho, a descoberta do caminho e o efeito no pareamento.
- Atualizar `docs/adr/README.md`.

## Fase 1: webhooks com chave própria (M)

**Objetivo:** scripts, CI e Home Assistant empurram avisos e valores para o painel sem usar o token do celular.

**Contrato primeiro** (depois `npm run gen:api`; o CI já falha se `web/src/api/schema.d.ts` estiver fora de dia):
- `POST /api/hook/notify` com `{title, text, ttl?}`.
- `POST /api/hook/goto/{page}` e `POST /api/hook/refresh`.
- `PUT|POST|DELETE /api/hook/push/{key}` e `GET /api/hook/push`, com `?ttl=` e corpo em JSON ou texto.
- Limites: chave de 1 a 64 caracteres (`[A-Za-z0-9._-]`), no máximo 200 valores, corpo de 8 KB (nova entrada em `body_limit`, `routes.rs`).

**Agente:**
- `core/config.rs`: chave `webhookKey`, gerada como o token (`random::hex(16)`), preservada no `.bak` e na migração.
- `core/guard.rs`: `is_webhook_authenticated`, com `safe_equal`. A chave aceita `Authorization: Bearer`, `x-token` e `?key=` somente em `/api/hook/*`. O token do celular abre tudo; a chave do webhook abre só `/api/hook/*`.
- `api/access.rs`: regra por prefixo depois do Host e do bloqueio por falhas. Falha de chave entra no mesmo `record_failure`; o `Origin` continua valendo.
- `core/push.rs` (novo): `PushStore` com TTL, limites, persistência em `data.json` por rename atômico (mesma regra do `config.json`) e fila de eventos de painel limitada (50) com número de sequência. Lógica pura, com relógio injetado.
- `api/hooks.rs` (novo módulo em `routes::table()`), com linhas de auditoria (`is_audited` ganha o prefixo).
- `api/events.rs`: tópicos `push` e `panel` (`TOPICS` de 9 para 11, com `owned()` e `interval()`). O `panel` entrega eventos com `seq`; quem chega depois só vê os novos.

**Restringir o `?token=` na query:**
- Aceitar só em `GET /` (o link de pareamento, que vira cookie) e em `/api/ping` (o `Probe` do Android). Qualquer outra rota exige cookie ou `x-token`.
- É a mudança de maior risco (PWA do iPhone e app). Verificar antes que o cliente gerado e o `EventSource` mandam o cookie, cobrir no `tools/agent-check` e fazer em commit separado.

**Painel (`web/`):** o aviso entra como toast na feature `notices`; `goto` usa o roteador do `shell`; os valores aparecem num cartão na página PC; o `LiveHub` assina os dois tópicos.

**Operação:** a bandeja ganha "Mostrar chave de webhook" e "Gerar nova chave"; `ssd webhook` imprime um exemplo de `curl`. Documentos: `docs/webhooks.md` (novo), `SECURITY.md`, `docs/configuracao.md`, `docs/rede-e-seguranca.md`.

**Testes:** unitários do `push.rs` (TTL, limite, persistência, chave inválida) e do `guard.rs` (a chave de webhook não abre `/api/audio`); `api/src/tests.rs` e `tools/contract-test/cases.js` para as rotas novas; `tools/agent-check` (sem chave 401, `Origin` estranho 403, 10 falhas bloqueiam o IP); e2e do toast e do `goto`.

**Pronto quando:** `curl -H "Authorization: Bearer <chave>" -d "oi" http://127.0.0.1:7878/api/hook/notify` mostra um aviso no celular, e a mesma chave recebe 401 em `/api/audio`.

## Fase 2: regras (L)

**Objetivo:** "chamada, mostrar a página de som" e "CPU alta por 15 s, aviso", sem tocar no celular.

**Núcleo (`core/rules.rs`, lógica pura):**
- Máquina de estados por regra com `for` (a condição precisa durar), `cooldown`, liberação de 4 s (evita oscilar) e `whileActive` (desfaz o efeito quando a condição acaba).
- Relógio injetado, para testes sem `sleep`.
- Chave do estado pela forma serializada da regra: editar uma regra encerra a versão antiga e começa a nova.

**Condições da v1** (lidas das portas existentes: `MonitorPort`, `MediaPort`, `WindowsPort`, `NotificationsPort`): `cpu-above` (15 s de sustentação por padrão), `media-playing`, `window-title-contains`, `notification-from`, `time-window` (inclui virada de dia, como 22:00 a 06:00; testar horário de verão) e `game-running`, se o `GameInfo` do RTSS fornecer.

**Ações da v1:** `goto`, `notify` e `push` (conforme a ADR 0011), pelos mesmos produtores da fase 1.

**Execução:** tarefa de 1 s criada em `lib.rs`, que só roda se houver regra habilitada; pausa por `POST /api/rules/pause?min=`; config `rules: []` validada como as demais chaves editáveis (tipos, limites e id único).

**Interface em duas etapas:**
- **2a.** Só pelo `config.json`, com `docs/regras.md` e exemplos.
- **2b.** Editor no celular, como o de macros (`web/src/features/editor` e `api/editor.rs`), com limite de corpo de 64 KB e auditoria.

**Pronto quando:** uma regra de CPU dispara depois de 15 s sustentados, não dispara de novo dentro do cooldown, e uma regra `whileActive` devolve o celular à página anterior quando a condição acaba.

## Fase 3: demo publicada (M)

- Entrada `web/demo/` com um shim de `fetch` e `EventSource` que responde a partir de `contracts/fixtures/fake-pc.json` (sem subir o agente no Pages).
- Build em modo `demo` com `--base /self-stream-deck/` e workflow `pages.yml`. Se o deploy falhar logo após o upload, tentar de novo 30 s depois.
- `tools/screenshots` passa a gerar as imagens do README a partir da demo.
- Manter o harness atual de e2e (`web/e2e/harness.cjs`, Chrome por CDP); o ganho é rodar os mesmos testes também contra a demo no CI.
- Os endpoints da fase 1 entram no shim, para `curl` empurrar avisos na demo.
- README: link "Experimente no navegador".

## Fase 4: `adb` automático e atualização do APK (M)

**4a. Túnel automático (`agent/crates/agent/src/adb.rs`):**
- Achar o `adb` (config `adb`, depois PATH, depois `.tools/` e o Android SDK).
- Só com `usb.auto` ligado, a cada poucos segundos: `adb devices` e, para cada aparelho em `device`, `adb reverse tcp:7878 tcp:7878` (idempotente).
- Estado na bandeja e no `ssd diagnose`: aparelho não autorizado, cabo só de energia, `adb` não encontrado.
- O agente roda como administrador: caminho absoluto do `adb` e a mesma regra de confiança de pasta do `update.rs` (nada em pasta gravável por programa comum). O job object já mata os filhos se o agente cair.

**4b. Atualização do APK (`update.rs`):**
- O manifesto ganha `apk: {url, sha256}` por canal, com o mesmo limite de tamanho e SHA-256.
- A versão instalada vem de `adb shell dumpsys package dev.selfstreamdeck`, sem mudar o app.
- `adb install -r`. Se o Android recusar por chave diferente, relatar e nunca desinstalar. APK de depuração e de release têm chaves diferentes, então só vale para release assinada.
- Comando `ssd update --apk`; a atualização automática fica atrás de `update.apk` (padrão desligado).

**Testes:** porta `AdbPort` com `FakeAdb` em `core/ports.rs`; parse da saída de `adb devices`; novas variantes de `UpdateError` testadas.

## Fase 5: distribuição (M)

- **Proveniência:** `actions/attest-build-provenance` no `release.yml`, junto ao `SHA256SUMS`, referenciada por commit como as demais actions.
- **Scoop:** `bucket/` no repositório, com o zip do `package.ps1` como fonte. Antes de prometer, validar como o manifesto chama a instalação e a remoção da tarefa agendada de administrador (hoje no `install.ps1` e `uninstall.ps1`) em `post_install` e `uninstaller`.
- **winget:** manifestos gerados no workflow a partir do `SHA256SUMS`; sem submeter ao `winget-pkgs` enquanto o MSI não for assinado.
- **Lint do Android:** `./gradlew lint` bloqueante no `build.yml`. O `minSdk` é 24: testar o modo imersivo do `MainActivity.kt` em API 24 a 29 (o phonebox teve crash de abertura nessas versões); emulador de API baixa no CI é opcional.
- **APK assinado:** hoje a release cai para APK de depuração sem os secrets. Cadastrar os secrets e falhar sem eles em tags estáveis libera a 4b.

## Fase 6: vários PCs no app (M)

- `Pairing.kt` (puro, testes em `app/src/test`): tipo `Pc(id = fingerprint, nome, hosts, porta, token)` e lista de PCs. Hoje o app conhece até dois endereços do mesmo PC.
- `Connection.kt` e `MainActivity.kt`: lista em `SharedPreferences`, PC ativo, USB sempre vence e vira o ativo, queda de um endereço para outro como hoje.
- **Migração obrigatória** do formato antigo (um endereço e um `wifi`) para a lista, no primeiro uso.
- Tela "Meus PCs" para escolher e esquecer, no estilo do `Palette`, `deckButton` e `Probe`.
- Vários celulares com páginas diferentes ficam fora do escopo (exigem layout por aparelho no agente).

## Fase 7: spike de agente Linux (S)

- Só um spike, no estilo de `agent/spike`: `core` e `api` compilando em Linux com `--fake-platform` e um `platform-linux` com um subconjunto.
- Mapa provável: áudio por `wpctl`/`pactl`, mídia por MPRIS (`playerctl`), monitor por `/proc` e sysfs, energia por `loginctl`.
- Janelas, barra de tarefas, câmera virtual e notificações do Windows não têm equivalente direto e ficam desligadas por design (módulo sem porta responde 404).
- Entregável: uma ADR com o resultado e uma estimativa, sem compromisso de lançamento.

## Riscos e decisões em aberto

1. **Chave de webhook na query (`?key=`):** pode aparecer em logs de quem envia. Fica restrita a `/api/hook/*`, com troca fácil pela bandeja.
2. **Fechar o `?token=` na query:** maior risco de regressão (PWA do iPhone e app); commit separado, fácil de reverter.
3. **Regras com ação sobre o PC** (abrir app, atalho, energia) ficam fora até haver um modelo de confirmação.
4. **Atualização do APK** depende da chave de assinatura de release nos secrets.
