# 0005. Android em Kotlin fino; iPhone continua PWA

Estado: **aceito**.

## Decisão

- **Android:** casca fina em Kotlin (`MainActivity.java` tem ~400 linhas e nenhuma biblioteca), mantendo a ponte `Android.*` (`openSettings`, `vibrate`,
  `reconnect`, `setDim`). Capacitor só se um dia houver iOS nativo.
- **iPhone:** continua PWA no Safari / Tela de Início, sem conta de desenvolvedor nem Mac. O certificado da rede local segue o fluxo atual (`tls-ios`).

## Consequências

- Uma única interface para as duas plataformas; só a casca do Android é nativa.
- Recursos que dependem de APK (como `setDim`) continuam opcionais: a interface checa `typeof window.Android.setDim`.
