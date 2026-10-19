'use strict';

/**
 * "Som" page: what is playing (media.js) on the left and the audio devices and per-app mixer (audio.js) on the right,
 * so changing the song and changing the output never takes a swipe.
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
