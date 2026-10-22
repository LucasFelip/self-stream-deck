'use strict';

/**
 * Self-update: when the interface files change on the PC (the state carries a version number), reload this page, but only
 * once nobody has touched the screen for a moment (never in the middle of a tap or a drag).
 */
(() => {
  let uiVersion = null;
  let lastTouch = 0;
  let reloadTimer = null;
  document.addEventListener('pointerdown', () => { lastTouch = Date.now(); }, { capture: true, passive: true });
  document.addEventListener('pointerup', () => { lastTouch = Date.now(); }, { capture: true, passive: true });

  function notice(version) {
    if (!version) return;
    if (uiVersion === null) {
      uiVersion = version;
      return;
    }
    if (version === uiVersion || reloadTimer) return;
    reloadTimer = setInterval(() => {
      if (Date.now() - lastTouch > 2500) location.reload();
    }, 500);
  }

  Deck.reload = { notice };
})();
