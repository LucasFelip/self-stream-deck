# 0004. Tempo real por SSE

Estado: **aceito**.

## Contexto

O agente empurra mudanças (`windows`, `state`, `audio`, `media`, `monitor`, `game`, `processes`, `power`, `notifications`) só quando mudam, e só enquanto alguém
escuta. Se a conexão não abre, a interface volta a consultar as rotas GET.

## Decisão

Manter **Server-Sent Events** em `GET /api/events?topics=...`. WebSocket só se surgir fluxo nos dois sentidos que compense (por exemplo os quadros da câmera).

## Consequências

- Funciona em HTTP simples, atravessa o `adb reverse` e o Safari sem configuração.
- No React, um hook `useEvents(topics)` com o plano B de consulta herda o comportamento de `live.js`.
- O contrato descreve a carga de cada tópico e o teste de contrato confere o primeiro valor de todos.
