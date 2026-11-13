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

### Adicionado

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
