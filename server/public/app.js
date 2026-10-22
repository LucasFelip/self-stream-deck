'use strict';

/**
 * Puts the deck together and starts it. Everything else lives in the modules loaded before it (see index.html):
 * tiles, arrange, pager, pc, header, volume, reload, connection, and the pages in js/*.js that register with Deck.addPage().
 */
(() => {
  const { $, api, toast: showToast, vibrate } = Deck;

  // Injected by the Android shell (see android/); absent when opened in a normal browser.
  if (window.Android && typeof window.Android.openSettings === 'function') {
    $('settings').hidden = false;
    $('settings').addEventListener('click', () => window.Android.openSettings());
  }

  // light haptic tick on every button, like a hardware key
  document.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button:not(:disabled)')) vibrate(8);
  }, { capture: true, passive: true });

  // after the editor saved something (or a drag could not be saved): read both lists again and redraw
  Deck.reloadDeck = async () => {
    await Promise.allSettled([Deck.tiles.loadApps(), Deck.tiles.loadShortcuts()]);
    Deck.pager.render();
  };

  // menu > Atualizar: ask the PC to read the taskbar again, then everything on screen
  const refreshButton = $('refresh');
  refreshButton.addEventListener('click', async () => {
    refreshButton.classList.remove('spin');
    void refreshButton.offsetWidth; // restart the spin
    refreshButton.classList.add('spin');
    try {
      await api('/api/refresh', { method: 'POST' });
      await Promise.all([Deck.tiles.loadApps(), Deck.tiles.loadShortcuts(), Deck.volume.refresh(), Deck.pc.refresh()]);
      Deck.pager.render();
      showToast('Atualizado');
    } catch (err) {
      showToast(`Erro: ${err.message}`, true);
    }
  });

  Deck.pager.render();
  Deck.connection.start();
})();
