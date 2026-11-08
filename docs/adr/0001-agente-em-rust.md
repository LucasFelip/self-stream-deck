# 0001. Agente do PC em Rust

Estado: **aceito**, sujeito ao portão do spike da Fase 3.0 (Core Audio, SMTC e `SetWinEventHook` em Rust).

## Contexto

O painel é um agente local no Windows (um usuário, na máquina dele) com um controle remoto no celular. A parte difícil é falar com o Windows
(Core Audio, SMTC/WinRT, `SetWinEventHook`, PDH, WMI, DDC/CI, câmera virtual). Hoje isso são ~3,3 mil linhas de Node, ~2 mil de C# compilado em
tempo de execução com o `csc` do Windows (C# 5) e ~1,3 mil de PowerShell como plano B, ligados por um protocolo de JSON por linha.

## Decisão

Reescrever o agente em **Rust** (`axum`, `tokio`, `tracing`, crate oficial `windows`), um único `.exe`, com o Windows isolado atrás de traits
(`AudioPort`, `MediaPort`, `InputPort`, `PowerPort`, `WindowsPort`, `MonitorPort`, `TaskbarPort`, `VCamPort`).

## Alternativas

| Opção | Por que não |
|---|---|
| Spring / JVM | Feito para nuvem e multiusuário; 200 MB ou mais de RAM e um JRE num agente que roda sempre; acesso a COM e WinRT pior que o atual |
| Go | Bom binário e simples, mas COM e WinRT (`go-ole`) são verbosos e frágeis; sobraria um helper nativo. É o plano B |
| .NET (NativeAOT) | Melhor encaixe pragmático no Windows e reaproveita o C#; fica como plano B se o spike do Rust cobrar caro |
| Kotlin / Swift no servidor | Kotlin/Native e Swift no Windows são imaturos; servem para clientes |
| Manter Node + C# + PowerShell | Funciona, mas mantém três linguagens, compilação em tempo de execução e um protocolo entre processos |

## Consequências

- Some o `csc` em tempo de execução, o plano B em PowerShell e o protocolo entre processos.
- Curva de aprendizado maior; a câmera virtual (DirectShow/Media Foundation) é o trecho mais arriscado e pode ficar como componente C# por mais tempo.
- Os testes de contrato (ADR 0003) são a rede de segurança: o agente novo só substitui o antigo rota por rota quando passa neles.
- Gatilho de revisão: o spike da Fase 3.0 falhar em Core Audio, SMTC ou no hook de janelas, ou a Fase 3.2 passar de 2x a estimativa sem fechar "Janelas e telas".
