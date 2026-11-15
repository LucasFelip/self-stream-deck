# 0012. O agente fala com o `adb`

Estado: **aceito**.

## Contexto

O túnel USB (`adb reverse tcp:7878 tcp:7878`) é feito à mão a cada vez que o cabo é ligado, e o app Android é instalado e atualizado à mão. O agente
nunca chama o `adb` (não há nenhuma referência a ele em `agent/crates`).

## Decisão

1. Um módulo `adb` no agente (`agent/crates/agent`) atrás de uma porta `AdbPort` com `FakeAdb`, como as outras portas.
2. **Descoberta do `adb`:** a chave `adb` do `config.json`, depois o `PATH`, depois `.tools/` e o Android SDK. Sempre caminho absoluto, e a mesma regra de
   confiança de pasta do atualizador: nada de pasta que um programa comum consiga gravar, porque o agente roda como administrador.
3. **Túnel automático** (`usb.auto`, desligado por padrão): a cada poucos segundos, para cada aparelho em `device`, `adb reverse` idempotente.
4. **Atualização do APK** (`update.apk`, desligada por padrão; `ssd update --apk` sempre manual): o manifesto traz `apk` com URL e SHA-256, a versão
   instalada vem de `dumpsys package`, e a instalação é `adb install -r`. Se o Android recusar por assinatura diferente, o agente relata e **nunca
   desinstala**.
5. O processo filho entra no job object do agente, como os outros auxiliares.

## Consequências

- O pareamento por USB passa a funcionar ao plugar o cabo, sem comando.
- A atualização do APK só é segura com um APK de release assinado com a chave de sempre; o APK de depuração tem outra chave e fica fora.
- O `ssd diagnose` e a bandeja passam a dizer por que o USB não conectou (aparelho não autorizado, cabo só de energia, `adb` não achado).
