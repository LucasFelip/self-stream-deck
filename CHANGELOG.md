# Changelog

O que mudou em cada versão, para quem usa. O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem o
[Versionamento Semântico](https://semver.org/lang/pt-BR/): enquanto for `0.x`, uma versão menor (`0.2.0`) pode mudar o `config.json` ou a API; uma
de correção (`0.1.8`) nunca. A versão é uma só para o agente, o painel e o app Android (`agent/Cargo.toml`; `tools/version-check` confere).

Como publicar uma versão: [docs/desenvolvimento.md](docs/desenvolvimento.md#publicar-uma-versão).

## [Não lançado]

### Segurança

- O editor do celular não aceita mais tecla que escreve sozinha (letra, número, Enter, Espaço): um atalho ou passo de macro precisa de Ctrl, Alt ou
  Win, ou ser uma tecla que não escreve (F5, setas, mídia). Em sequência, essas teclas digitavam um comando. `"typingKeys": true` no `config.json`
  (só no PC) libera.
- O token de pareamento e a senha dos certificados vêm do gerador do sistema operacional.
- O token saiu do `server.log`. O comando novo `ssd pair` mostra os links de pareamento.
- O agente roda como administrador e não executa nem confia mais em nada que esteja em pasta gravável por um programa comum: os scripts dos
  certificados não passam por `%TEMP%`, a atualização é baixada e instalada a partir de `update\` ao lado do `ssd.exe`, e a atualização automática
  só aceita o certificado do próprio agente (`update.signer` vale apenas para `ssd update --apply`).
- A DLL da câmera virtual fica travada contra troca entre a conferência e o registro.
- O `?token=` no endereço só vale no link de pareamento, nos arquivos do painel e no `/api/ping`. Em qualquer outra rota o token vai no cabeçalho ou no cookie (endereços vão para logs).

### Adicionado

- **Visual: player de Som maior**: na paisagem a capa, o título e o botão de tocar crescem com a altura da tela (a capa vai de 64 a 96 px), com sombra na capa e o nome do app em destaque; em pé o player continua fino.
- **Visual: grade de Apps cheia**: na paisagem a grade tem 7 colunas e só as linhas de que as teclas (e o espaço livre) precisam, no mínimo 2, então uma dúzia de apps ocupa duas fileiras com teclas grandes; os espaços vazios só aparecem ao editar ou quando uma tecla arrastada passa por cima.
- **Visual: tom nos botões**: cada botão de app ganha um tom suave tirado da cor do seu ícone (e o de atalho, de uma cor fixa feita do seu nome); nas ações de Energia, as que terminam a sessão ou desligam o PC ganham um fundo amarelo ou vermelho suave.
- **Visual: cor por leitura** (plano em [docs/plano-visual.md](docs/plano-visual.md)): CPU, memória, GPU, disco e rede ganham cada uma a sua cor (título, barra, gráfico e núcleos; o amarelo e o vermelho de alerta continuam vencendo), números maiores em PC e os percentuais de Som mais legíveis, e linhas-guia nos gráficos. Um teste confere o contraste das cores.
- **Demonstração no navegador**: o painel de verdade com dados de mentira, sem PC, publicada pelo GitHub Pages (`pages.yml`); uma barra no topo experimenta os webhooks. `npm run build:demo`, [docs/desenvolvimento.md](docs/desenvolvimento.md#a-demonstração-no-navegador).
- **Agente compila para Linux** (spike, [ADR 0013](docs/adr/0013-agente-em-linux-spike.md)): o que é do Windows ficou atrás de `cfg(windows)` e há um monitor do Linux (`/proc`). **Não é suporte**: nada foi executado num Linux e o Wi-Fi com HTTPS não existe lá.
- **App Android com vários PCs** ([guia](docs/guia-de-uso.md#vários-pcs)): a lista *Meus PCs* guarda todos os PCs pareados, com *Usar* e *Esquecer*; o cabo vence (o PC do cabo vira o ativo) e sem cabo só o Wi-Fi do PC ativo é tentado. O pareamento de antes vira o primeiro da lista.
- **Releases com proveniência**: o MSI, o APK e o `SHA256SUMS.txt` levam uma atestação do Sigstore (`gh attestation verify`), e a release traz os manifestos do winget (`winget validate` passa) prontos para submeter. `SSD_REQUIRE_SIGNED_APK=true` impede uma release com o APK de depuração.
- **USB sem comando** ([docs/usb.md](docs/usb.md)): com `"usb": { "auto": true }` o agente faz o `adb reverse` sozinho quando o celular é plugado (só executa um `adb` em pasta que um programa comum não grava, já que roda como administrador), e `ssd usb` mostra o que ele vê. `ssd update --apk` (ou `"update": { "apk": true }`) atualiza o app Android pelo cabo, no lugar, e nunca desinstala; o manifesto ganhou o campo `apk`.
- **Regras de automação** ([docs/regras.md](docs/regras.md)): na chave `rules` do `config.json`, "quando a CPU passar de 90 % por 15 s, avise", "enquanto uma música toca, abra a página Som", janelas de horário. Só mexem no painel (trocar de página, avisar, guardar um valor). PC › Painel mostra as regras, quais valem agora e pausa e retoma.
- **Webhooks** (`/api/hook/*`, [docs/webhooks.md](docs/webhooks.md)): scripts, CI e Home Assistant mostram um aviso no painel, trocam a página, recarregam e deixam valores (com tempo de vida) que aparecem em PC › Painel. Têm uma chave própria (`webhookKey`, `ssd webhook`, e a bandeja), que não abre nada fora deles.
- Apps da Microsoft Store e empacotados (MSIX), como o Claude, aparecem com o ícone certo e o painel sabe quando estão abertos.
- O painel avisa quando uma tela para de funcionar, em vez de ficar preto, e oferece recarregar.
- O editor de botões pergunta antes de descartar alterações não salvas.
- O `server.log` ganhou uma trilha de auditoria: energia, macros, editor, câmera, abrir app e atalhos deixam uma linha com quem pediu e o resultado.
- As mensagens de erro do painel saem em português ("o PC não respondeu" em vez de "Failed to fetch") e ficam mais tempo na tela.
- Releases versionadas: uma tag `vX.Y.Z` publica o MSI e o APK com as notas deste arquivo.
- App Android: Gradle Wrapper, build de release (assinado quando a chave está no ambiente), lint e testes da lógica de pareamento.

### Alterado

- Uma versão só para agente, painel e app Android.
- Os source maps do painel não vão mais dentro do `ssd.exe` (1 MB a menos).
- CI: actions fixadas por commit, SHA-256 do WiX, tipos do contrato conferidos, auditoria de dependências (`cargo deny`, `npm audit`) e
  Dependabot. Toolchain do Rust fixado numa versão exata.

## [0.1.7] - 2026-11-10

### Alterado

- Câmera do celular: 720p por padrão, teto de 30 ou 60 fps, envio dos quadros em paralelo e medições na linha de status.

## [0.1.6] - 2026-11-10

### Corrigido

- Câmera virtual: conta como instalada onde o Windows a registrou; depois de mudar a pasta de dados, os quadros eram descartados.

## [0.1.5] - 2026-11-10

### Adicionado

- Botão **Bloquear tela** também na faixa de "PC desconectado" (só dentro do app Android).
- App Android: testa os endereços antes de abrir o painel, com telas "Conectando" e "Sem conexão" no visual do painel e nova tentativa automática.

## [0.1.4] - 2026-11-10

### Adicionado

- O agente volta sozinho depois de uma queda.
- Botão **Bloquear tela** no app Android (administrador de dispositivo, restrito a bloquear).
- App Android: relógio pequeno na lateral do painel.

## [0.1.3] - 2026-11-10

### Adicionado

- Atualização do agente: `ssd update`, verificação diária opcional, canais, SHA-256 e assinatura pelo mesmo certificado do agente.
- Instalador MSI (WiX 3.14): instala em Arquivos de Programas, registra a tarefa de início e mantém os dados em `%APPDATA%`.

### Corrigido

- Depois de uma atualização iniciada pelo próprio agente, o agente novo não subia; o instalador agora agenda um início único.

## [0.1.0] a [0.1.2] - 2026-11-08 a 2026-11-10

A reestruturação ([plano](docs/plano-reestruturacao.md), [retrospectiva](docs/retrospectiva.md)). Essas versões não foram marcadas uma a uma.

### Alterado

- Agente do PC reescrito em Rust (era Node), com a interface dentro do executável, ícone na bandeja e `ssd diagnose`.
- Painel reescrito em React + TypeScript, com os tipos gerados do contrato OpenAPI.
- App Android reescrito em Kotlin.
- Contrato da API em `contracts/openapi.yaml`, conferido contra o agente a cada verificação.

## Antes de 0.1.0 - 2026-10-19 a 2026-11-07

O protótipo em Node: painel de apps, atalhos, som, janelas, PC e energia; editor de botões e macros; acesso por Wi-Fi com certificado fixado;
câmera do celular como webcam; notificações do Windows; redesign por orientação (trilho em paisagem, barra em retrato); suporte ao iPhone.

[Não lançado]: https://github.com/LucasFelip/self-stream-deck/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/LucasFelip/self-stream-deck/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/LucasFelip/self-stream-deck/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/LucasFelip/self-stream-deck/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/LucasFelip/self-stream-deck/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/LucasFelip/self-stream-deck/releases/tag/v0.1.3
