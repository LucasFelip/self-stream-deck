'use strict';

/**
 * The volume button and its panel are gone from the live strip; the PC volume now lives in the Som page (audio.js, "Saída").
 * What is left is the contract other modules still call (app.js: refresh, pc.js: render), which has nothing to paint any more.
 */
(() => {
  Deck.volume = { render() {}, refresh: async () => {} };
})();
