# Segurança

O Self Stream Deck deixa um celular controlar um PC: abrir programas, apertar atalhos, mudar o áudio, desligar a máquina. O modelo de
segurança inteiro (o que cada camada confere e por quê) está em [docs/rede-e-seguranca.md](docs/rede-e-seguranca.md#o-modelo-de-segurança).

## Versões com correção

Só a última versão publicada recebe correções. O projeto é mantido por uma pessoa, no tempo livre.

## Como relatar uma falha

**Não abra uma issue pública.** Use o relato privado do GitHub: aba *Security* do repositório → *Report a vulnerability*
([link direto](https://github.com/LucasFelip/self-stream-deck/security/advisories/new)).

Ajuda muito dizer: a versão (`ssd --version`), como o celular estava ligado (USB, Wi-Fi, iPhone), os passos para repetir e o que um
atacante consegue. O relatório do `ssd diagnose` já mascara o token; ainda assim, confira antes de anexar.

A resposta costuma vir em até uma semana. Uma falha confirmada é corrigida antes de ser divulgada, e o relato é creditado no
[CHANGELOG](CHANGELOG.md), se você quiser.

## O que conta como falha

- Qualquer forma de controlar o PC **sem o token**, ou a partir de outro site aberto no navegador do PC ou do celular.
- Fazer o agente executar um programa, um caminho ou um texto que ele não listou (o painel só dispara o que o agente lista).
- Um programa **sem privilégio** no PC conseguir, pelo agente (que roda como administrador), direitos de administrador.
- Aceitar uma atualização ou um certificado que não seja o esperado.

## O que não conta

- Quem já tem o token (ou acesso de administrador ao PC) fazer o que o painel faz: é o uso normal.
- O MSI e o APK do CI não serem assinados: é declarado; assine localmente para distribuir.
