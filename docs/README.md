# Documentação

Comece pelo [README](../README.md) para a visão geral e o início rápido. Aqui está o resto, na ordem em que costuma ser útil.

## Para quem usa

| Documento | Conteúdo |
|---|---|
| [Instalação](instalacao.md) | instalar, atualizar e remover o agente; onde ficam os arquivos; trazer o pareamento de uma versão anterior |
| [Guia de uso](guia-de-uso.md) | as páginas do painel, o editor de botões, as macros e os controles de energia |
| [Rede e segurança](rede-e-seguranca.md) | USB, Wi-Fi, iPhone, certificados, firewall e o modelo de segurança |
| [Câmera](camera.md) | usar o celular como webcam, a câmera virtual, o OBS e como melhorar o desempenho |
| [Configuração](configuracao.md) | todas as chaves do `config.json`, as portas, os argumentos e as variáveis de ambiente |
| [Solução de problemas](solucao-de-problemas.md) | sintomas conhecidos, a causa e o que fazer |

## Para quem desenvolve

| Documento | Conteúdo |
|---|---|
| [Desenvolvimento](desenvolvimento.md) | preparar o ambiente, compilar, testar, empacotar, assinar e publicar atualizações |
| [Arquitetura](ARQUITETURA.md) | pastas, o fluxo de um pedido, portas e adaptadores, eventos, câmera, consumo e a tabela da API |
| [Contrato da API](../contracts/README.md) | `openapi.yaml`, o PC de mentira e como rodar a verificação |
| [Decisões de arquitetura](adr/README.md) | os porquês: Rust, React, OpenAPI, SSE, Kotlin, sem GitHub Actions |
| [Painel (web)](../web/README.md) | a estrutura do React e como acrescentar uma página |
| [Como contribuir](../CONTRIBUTING.md) | convenções e as receitas do dia a dia |

## Histórico

| Documento | Conteúdo |
|---|---|
| [Plano da reestruturação](plano-reestruturacao.md) | as fases, o que cada uma entregou e os incidentes que apareceram |
| [Retrospectiva](retrospectiva.md) | o antes e o depois, em números, e o que ficou sem fazer |
| [Plano de qualidade](plano-qualidade.md) · [Redesign](plano-redesign.md) | planos anteriores à reestruturação |
| [Referência visual](referencia-visual/README.md) | capturas da interface antiga, para comparação |

## Imagens

As capturas em [`img/`](img/) são geradas a partir de um PC de mentira, sem dados pessoais: `node tools/screenshots/run.cjs` (precisa do painel compilado e de um Chrome, Brave ou Edge).
