# Plano de qualidade do código

Objetivo: deixar o que já existe mais fácil de entender, mudar e testar, **sem criar funcionalidade nova** e sem mudar o que o usuário vê.
Regra de ouro: cada fase termina com `npm run check` verde e o app funcionando no celular; nenhuma fase depende de refazer a seguinte.

## Situação

Todas as fases foram feitas. Onde o resultado difere do plano:

- **Fase 1:** o workflow do GitHub Actions **não foi criado** (decisão do dono do projeto); `npm run check` roda tudo localmente. A verificação de tipos com `tsc` foi adiada.
- **Fase 3:** `app.js` foi de 959 para 45 linhas (8 módulos novos), mas `windows.js` (642), `editor.js` (357) e `monitor.js` (354) seguem acima de ~350 linhas.
- **Fase 4:** `DeckNative` e `VCam` têm uma só cópia; `monitor` e `media` são portes do PowerShell, não cópias, e a paridade é testada.
- **Achados pelos testes e corrigidos no caminho:** tecla inválida no editor devolvia 500 (agora 400); reiniciar o helper fazia o push de janelas parar (agora é retomado).

## 1. Diagnóstico (medido no código, antes das fases)

| Achado | Número | Por que importa |
|---|---|---|
| `public/app.js` mistura 8 assuntos (botões, arrastar, cabeçalho, volume, conexão, páginas, abas, autoatualização) | 959 linhas, 27 variáveis de estado soltas no mesmo escopo | Qualquer mudança pode quebrar outra parte; é onde mais tivemos regressão |
| `src/routes.js` junta tabela de rotas, montagem de respostas, produtores de eventos, macros e editor | 676 linhas | Não dá para testar uma rota sem subir tudo; difícil achar onde mexer |
| Código C# **duplicado**: `DeckNative` está dentro de `input-host.ps1` e em `native/DeckNative.cs`; o `VCam` também está nos dois | ~650 linhas duplicadas | Corrigir um e esquecer o outro (já quase aconteceu na correção da câmera invertida) |
| `catch { }` vazio (erro engolido) | 36 | Falhas somem sem rastro; já custou diagnóstico (servidor caindo sem motivo) |
| Cópias do mesmo helper em vários arquivos (`post`, `fail`, padrões de consulta com `inFlight`) | 3 + 4 | Ajuste em um lugar não chega nos outros |
| Testes cobrem lógica pura (geometria, macros, eventos, câmera) e comparação de helpers, mas **não** `http.js`, `security.js`, `config.js`, `taskbar.js`, `host.js`, validações das rotas, nem a interface | 846 linhas de teste para ~4.700 de código | A segurança e a interface, as partes mais sensíveis, não têm rede de proteção |
| Os testes de comparação dos helpers dependem do estado real do PC (áudio, mídia) | 1 arquivo | Não rodam de forma confiável em CI |
| Sem lint, sem verificação de tipos, sem CI | 0 | Erros bobos só aparecem no celular |
| Constantes mágicas (intervalos, limites) espalhadas | ~25 | Ajustar desempenho exige caçar números |

## 2. Princípios

1. **Rede de proteção antes de mexer.** Primeiro testes de interface e de segurança; só depois dividir arquivos.
2. **Mudança pequena e verificável.** Uma fase = um conjunto de commits que o `npm run check` e o celular aprovam.
3. **Zero dependência em produção.** Ferramentas de qualidade (lint, tipos) entram só como `devDependencies`; o servidor continua sem `node_modules`.
4. **Nada de reescrever por gosto.** Só dividir, nomear e testar; comportamento idêntico (os testes de comparação e o uso no celular provam).

## 3. Fases

### Fase 0 — Rede de proteção (S/M)
- **Testes de interface** em `test/ui/`: um servidor falso (`fake-server.js`) serve `public/` com respostas e eventos de mentira; um navegador sem tela (Chromium/Brave/Chrome, caminho por `CHROME_PATH`) é controlado por CDP puro (sem dependências).
  Casos: 6 abas navegam; grade de Apps renderiza; arrastar troca dois botões e chama `POST /api/layout`; lista de janelas reage a um evento; editor abre; macro roda e mostra o aviso; modo offline mostra o indicador.
- **Testes de segurança do servidor** (sem Windows): `security.js` (token, bloqueio, Host, origem), `http.js` (cabeçalhos, ETag/304, caminho fora de `public/`, JSON inválido), `config.js` (BOM, `update` atômico, não sobrescrever arquivo ilegível).
- **Aceite:** esses testes passam hoje, antes de qualquer refatoração (caracterizam o comportamento atual).

### Fase 1 — Ferramentas e CI (S)
- `.editorconfig`; ESLint (flat config) com `no-empty`, `no-unused-vars`, `no-undef`, regra que exige comentário em `catch` vazio; `npm run lint`.
- Verificação de tipos por JSDoc: `// @ts-check` + `jsconfig.json`, `tsc --noEmit` (typescript só como devDependency), começando por `src/`.
- **GitHub Actions** (`windows-latest`): instala, `lint`, testes unitários, compila o helper nativo, roda os testes de interface. Testes que precisam de áudio/mídia reais ficam em `npm run test:integration` (local), fora do CI.
- Separar scripts: `test` (unitário, rápido), `test:ui`, `test:integration`, `check` (tudo local).
- **Aceite:** o CI roda verde em um push; lint sem avisos.

