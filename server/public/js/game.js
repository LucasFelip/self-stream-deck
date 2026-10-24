'use strict';

/**
 * A game being played. The moment its frame rate shows up the deck slides to PC > Desempenho, so the person sees it; anywhere
 * else a small pill in the live strip keeps the number in view (tap it to go to PC > Desempenho). It listens to the light "game" topic,
 * so it works from every page and not only while Desempenho is open (the PC page tells us when that pane is the one on screen).
 */
(() => {
  const { $, api } = Deck;

  const ENDED_AFTER_MS = 5000; // a loading screen or an alt-tab stalls the counters for a moment: that is not the end of the game

  const pill = $('fps');
  const number = pill.querySelector('b');
  // the PC page, on its Desempenho pane
  const openPerformance = () => {
    if (!Deck.goTo('pc')) return false;
    Deck.perf?.showPane('monitor');
    return true;
  };
  pill.addEventListener('click', openPerformance);

  let playing = false;
  let onMonitor = false;
  let wantSlide = false; // a game just started and the deck has not slid to Desempenho yet
  let endTimer = null;

  const render = () => { pill.hidden = !playing || onMonitor; };

  // not while a sheet or dialog is open: sliding the page away under it would be a surprise
  const busy = () => Boolean(document.querySelector('.overlay:not([hidden])')) || document.getElementById('modal-root').childElementCount > 0;

  // The FPS can arrive before the pages exist (at startup): goTo then says no, and we try again when the pager builds its
  // pages (pagesReady), instead of believing we are already on Desempenho and hiding the pill for good.
  function trySlide() {
    if (!wantSlide) return;
    if (busy() || onMonitor) wantSlide = false;
    else if (openPerformance()) {
      wantSlide = false;
      onMonitor = true; // on its way: the pill would only flash while the page slides
    }
    render();
  }

  function apply(fps) {
    if (fps) {
      clearTimeout(endTimer);
      endTimer = null;
      if (!playing) {
        playing = true;
        wantSlide = true;
      }
      trySlide();
      const shown = String(fps.fps);
      if (number.textContent !== shown) number.textContent = shown;
      pill.title = `${fps.app || 'Jogo'} · ${fps.frameMs} ms`;
    } else if (playing && !endTimer) {
      endTimer = setTimeout(() => {
        endTimer = null;
        playing = false;
        wantSlide = false;
        render();
      }, ENDED_AFTER_MS);
    }
    render();
  }

  Deck.live.watch('game', { apply, poll: () => api('/api/monitor/fps'), ms: 2000, idleAfter: Infinity });

  Deck.game = {
    // the pager calls this each time it (re)builds the pages
    pagesReady: trySlide,
    // the PC page calls this when Desempenho becomes (or stops being) what is on screen: that page visible and that pane active
    monitorOpen(open) {
      onMonitor = open;
      render();
    },
  };
})();
