'use strict';

/**
 * "Som" page: a slim player strip on top (media.js) and, under it, Saída, Entrada and the per-app mixer (audio.js) as three cards in
 * landscape or stacked in portrait, so changing the song and changing the output never takes a swipe.
 */
(() => {
  const { h } = Deck;
  const { media, audio } = Deck.sound;

  const el = h('section', { class: 'sound-page' }, h('div', { class: 'card sound-media' }, media.el), audio.el);

  Deck.addPage({
    id: 'sound',
    section: 'sound',
    title: 'Som',
    el,
    show() {
      media.show();
      audio.show();
    },
    hide() {
      media.hide();
      audio.hide();
    },
  });
})();
