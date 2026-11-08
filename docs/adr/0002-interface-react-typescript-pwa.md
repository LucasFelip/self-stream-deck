# 0002. Interface em React + TypeScript, como PWA

Estado: **aceito**.

## Contexto

A interface (`public/`, ~4,5 mil linhas de JS e ~1,1 mil de CSS) é feita de scripts que compartilham o namespace global `Deck`, sem tipos nem módulos.
Ela é servida pelo próprio agente, então mudar a interface não exige recompilar o APK, e o iPhone a usa pelo Safari sem conta de desenvolvedor.

## Decisão

**React + TypeScript (`strict`) + Vite**, instalável como PWA e servida pelo agente. Estado do servidor com TanStack Query; estado local simples
(Zustand ou contexto); tokens de CSS atuais (`--touch`, `--rail-w`, `--bar-h`, `--safe-*`) mantidos; testes com Vitest e Playwright.

## Alternativas

| Opção | Por que não |
|---|---|
| Angular | Pesado para um painel desse tamanho; só se o objetivo fosse estilo corporativo |
| Flutter | Perde a interface servida pelo PC e o iPhone sem instalar; no iOS exigiria Mac, Xcode e assinatura |
| Kotlin + Swift nativos | Dois códigos para um controle remoto de botões e sliders |
| Svelte / Solid | Mais leves; ficam como opção se o React pesar no celular (meta: < 250 kB gzip) |

## Consequências

- A interface vira módulos tipados; a API é consumida por um cliente gerado do OpenAPI (ADR 0003).
- Migração página por página, com a antiga e a nova lado a lado até a paridade (ADR 0007).
- O comportamento medido hoje (grade do Apps, trilho/barra por orientação, alvos de 48 px) é requisito, protegido pelos testes de layout nos 4 viewports.

## Emenda (Fase 2)

- **Testes em navegador:** em vez de Playwright, a interface nova reaproveita o harness por DevTools Protocol e o servidor falso da antiga (`legacy/server/test/ui/harness.js`), com os mesmos seletores. Assim os casos da antiga são portados quase sem mudança e o contrato valida as respostas do servidor falso. Playwright continua possível depois que a antiga sair.
- **CSS:** `style.css` e `pages.css` foram copiados sem mudança para `web/src/styles/`; reescrevê-los fica para depois da paridade, para não misturar risco visual com a troca de tecnologia.
- **Peso medido:** a primeira fatia (casca + Energia) gera 215 kB de JS (70 kB gzip) e 9,5 kB gzip de CSS, dentro da meta de 250 kB gzip.
