'use strict';

/**
 * The connection indicator and the way the UI recovers on its own after the PC sleeps or Wi-Fi drops: the first successful
 * answer after an outage reloads everything. The PC pushes its state when it changes (live.js); a 3-second tick is only the
 * fallback and the watchdog. Also keeps the phone awake and pauses the visible page's polling with the screen.
 */
(() => {
  const { $ } = Deck;
  const status = $('status');

  function setStatus(state, label) {
    status.dataset.state = state;
    status.textContent = label;
    document.body.dataset.state = state;
    Deck.state.online = state === 'online';
  }

  let online = false;
  // One request per tick (the state already carries the volume), and none while the screen is off or the app is in the
  // background: that saves the phone's radio and lets the PC's media helper stop when nobody is looking.
  let missedTicks = 0;
  let lastPush = 0;

  async function goOnline() {
    if (online) return;
    online = true;
    missedTicks = 0;
    setStatus('online', 'online');
    await Promise.allSettled([Deck.tiles.loadApps(), Deck.tiles.loadShortcuts()]);
    Deck.pager.render();
  }

  // The PC sends the current state as soon as the stream opens, so while the stream is open there is nothing to ask.
  // Without a push for a long while the tick asks once, which also notices a PC that went away without closing the stream.
  const PUSH_SILENCE_MS = 45_000;
  Deck.live.subscribe('state', (data) => {
    lastPush = Date.now();
    Deck.pc.apply(data);
    goOnline();
  });

  async function tick() {
    if (document.hidden) return;
    if (Deck.live.open && Date.now() - lastPush < PUSH_SILENCE_MS) return;
    try {
      await Deck.pc.load();
    } catch (err) {
      online = false;
      setStatus('offline', err.status === 401 ? 'não autorizado' : 'sem conexão');
      // Lost for ~12 s: if the app knows another way to the PC (USB or Wi-Fi), let it switch to it
      missedTicks += 1;
      if (missedTicks % 4 === 0 && err.status !== 401 && window.Android && typeof window.Android.reconnect === 'function') window.Android.reconnect();
      return;
    }
    await goOnline();
  }

  // Keep the phone awake while the deck is visible (needs a secure context, e.g. 127.0.0.1 over USB).
  async function keepAwake() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      await navigator.wakeLock.request('screen');
    } catch {
      // denied or unsupported: the screen just follows the system timeout
    }
  }
  document.addEventListener('visibilitychange', () => {
    keepAwake();
    // the visible page's polling stops with the screen and starts again, fresh, when it comes back
    const page = Deck.pager.activeHook();
    if (document.hidden) {
      if (page && page.hide) page.hide();
      return;
    }
    if (page && page.show) page.show();
    tick();
  });
  keepAwake();

  Deck.connection = {
    start() {
      tick();
      setInterval(tick, 3000);
    },
  };
})();
