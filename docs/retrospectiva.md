# Retrospectiva da reestruturação

O que o [plano](plano-reestruturacao.md) se propôs, o que ficou, o que custou e o que sobra. Números medidos neste PC (Ryzen, 16 núcleos, Windows 11) e no Galaxy A31, comparados com a linha de base da Fase 0 (recuperável com `git show 7cd9833^:tools/baseline/baseline-phase0-static.json`).

## Antes e depois

| | Antes (Node + C#/PowerShell + JS puro) | Depois (Rust + React/TS + Kotlin) |
|---|---|---|
| Processos do agente | 5 (Node e 4 helpers) | **1** (`ssd.exe`) |
| Memória do agente | ~250 MB | **~40–70 MB** (39 MB parado, ~60 MB com a interface aberta) |
| CPU do agente | — | ~1 % de um núcleo parado; ~5 % com os 9 tópicos abertos |
| O que se instala | Node 20 + compilador C# do Windows + PowerShell, `npm`, tarefa por script | **um `.exe` de 5 MB** com a interface dentro, mais `install.ps1` |
| Primeira resposta depois de reiniciar | ≥ 2,5 s | ~15 ms (lista de apps em cache, conferida em segundo plano) |
| Código do agente | 3 349 linhas de JS + 2 072 de C# + 1 275 de PowerShell | 12 182 linhas de Rust (inclui o spike, o servidor TLS, a bandeja e os testes inline) |
| Código da interface | 4 529 linhas de JS + 1 123 de CSS, sem tipos | 5 494 de TypeScript + 1 010 de CSS, tipos **gerados do contrato** |
| Interface entregue | 31 arquivos, 280 KB (92 KB gzip) | 6 arquivos, 348 KB (108 KB gzip): React pesa, em troca de componentes tipados e testados |
| App Android | 408 linhas de Java | 337 de Kotlin |
| Testes | ~3 800 linhas de JS (lógica, UI em navegador, helpers) | 95 testes de Rust, 77 de Vitest, 2 918 linhas de e2e em navegador, contrato (149 ok), 21 checagens de fora para dentro |
| Dependências de runtime do agente | 0 (mas Node e o compilador C# do sistema) | 0 instaladas; ~180 crates compilados para dentro do `.exe` |
| Contrato da API | nenhum (o código era a verdade) | `contracts/openapi.yaml`: 51 operações, 9 tópicos de eventos; a interface e os testes saem dele |

Medições do celular (A31, já na interface nova antes do corte do agente): app ≈ 150 MB (PSS) mais ~150 MB do renderizador do WebView, ~1 % de CPU de um núcleo, ~0,6 KB/s de rede.

## O que deu certo

- **Contrato primeiro.** Descrever a API em OpenAPI antes de portar achou erros que ninguém via (o 413 que chegava como conexão fechada, `iconVersion` com tipo diferente na interface de teste e no servidor, um bug real de arrasto de janelas). Depois disso, trocar o Node pelo Rust foi uma questão de fazer o mesmo contrato passar, rota por rota.
- **Migração incremental com proxy.** Enquanto o Rust não cobria uma rota, o Node respondia; o painel nunca ficou sem funcionar. O proxy durou da 3.1 à 3.3 e foi apagado quando não servia mais.
- **Portas e adaptadores.** Cada parte do PC (áudio, mídia, janelas, energia…) é um trait com um `Fake*`. Isso deu `--fake-platform`, e com ele o contrato, o `agent-check` e a interface testam o agente de verdade sem tocar no Windows.
- **Medir antes de afirmar.** A diferença de memória, de CPU e de partida está medida, não suposta; achou até um custo escondido (o tópico `windows` gastava 2,5 % de CPU por causa do título que muda a cada quadro de um spinner, e caiu para 0,2 % com um intervalo mínimo).
- **Um comando para tudo.** `node tools/check.js` cobre formatação, lints, testes do Rust e da interface, o contrato contra o `ssd.exe` e a checagem de fora para dentro. Pegou erros reais durante a limpeza (inclusive um que era do próprio script).

## O que custou mais do que o previsto

- **Windows sem Visual Studio.** O alvo `x86_64-pc-windows-gnu` funcionou, mas obrigou a escolhas: Schannel via `native-tls` para o HTTPS (para manter exatamente os mesmos certificados que o app fixa) e COM escrito à mão no Core Audio (`IPolicyConfig`).
- **Áudio, mídia e a câmera virtual.** Foram as partes com mais risco; o spike da Fase 3.0 as cobriu antes de se decidir pelo Rust (ADR 0008), e foi a decisão certa, mas a câmera ainda é a parte mais frágil (registro do filtro por caminho, DLL baixada).
- **Texto em arquivos.** Muita fricção com quebras de linha e escapes ao editar por script; a lição é escrever os arquivos inteiros e deixar o `rustfmt`/`prettier` formatarem.
- **Testes de navegador lentos e sensíveis a carga.** O e2e inteiro leva ~10 minutos com a máquina ocupada e um caso falhou uma vez por tempo (passou nas repetições). Vale reduzir o tempo ou isolar os casos mais sensíveis.

## Diferenças aceitas (Rust ≠ Node)

Estavam decididas e continuam valendo: o ícone de `wt.exe` e a versão do texto do ícone; inteiros serializados como `95.0` em alguns campos; a validação do `config.json` confere os tipos das chaves editáveis, não tudo; os certificados só são refeitos quando faltam (sem renovação por validade nem por mudança de IP); o PC de mentira do Rust tem os próprios ids, então os casos do contrato presos aos ids da fixture ficam como `skip` neste agente.

## O que ficou sem fazer

- **Vigia do `adb reverse`.** O Node refazia o túnel USB sozinho ao plugar o celular; agora é `adb reverse tcp:7878 tcp:7878` à mão (pelo Wi-Fi não precisa).
- **Renovação dos certificados** por validade ou troca de IP, e o comando `lan` (liga-se Wi-Fi e iPhone editando o `config.json`).
- **MSI (WiX) e atualização automática.** O pacote zip com `install.ps1` cobre a instalação; falta a atualização com verificação de assinatura, e um instalador de verdade exige baixar o WiX. A assinatura é com certificado próprio (o Windows mostra "não confiável" em outros PCs).
- **Teste em máquina limpa** (sem as pastas do projeto) e **o iPhone**, que não foi testado na reestruturação.
- **Câmera e escurecimento no app Kotlin**: o código foi portado, mas não exercitado no celular.
- **Semana de uso**: a paridade foi conferida por testes e pelo uso curto no A31 e no PC; falta o uso do dia a dia para achar o que só ele mostra.
- **GitHub Actions (D7).** Decisão do dono: o fluxo fica pronto em `docs/ci/` e roda tudo local com o hook de `pre-push`; ligar quando quiser.
- **A pasta `legacy/`**: sobrou `legacy/server/data/` (fora do git), porque a câmera direta ainda está registrada lá. Reinstale a câmera pelo app e apague a pasta.

## Se fosse começar de novo

1. Fazer o contrato e a fixture do PC de mentira **antes** de qualquer código novo (foi o que mais valeu, e foi feito cedo).
2. Pôr o `--fake-platform` no agente desde a primeira rota, em vez de testar contra o Node em processo e só depois contra o Rust: teria economizado a adaptação do `contract-test`.
3. Gerar também a fixture a partir do mesmo código dos fakes do Rust (ou o contrário), para os casos presos aos ids da fixture não precisarem de `skip`.
4. Escrever os arquivos inteiros em vez de patches de texto.
