# 0011. Regras de automação

Estado: **aceito**.

## Contexto

Com os webhooks (0010) o painel recebe efeitos de fora. Falta o caminho inverso: o próprio agente reagir ao que acontece no PC (CPU alta, mídia
tocando, uma janela, uma notificação, um horário) e mexer no painel sem o usuário tocar em nada.

## Decisão

1. Regras ficam em `rules` no `config.json`: `id`, `enabled`, uma condição (`when`), `for` (segundos que a condição precisa durar), `cooldown`
   (minutos), `whileActive` e uma ação.
2. A avaliação é uma **máquina de estados pura** em `core/rules.rs`, com relógio injetado, sem I/O; as condições leem as portas que já existem
   (`MonitorPort`, `MediaPort`, `WindowsPort`, `NotificationsPort`).
3. A regra só termina depois de 4 s sem a condição (não oscila); `whileActive` desfaz o efeito quando ela termina.
4. As **ações da v1** são as mesmas do webhook: `goto`, `notify` e `push`. Regra que age sobre o PC (abrir app, atalho, energia) fica fora até
   existir um modelo de confirmação.
5. A tarefa de avaliação (1 s) só roda se houver regra habilitada.
6. Editar uma regra encerra a versão antiga e começa a nova; `POST /api/rules/pause` pausa todas.

## Consequências

- Sem regras habilitadas o custo é zero.
- A lógica é testável sem Windows e sem `sleep`.
- O editor no celular vem depois da edição pelo `config.json`, no mesmo molde do editor de macros.
