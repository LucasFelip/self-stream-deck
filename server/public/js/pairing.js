'use strict';

/**
 * Menu > "Código de pareamento": copies the pairing code, for a Home Screen app on iPhone. That app keeps its own cookies apart from
 * Safari, so on its first start it shows the pairing page (pair.html); the code copied here goes into that page once. Not shown in the
 * Android app (which pairs by itself) nor on a desktop browser: only on iOS.
 */
(() => {
  const { api, toast } = Deck;
  if (!Deck.isIOS || window.Android) return;

  async function copyCode() {
    try {
      const { code } = await api('/api/pair-code');
      try {
        await navigator.clipboard.writeText(code);
        toast('Código copiado. Cole na tela de pareamento do app');
      } catch {
        // no clipboard (not a secure context, or refused): show it so it can be typed
        toast(`Código: ${code}`, false, 15000);
      }
    } catch {
      toast('Não foi possível obter o código', true);
    }
  }

  Deck.menuItems.push({ label: 'Código de pareamento', onClick: copyCode });
})();
