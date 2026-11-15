# 0013. Agente em Linux: o que o spike mostrou

Estado: **aceito como resultado de um spike**. Não é uma promessa de suporte a Linux.

## Contexto

O phonebox roda em Windows, Linux e macOS. Este projeto é só Windows, mas o agente foi desenhado com portas (`ssd-core/ports.rs`): a lógica fala com traits e cada sistema entrega os adaptadores. A pergunta do spike: **quanto desse desenho vale fora do Windows?**

## O que foi feito

- `ssd-core` e `ssd-api` já compilavam para `x86_64-unknown-linux-gnu` **sem nenhuma mudança** (verificado com `cargo check --target`).
- O `ssd-agent` (o programa) não compilava: dependia do Schannel (`native-tls`), da bandeja, do `diagnose` e do `lan.rs` do Windows. Agora o que é do Windows fica atrás de `#[cfg(windows)]` (`lan`, `tray`, `native-tls`) e há um `diagnose_unix.rs` portátil. **No Windows nada mudou** (os mesmos testes passam).
- Um crate novo, `ssd-platform-linux`, com o monitor lido do `/proc` (CPU total e por núcleo, memória, uptime, nome do processador e do sistema). Os *parsers* são texto-para-número (`procfs.rs`) e têm testes que rodam em qualquer sistema; só o `LinuxMonitor` toca o `/proc`, e só no Linux.
- Com `--fake-platform`, o agente compilado para Linux responde a API inteira, como no Windows.

## O que o spike **não** provou

- **Nada foi executado num Linux.** Houve compilação cruzada (`check` e `clippy` para `x86_64-unknown-linux-gnu`), não execução: não havia um Linux neste ambiente. O `LinuxMonitor` está coberto só pelos testes dos parsers.
- Sem HTTPS pelo Wi-Fi: o `lan.rs` depende do Schannel e de certificados feitos por PowerShell. No Linux só o USB (`127.0.0.1`, pelo `adb reverse`) existe.
- Os testes de contrato e o `agent-check` rodam o `ssd.exe` do Windows; o do Linux não passou por eles.

## O que falta para um agente de verdade (estimativa)

| Parte | Como | Estimativa |
|---|---|---|
| Áudio (volume, dispositivos, mixer) | `wpctl` / `pactl` | M |
| Mídia (o que toca, controles) | MPRIS via `playerctl` ou D-Bus | M |
| Entrada de teclas (atalhos, macros) | `uinput` ou `xdotool`/`ydotool` (muda entre X11 e Wayland) | M |
| Energia (bloquear, suspender, desligar) | `loginctl` / `systemctl` | S |
| Monitor completo (GPU, discos, rede, processos) | `/sys`, `nvidia-smi`, `statvfs` | M |
| Relógio local das regras | uma porta de relógio (`ClockPort`) com `localtime` | S |
| Wi-Fi com HTTPS | gerar o certificado por dentro (um crate como `rcgen`) e um TLS que não seja o Schannel | L |
| Serviço e instalação | uma unidade `systemd --user`, em vez da tarefa agendada | S |
| Janelas, barra de tarefas, câmera virtual, notificações | sem equivalente direto: ficam desligadas | , |

Janelas, barra de tarefas, câmera virtual e notificações do Windows não têm contrapartida simples: como "um módulo sem porta responde 404" já é regra do agente, essas páginas somem no painel em vez de quebrar.

## Decisão

Manter o código como está (o agente do Linux compila e a base serve de ponto de partida) e **não anunciar suporte**. Se um dia houver vontade de ter o agente no Linux, o caminho é por ordem de valor: monitor (feito), energia, áudio, mídia, teclas, e só então o Wi-Fi com HTTPS.

## Consequências

- Quem mexer no agente precisa manter o que é do Windows atrás de `cfg(windows)`: `cargo check --target x86_64-unknown-linux-gnu -p ssd-agent` mostra se algo vazou (o `build.yml` roda isso).
- O alvo `x86_64-unknown-linux-gnu` do Rust (só a biblioteca padrão) precisa estar instalado para a verificação local (`rustup target add x86_64-unknown-linux-gnu`).
