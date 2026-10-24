'use strict';

/**
 * What the PC says about itself for the navigation, the live strip and the keys: which apps run or have a window, the scheduled shutdown
 * (the pill), the microphone, what is playing. It arrives pushed (connection.js) or by request, and paint() puts it on screen.
 */
(() => {
  const { $, api } = Deck;
  const pager = $('pager');
  const pill = $('power-pill');

  let state = { running: [], open: [], scheduled: null, receivedAt: Date.now() };
  let appsRev = null;

  const PILL_LABELS = { shutdown: 'Desliga', restart: 'Reinicia', firmware: 'Reinicia BIOS', advanced: 'Reinicia av.' };
  let pillTimer;

  function renderPill() {
    const { scheduled } = state;
    if (!scheduled) {
      pill.hidden = true;
      clearInterval(pillTimer);
      pillTimer = null;
      return;
    }
    const paint = () => {
      const left = Math.max(0, Math.round(scheduled.inSec - (Date.now() - state.receivedAt) / 1000));
      pill.textContent = `${PILL_LABELS[scheduled.action] || scheduled.action} em ${Deck.fmt.clock(left)}`;
    };
    pill.hidden = false;
    paint();
    clearInterval(pillTimer);
    pillTimer = setInterval(paint, 1000);
  }
  pill.addEventListener('click', () => Deck.pager.goToId('power'));

  // the dots on the app keys, the camera key, the power pill and the live strip
  function paint() {
    Deck.tiles.paintCamera();
    const running = new Set(state.running);
    const open = new Set(state.open);
    pager.querySelectorAll('.tile[data-app-id]').forEach((tile) => {
      tile.classList.toggle('running', running.has(tile.dataset.appId));
      tile.classList.toggle('open', open.has(tile.dataset.appId));
    });
    renderPill();
    Deck.header.apply();
  }

  // the state of the PC, from a request or pushed by the live stream
  function apply(data) {
    state = { ...data, receivedAt: Date.now() };
    Deck.reload.notice(state.ui);
    if (state.volume) Deck.volume.render(state.volume);
    // the taskbar list changed on the PC (it was read again after a restart, or an app was pinned): read the keys again
    if (appsRev !== null && state.appsRev !== appsRev) {
      appsRev = state.appsRev;
      Deck.reloadDeck();
    }
    appsRev = state.appsRev;
    paint();
  }

  // Throws when the PC cannot be reached (connection.js turns that into the connection indicator).
  async function load() {
    apply(await api('/api/state'));
  }

  async function refresh() {
    try {
      await load();
    } catch {
      // the connection indicator reports problems
    }
  }

  Deck.pc = {
    get state() { return state; },
    // a change made here (the person tapped the microphone): the PC's next report confirms it
    patch(partial) { state = { ...state, ...partial }; },
    apply,
    load,
    refresh,
    paint,
  };
  Deck.refreshState = refresh; // for the pages that ask for a fresh state after an action (power)
})();
