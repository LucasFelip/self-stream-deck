# 0008. Spike do agente em Rust: portão de decisão

Estado: **aceito** (portão da Fase 3.0 passou: seguir com Rust).

## Contexto

O [ADR 0001](0001-agente-em-rust.md) escolheu Rust para o agente com um portão: provar, fora do produto, os três pontos de maior risco antes de portar o resto.
O código está em `agent/spike/` e só **lê**: nunca muda volume, dispositivo padrão nem player.

## O que foi provado (neste PC, Windows 11, Rust 1.99, crate `windows` 0.58)

| Ponto | Resultado | Tempo |
|---|---|---|
| Core Audio: volume e mudo da saída padrão, sessões de áudio (mixer por app) | funciona (`IAudioEndpointVolume`, `IAudioSessionManager2`) | 11 ms |
| Trocar o dispositivo padrão | o objeto `PolicyConfigClient` (interface não documentada, a mesma que o C# usa) **é criado**; a chamada exige uma vtable escrita à mão (`IPolicyConfig::SetDefaultEndpoint`) | só criação testada |
| SMTC (mídia tocando agora): sessões, título, estado, controles | funciona direto pelo WinRT (`Windows.Media.Control`), sem `dynamic`/reflexão | 12 ms |
| `SetWinEventHook`: primeiro plano, criar, destruir e renomear janela | ganchos instalados com laço de mensagens; o callback conta eventos | – |

## Decisões

- **Alvo `x86_64-pc-windows-gnu`.** Não há Visual Studio neste PC, mas há o `gcc` do MinGW; o `windows` compila e liga com ele. Se um dia houver MSVC, o código é o mesmo.
- **`windows` (windows-rs) em vez de helpers C#.** Menos processos (hoje são 4 `ssd-helper.exe` de 30 a 65 MB cada) e sem o custo do `dynamic` (as notificações em C# gastaram 35 % de um núcleo até virarem reflexão).
- **O que ainda não foi provado** e fica para o item certo da Fase 3.2: RTSS/Afterburner e `nvidia-smi` (monitor, ordem 8), DDC/CI (janelas e telas, ordem 9) e a câmera virtual (ordem 11, que pode ficar no helper C# por mais tempo, como o plano já previa).
- Gatilho de saída do plano mantido: se a ordem 9 passar de 2x a estimativa, reavaliar a D1.

## Depois do spike

A vtable de `IPolicyConfig` foi escrita (`platform-windows/src/audio.rs`) e trocar o dispositivo padrão funciona (conferido definindo o padrão atual como ele mesmo); o áudio inteiro foi portado e comparado com o Node.

## Consequências

- Rust instalado em `~/.cargo` (stable, alvo gnu); `agent/` é um workspace Cargo; `tools/check.js` roda `cargo test` quando `agent/Cargo.toml` existe.
- O agente novo nasce com um **proxy de transição** para o Node (plano 3.1), então nada precisa ser portado de uma vez.
