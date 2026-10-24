'use strict';

/**
 * A game being played. The moment its frame rate shows up the deck slides to Desempenho, so the person sees it; anywhere
 * else a small floating pill keeps the number in view (tap it to go to Desempenho). It listens to the light "game" topic,
 * so it works from every page and not only while Desempenho is open (that page tells us when it is the one on screen).
 */
(() => {
  const { h, api } = Deck;

  const ENDED_AFTER_MS = 5000; // a loading screen or an alt-tab stalls the counters for a moment: that is not the end of the game

  const number = h('b');
  const pill = h('button', { type: 'button', class: 'fps-float', hidden: true, 'aria-label': 'Abrir Desempenho', on: { click: () => Deck.goTo('monitor') } }, number, h('small', { text: 'FPS' }));
  document.body.append(pill);

  let playing = false;
  let onMonitor = false;
  let endTimer = null;

  const render = () => { pill.hidden = !playing || onMonitor; };

  // not while a sheet or dialog is open: sliding the page away under it would be a surprise
  const busy = () => Boolean(document.querySelector('.overlay:not([hidden])')) || document.getElementById('modal-root').childElementCount > 0;

  function apply(fps) {
    if (fps) {
      clearTimeout(endTimer);
      endTimer = null;
      if (!playing) {
        playing = true;
        if (!onMonitor && !busy()) {
          onMonitor = true; // on its way: the pill would only flash while the page slides
          Deck.goTo('monitor');
        }
      }
      const shown = String(fps.fps);
      if (number.textContent !== shown) number.textContent = shown;
      pill.title = `${fps.app || 'Jogo'} · ${fps.frameMs} ms`;
    } else if (playing && !endTimer) {
      endTimer = setTimeout(() => {
        endTimer = null;
        playing = false;
        render();
      }, ENDED_AFTER_MS);
    }
    render();
  }

  Deck.live.watch('game', { apply, poll: () => api('/api/monitor/fps'), ms: 2000, idleAfter: Infinity });

  Deck.game = {
    // Desempenho calls this when it becomes (or stops being) the visible page
    monitorOpen(open) {
      onMonitor = open;
      render();
    },
  };
})();
