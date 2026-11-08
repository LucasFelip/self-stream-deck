# web/: a interface nova (React + TypeScript)

Substituiu, página por página, a interface antiga (já apagada) ([ADR 0002](../docs/adr/0002-interface-react-typescript-pwa.md), [plano](../docs/plano-reestruturacao.md), Fase 2).
O agente serve o build em **`/`**; a interface antiga foi removida. Ela é uma PWA e usa a mesma API da antiga, descrita em
[`contracts/openapi.yaml`](../contracts/openapi.yaml).

## Comandos

```bash
cd web
npm install
npm run dev          # Vite em http://127.0.0.1:5173/ com /api repassado ao agente em 127.0.0.1:7878 (o cookie de pareamento vale para o localhost)
npm run build        # tsc + vite build -> web/dist (o agente serve em /)
npm run gen:api      # tipos do contrato -> src/api/schema.d.ts
npm test             # gen:api + tsc --strict + ESLint + Vitest
npm run test:e2e     # build + testes em navegador sem tela (e2e/shell, apps, sound, pc, windows, extras, editor, camera, chrome e layout)
```

`node tools/check.js` (na raiz) roda isso junto com o resto; `--ci`/`--full` incluem o navegador.

## Como está organizado

```
src/
├─ api/        client.ts (openapi-fetch tipado pelo contrato), events.ts (SSE: LiveHub + useLiveQuery), schema.d.ts (gerado)
├─ lib/        format, haptics, android (ponte tipada), back (pilha do botão Voltar), latestWins (um pedido por vez, vale o último)
├─ ui/         Icon, Toast, Sheets (#modal-root), HoldButton, RangeSlider, Segmented
├─ shell/      Pager (scroll-snap, retrato/paisagem), Nav (trilho/barra), Menu, Offline, connection
├─ features/   uma pasta por página: deck/ (Apps e Atalhos), editor/ (modo Editar e editor), camera/, idle/, game/, notices/, power/, sound/, pc/ e windows/
└─ styles/     style.css e pages.css, copiados sem mudança da interface antiga; v2.css só com o que é novo
e2e/           testes em navegador (servidor falso e navegador sem tela em harness.cjs); support.cjs tem os toques repetidos até pegar
```

## Regras desta migração

- **Mesmo DOM, mesmas classes e ids.** O CSS é o da interface antiga, e os testes em navegador são os dela portados: o que a antiga prometia (alvos de 48 px, grade, trilho/barra por orientação) a nova também cumpre, medido pelos mesmos seletores.
- **Dados do servidor vêm do contrato.** Um caminho ou corpo que o OpenAPI não conhece não compila; `useLiveQuery` junta o evento SSE e a rota GET do mesmo objeto.
- **Nada global.** O que a antiga pendurava em `Deck` virou módulo ou contexto. Só `window.Deck = { back, vibrate }` continua, porque o `MainActivity` chama `Deck.back()`.
- **Paridade primeiro.** Tudo o que a antiga faz a nova faz (páginas, modo Editar, editor, câmera, escurecer, notificações, FPS, pareamento); a troca de `/` só vem depois do teste no aparelho real. O menu ⚙ mantém "Interface antiga" até lá.

## Página migrada: Energia

Teclas, linha de estado, contagem regressiva do agendamento, folha de confirmação com "segure para confirmar" e atraso/forçar.
Os testes `e2e/shell.e2e.cjs` portam os da antiga (teclas sem descrição, Hibernar oculto, uma linha de estado, nada chega ao PC sem a confirmação) e acrescentam o que a
migração pegou: o toque que termina o "segure" não clica mais na aba que está debaixo da folha (defeito que também existia na antiga e foi corrigido nas duas).