### Fase 2 — Servidor em módulos (M)
- Quebrar `routes.js` em `src/routes/*.js` (um por assunto: `apps`, `shortcuts`, `macros`, `editor`, `audio`, `media`, `monitor`, `power`, `windows`, `camera`, `events`), com `createRoutes(config, deps)` como fachada e `deps` injetável (`system`, `media`, `monitor`...). Erros HTTP e validadores comuns em `src/http-errors.js` e `src/validate.js`.
- Produtores de eventos saem de `routes` para `src/producers.js`.
- **Testes:** validações de cada rota (entradas ruins recusadas, ids desconhecidos 404) rodando com `deps` falsos, sem Windows.
- **Aceite:** nenhum arquivo de `src/` com mais de ~300 linhas; todas as rotas antigas respondem igual (comparação de respostas antes/depois por script).

### Fase 3 — Interface em módulos (M/L)
- Dividir `app.js` em arquivos por responsabilidade sob o mesmo namespace `Deck` (sem empacotador, sem módulos ES, para não mudar o carregamento): `tiles.js` (itens e grade), `arrange.js` (segurar e arrastar), `header.js` (microfone, player, menu, pílula de energia), `volume.js`, `connection.js` (online/offline, push, reconexão), `pager.js` (páginas e abas), `reload.js` (autoatualização). `app.js` vira só a montagem.
- Utilitários comuns em `deck.js`: `Deck.post`, `Deck.fail`, constantes de tempo em um só lugar (`Deck.timing`).
- Cada módulo recebe só o que precisa (sem ler variável solta dos outros).
- **Aceite:** nenhum arquivo de interface com mais de ~350 linhas; os testes de interface da Fase 0 passam sem mudar; o `load-check` carrega todos os módulos.

### Fase 4 — Uma fonte só para o C# (M)
- `scripts/input-host.ps1` e `vcam-host.ps1` passam a compilar o C# de `native/*.cs` (via `Add-CachedType` a partir do arquivo) em vez de manter uma cópia embutida. O PowerShell fica só com o laço de leitura/resposta.
- Ampliar `native-parity.test.js` com operações de escrita inofensivas (definir o mesmo volume, mudo desligado→desligado) e com os erros esperados.
- **Aceite:** `grep` não encontra mais classe duplicada; testes de comparação verdes; cair no fallback PowerShell (forçado por variável de ambiente) continua funcionando.

### Fase 5 — Erros e configuração (M)
- Substituir `catch {}` vazios por uma função `ignore(motivo)` (ou log de nível baixo) para que cada exceção ignorada diga por quê; manter só os realmente inofensivos, com comentário.
- **Helper que trava:** reinício imediato e uma nova tentativa para leituras (nunca para ações), com o motivo no log.
- **Configuração:** validar na carga e ao salvar (tipos, UTF-8 sem caracteres de substituição, ids únicos), manter cópia `config.json.bak` a cada gravação e recusar gravar texto inválido (o problema do acento que apareceu uma vez).
- Registro de log com níveis (`info`, `warn`, `error`) e prefixo por módulo no lugar de `console.log` solto.
- **Testes:** helper morrendo no meio de um pedido; configuração corrompida; restauração da cópia.

### Fase 6 — Documentação e convenções (S)
- Dividir o README: guia de uso (o que existe hoje) e `docs/ARQUITETURA.md` (helpers, eventos, segurança, estrutura de pastas).
- `CONTRIBUTING.md` curto: como rodar `lint`, `test`, `test:ui`, como adicionar uma rota, uma página, uma operação do helper.
- Comentário de cabeçalho em cada módulo novo dizendo o que ele faz e o que NÃO faz.

## 4. Ordem, esforço e riscos

| Ordem | Fase | Esforço | Risco | Observação |
|---|---|---|---|---|
| 1 | 0 Rede de proteção | M | baixo | Sem ela, as fases 2 e 3 são arriscadas |
| 2 | 1 Ferramentas e CI | S | baixo | Pode ser feita junto com a 0 |
| 3 | 2 Servidor em módulos | M | médio | Respostas comparadas antes/depois |
| 4 | 3 Interface em módulos | M/L | médio-alto | É onde há mais histórico de regressão; só com os testes de interface prontos |
| 5 | 4 Uma fonte para o C# | M | médio | Fallback PowerShell precisa continuar funcionando |
| 6 | 5 Erros e configuração | M | baixo | Ganho direto de diagnóstico |
| 7 | 6 Documentação | S | nenhum | |

Tamanho: S ≈ meio dia, M ≈ um dia, L ≈ um dia e meio de trabalho contínuo.

## 5. O que fica de fora de propósito
- Trocar para TypeScript ou para módulos ES / empacotador (muda o carregamento e o Android).
- Mudar o protocolo dos helpers ou as rotas da API (o celular e os testes dependem deles).
- Reescrever a interface visual.

## 6. Decisões que dependem do dono do projeto
1. Aceitar `devDependencies` (ESLint, TypeScript) só para desenvolvimento e CI? (produção continua sem dependências)
2. Ligar o GitHub Actions no repositório?
3. Manter o fallback PowerShell dos helpers, ou removê-lo depois de um tempo de uso estável do nativo?
