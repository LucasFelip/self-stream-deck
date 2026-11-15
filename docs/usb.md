# USB: o túnel automático e a atualização do app

O celular fala com o agente por um túnel do `adb` (`adb reverse`). O agente pode manter esse túnel sozinho, e também pode atualizar o app Android por cima, pelo mesmo cabo. As decisões estão no [ADR 0012](adr/0012-agente-e-o-adb.md).

## Onde fica o `adb`

O agente roda como administrador. Por isso ele **só executa um `adb` que um programa comum não consegue trocar**:

1. a pasta `adb` ao lado do `ssd.exe` (por exemplo `C:\Program Files\SelfStreamDeck\adb\adb.exe`): copie para lá a pasta *platform-tools* do Android (`adb.exe`, `AdbWinApi.dll`, `AdbWinUsbApi.dll`);
2. `Program Files\Android\platform-tools` e `Program Files (x86)\Android\android-sdk\platform-tools`;
3. a chave `usb.adb` do `config.json`, **desde que** o caminho esteja dentro de uma dessas pastas (Program Files, o Windows ou a pasta do agente): o `config.json` é um arquivo que qualquer programa seu pode gravar.

Um `adb` no `PATH` ou no SDK da sua pasta de usuário **não** é usado, de propósito. O `ssd diagnose` e o `ssd usb` dizem o que foi achado e onde procurar.

## O túnel automático

No celular: depuração USB ligada, e aceite o aviso "Permitir depuração USB" na primeira vez. No `config.json`:

```json
"usb": { "auto": true }
```

Com isso o agente olha os celulares a cada poucos segundos e, para cada um que está pronto, faz `adb reverse tcp:7878 tcp:<porta do agente>`. Plugou o cabo, abra o app: não há comando a rodar. O túnel é refeito se o celular sair e voltar. Sem `auto` o agente não executa o `adb` nunca.

Para fazer uma vez, à mão, e ver o que foi achado:

```bash
ssd.exe usb
```

Ele diz qual `adb` usou e o estado de cada celular (pronto, não autorizado, sem celular no cabo). O agente que roda como administrador inicia o servidor do `adb`; se o `adb` do seu usuário já estava rodando, o agente usa esse.

## Atualizar o app pelo cabo

O manifesto de atualização pode levar o APK de cada canal:

```json
{ "channels": { "stable": { "version": "0.2.0", "url": "https://…/SelfStreamDeck-0.2.0.msi", "sha256": "…",
    "apk": { "url": "https://…/SelfStreamDeck-0.2.0.apk", "sha256": "…" } } } }
```

A mão, com o celular no cabo:

```bash
ssd.exe update --apk
```

Ou sozinho, uma vez por dia, com `"update": { "url": "…", "apk": true }` junto de `"usb": { "auto": true }`. O que o agente faz, por celular pronto:

- lê a versão do app instalado (`dumpsys package`): **se o app não está instalado, não instala** (a primeira instalação é sua);
- se a versão da release é mais nova, baixa o APK, confere o tamanho e o SHA-256 do manifesto e roda `adb install -r` (uma atualização no lugar, sem pedir nada no celular);
- se o Android **recusar** (outra chave de assinatura, versão mais baixa), o agente conta o que o Android disse e **não desinstala** nada para forçar. Isso acontece, por exemplo, ao tentar atualizar um app de release com o APK de depuração (cada um tem a sua chave): use o APK de release assinado com a mesma chave de sempre.

Quem garante que o APK é o certo é o próprio Android, que só aceita uma atualização assinada pela mesma chave do app instalado; o SHA-256 do manifesto garante que o arquivo é o que foi publicado.
