# Decisões de arquitetura (ADRs)

Cada arquivo registra uma decisão: o contexto, o que foi escolhido, o que foi descartado e o que muda. Para mudar uma decisão, escreva um ADR novo que
a substitua (e marque o antigo como "Substituído por NNNN"); não reescreva o histórico.

| # | Decisão | Estado |
|---|---|---|
| [0001](0001-agente-em-rust.md) | Agente do PC em Rust | Aceito (sujeito ao spike da Fase 3.0) |
| [0002](0002-interface-react-typescript-pwa.md) | Interface em React + TypeScript, como PWA | Aceito |
| [0003](0003-contrato-openapi.md) | OpenAPI como fonte única do contrato | Aceito e em uso desde a Fase 0 |
| [0004](0004-eventos-sse.md) | Tempo real por SSE | Aceito |
| [0005](0005-android-kotlin-iphone-pwa.md) | Android em Kotlin fino; iPhone continua PWA | Aceito |
| [0006](0006-verificacao-local-sem-actions.md) | Verificação local e hook de pre-push, sem GitHub Actions | Substituído em parte por 0009 |
| [0007](0007-migracao-incremental.md) | Migração incremental (strangler) | Aceito |
| [0008](0008-spike-rust-windows.md) | Spike do agente em Rust: portão de decisão | Aceito |
| [0009](0009-ci-no-github-actions.md) | CI no GitHub Actions | Aceito |
| [0010](0010-webhooks-e-eventos-do-painel.md) | Webhooks e eventos do painel, com chave própria | Aceito |
| [0011](0011-regras-de-automacao.md) | Regras de automação | Aceito |
| [0012](0012-agente-e-o-adb.md) | O agente fala com o `adb` | Aceito |
| [0013](0013-agente-em-linux-spike.md) | Agente em Linux: o que o spike mostrou | Aceito (resultado de um spike) |
