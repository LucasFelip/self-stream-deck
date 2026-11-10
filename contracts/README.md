# Contrato da API

`openapi.yaml` é a **fonte única** do que o agente (o agente em Rust) expõe ao celular.
`fixtures/fake-pc.json` descreve o **PC de mentira** que um agente precisa conseguir apresentar para ser testada.

```
contracts/
├─ openapi.yaml            51 operações + os 9 tópicos do SSE (x-events) + esquemas
├─ fixtures/fake-pc.json   apps, janelas, áudio, mídia, monitor, energia... determinísticos
└─ README.md
tools/contract-test/       o verificador (Node, 2 dependências: ajv e yaml)
```

## Rodar

```bash
cd tools/contract-test
npm install        # uma vez
npm test           # o agente em Rust (ssd.exe, precisa de cargo build --release) num PC de mentira (seguro: não toca no Windows)
npm run lint:spec  # só as checagens estáticas do contrato e das fixtures
```

O que o `npm test` confere (hoje 167 verificações):

| Grupo | O que confere |
|---|---|
| spec | o YAML é válido; todo `$ref` resolve; todo esquema compila; toda operação tem `operationId`, tag e 401; as fixtures obedecem aos esquemas; **a lista de rotas do código e a do contrato são a mesma** (rota nova sem contrato quebra o teste) |
| comportamento | ~110 casos: cada rota com entrada boa e entradas ruins (400/403/404/409/413), a resposta validada contra o esquema do status devolvido, o corpo do pedido validado contra o esquema do contrato nos casos 2xx, cabeçalhos documentados presentes |
| eventos | os 9 tópicos do SSE entregam o primeiro valor na hora, no formato documentado, e o fluxo começa com `retry:` |
| segurança | token (cabeçalho, query, cookie), `Host` estranho (421), `Origin` de outro site (403), página de pareamento sem token, cookie `HttpOnly; SameSite=Lax`, cabeçalhos de proteção, corpo inválido (400) e grande demais, caminhos fora de `public/`, bloqueio após 10 falhas (429) |
| cobertura | toda operação tem ao menos um caso de sucesso (as que executam programas do SO ficam de fora do teste em processo e são listadas) |

## Como o agente é testado

`npm test` sobe **duas instâncias** do `ssd.exe` (`agent/target/release/ssd.exe`, ou `SSD_AGENT_EXE`) com `--fake-platform --no-tray` e uma pasta de dados temporária, uma com tudo ligado e outra com
`"editor": false` e `"powerControls": false` (os casos 403). O PC de mentira do Rust tem os próprios ids e nomes; os casos que dependem dos ids da fixture (`fixtureBound`) ou de valores dela
ficam como `skip` (status, tipo e esquema continuam valendo nos outros). Dá para apontar para um agente já em execução:

```bash
node run.js --base-url http://127.0.0.1:9000 --token contract-token-0123456789abcdef --fake-platform \
            --base-url-locked http://127.0.0.1:9001 [--os-effects] [--lockout]
```

`--fake-platform` é obrigatório por segurança: os casos desligam o PC, escondem apps e reescrevem a config. **Nunca aponte `--base-url` para um agente que controla o seu PC de verdade.**

## Mudar a API

1. Edite `openapi.yaml` (e a fixture, se o PC de mentira precisar mostrar algo novo).
2. Acrescente os casos em `tools/contract-test/cases.js`.
3. `npm test` precisa ficar verde. Esquecer o passo 1 quebra o teste "a lista de rotas é a mesma".

## O que a Fase 0 descobriu (e o contrato registra do jeito que é)

- **413 vira conexão fechada.** `readJson`/`readBuffer` (no servidor Node de antes) chamavam `req.destroy()` ao passar do limite, então o cliente
  recebe `socket hang up` em vez do 413 que o código tenta enviar. O contrato documenta o 413 e os testes aceitam as duas coisas
  (`orClosed`). Um agente novo deve responder 413 de verdade e então fechar a conexão.
- **`iconVersion` era número na interface de teste, texto no servidor.** O contrato manda texto (o hash do ícone, `""` sem ícone).
- **Estado de janela é inteiro** (`0` normal, `1` minimizada, `2` maximizada), não texto.
- **`POST /api/power` com `delaySec` fora de 0..86400 é 400**, validado dentro do módulo de energia e não na rota. O agente novo precisa
  validar no mesmo lugar em que recebe o pedido.
- O tópico `notifications` do SSE existe no servidor mas não tem rota GET equivalente; está documentado só em `x-events`.
