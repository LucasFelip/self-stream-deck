# Mexendo no código

Para entender como as peças se encaixam, leia [docs/ARQUITETURA.md](docs/ARQUITETURA.md). Aqui está só o que se faz no dia a dia.

## Rodando

```powershell
cd server
npm install            # só para as ferramentas de desenvolvimento (ESLint); o servidor em si não tem dependências
npm run dev            # servidor reiniciando a cada mudança
npm run lint           # ESLint
npm test               # lógica e servidor, sem Windows nem navegador
npm run test:ui        # a interface em um navegador sem tela (CHROME_PATH aponta outro navegador)
npm run test:integration   # helper nativo x PowerShell, no PC real
npm run check          # tudo isso
```

Antes de abrir um commit, `npm run check` precisa passar. Mudou só texto ou documentação: `npm run lint` basta.

## Convenções

- **Sem dependências no servidor.** `devDependencies` só para ferramentas.
- **Comentários e identificadores em inglês; textos que a pessoa vê em português do Brasil.**
- **Um erro engolido precisa de motivo.** `catch {}` vazio não passa no lint: comente por que é inofensivo ou use `swallow('[tag] o que falhou', err)`
  (`src/log.js`), que registra no nível `debug`. Mensagens do servidor usam `log.info/warn/error` com o prefixo `[tag]`.
- **C# dos helpers é C# 5** (o compilador que vem no Windows): sem `?.`, interpolação de texto, `nameof`, `=>` em membros. Quando ficar em dúvida, compile (`npm run test:integration`).
- **O cliente só dispara o que o servidor lista.** Uma rota nova valida tudo que recebe (ids contra as listas do servidor, números com limites) e devolve 400/404 com um motivo.
- **Não coloque dados da máquina ou pessoais no código nem nos testes** (token, nome do PC, IPs, números de série).

## Adicionar uma rota

1. Escolha o arquivo de `server/src/routes/` pelo assunto (ou crie um e inclua o nome em `MODULES` em `routes/index.js`).
2. Registre com `on('POST', '/api/algo/:id', async ({ req, res, params }) => { ... })`. Use `ctx.system`, `ctx.media`... (nunca `require` o módulo do PC direto: é por `ctx` que os testes trocam por falsos).
3. Valide com `src/validate.js` (`badRequest`, `notFound`, `number`, `percent`) e responda com `sendJson`.
4. Acrescente os casos em `test/routes.test.js` (entrada inválida, id desconhecido, o que chega ao módulo do PC).
5. Se for algo que a interface precisa saber na hora, avalie um tópico novo em `routes/events.js` (o produtor só roda enquanto alguém escuta).

## Adicionar uma página na interface

1. Crie `server/public/js/minha.js` com `Deck.addPage({ id, section, title, el, show, hide })`. `show`/`hide` começam e param o que a página consulta.
   `section` é a aba: uma de `apps`, `shortcuts`, `sound`, `monitor`, `power`, `processes` (as abas ficam em `js/pager.js`).
2. Inclua o script em `public/index.html`, **antes** de `js/tiles.js` (as páginas se registram antes do deck), e na lista de `test/load-check.js`, na mesma ordem.
3. Fale com o servidor por `Deck.api` e, se houver tópico ao vivo, por `Deck.live.watch`.
4. Para algo que vale proteger de regressão, acrescente um caso em `test/ui/deck.ui.test.js` (o servidor falso está em `test/ui/harness.js`).

## Adicionar uma operação a um helper

1. **Nativo:** escreva a operação em `server/native/` (`InputOps.cs`, `MediaOps.cs` ou `MonitorOps.cs`) e registre com `host.On("nomeDaOp", r => ...)`.
2. **PowerShell (plano B):** a mesma operação no `switch` do script do helper em `server/scripts/`. O C# de `DeckNative.cs` e `VCam.cs` é o mesmo nos dois lados: mexa só nos arquivos de `native/`.
3. Exponha em `server/src/system.js` (ou `media.js`/`monitor.js`). Se for **só leitura**, inclua o nome em `retryOps` do `Host` para ser repetida quando o helper morrer no meio. **Ações nunca entram aí.**
4. Acrescente a comparação em `test/native-parity.test.js` (leituras e escritas que não mudam nada), com os dois helpers respondendo igual.
