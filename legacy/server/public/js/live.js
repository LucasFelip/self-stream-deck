'use strict';

/**
 * Live updates from the PC (server-sent events, GET /api/events). A page subscribes to the topics it shows (windows, audio,
 * media, monitor, ...) and gets a new value only when something changed, instead of asking every second or two. That saves
 * the phone's radio and battery and shows a change as it happens.
 *
 * One EventSource carries every topic in use; it is closed while the screen is off and reopened (with the latest values
 * sent at once) when it is on again. If the stream is not open for any reason (an old server, a network that blocks it),
 * watch() falls back to polling: at the page's normal pace, slowing down when nothing changes.
 */
Deck.live = (() => {
  const handlers = new Map(); // topic -> Set of functions
  const changes = new Set(); // functions told when the stream opens or closes
  let source = null;
  let wanted = '';
  let isOpen = false;
  let failures = 0;
  let retryTimer = null;
  let syncTimer = null;

  const topicList = () => [...handlers.entries()].filter(([, set]) => set.size).map(([name]) => name).sort().join(',');

  function setOpen(value) {
    if (isOpen === value) return;
    isOpen = value;
    changes.forEach((fn) => fn(isOpen));
  }

  function close() {
    if (source) source.close();
    source = null;
    wanted = '';
    clearTimeout(retryTimer);
    setOpen(false);
  }

  function connect(list) {
    wanted = list;
    source = new EventSource(`/api/events?topics=${list}`);
    source.onopen = () => {
      failures = 0;
      setOpen(true);
    };
    source.onerror = () => {
      setOpen(false);
      // the browser reconnects by itself unless it gave up (an error answer): then start over, waiting longer each time
      if (source && source.readyState === 2) {
        source.close();
        source = null;
        wanted = '';
        failures += 1;
        retryTimer = setTimeout(sync, Math.min(15000, 2000 * failures));
      }
    };
    for (const name of list.split(',')) {
      source.addEventListener(name, (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        for (const fn of handlers.get(name) || []) fn(data);
      });
    }
  }

  // Opens, changes or closes the stream to match what is subscribed (a short pause groups a page change into one reconnect).
  function sync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      const list = topicList();
      if (!list || document.hidden || typeof EventSource === 'undefined') {
        close();
        return;
      }
      if (source && list === wanted) return;
      if (source) close();
      connect(list);
    }, 60);
  }
  document.addEventListener('visibilitychange', sync);

  function subscribe(topic, fn) {
    if (!handlers.has(topic)) handlers.set(topic, new Set());
    handlers.get(topic).add(fn);
    sync();
    return () => {
      handlers.get(topic).delete(fn);
      sync();
    };
  }

  /**
   * Subscribes to `topic` and keeps the page fresh either way. `apply(data)` draws a value; `poll()` fetches one (used when
   * the stream is not open). Polling goes every `ms`, and every `idleMs` after `idleAfter` answers in a row that did not change.
   * Returns { stop(), nudge() }; nudge() puts a slowed-down poller back to its normal pace (after the person did something).
   */
  function watch(topic, { apply, poll, ms, idleMs = ms, idleAfter = 10, signature = (data) => JSON.stringify(data) }) {
    let lastSignature = null;
    let stable = 0;
    let timer = null;
    let stopped = false;

    const handle = (data) => {
      const now = signature(data);
      stable = now === lastSignature ? stable + 1 : 0;
      lastSignature = now;
      apply(data);
    };
    const unsubscribe = subscribe(topic, handle);

    const schedule = () => {
      if (!stopped) timer = setTimeout(run, stable >= idleAfter ? idleMs : ms);
    };
    async function run() {
      if (!document.hidden && !isOpen) {
        try {
          handle(await poll());
        } catch {
          // the navigation's connection light reports outages; keep what is on screen
        }
      }
      schedule();
    }
    run();

    return {
      stop() {
        stopped = true;
        clearTimeout(timer);
        unsubscribe();
      },
      nudge() { stable = 0; },
    };
  }

  return {
    subscribe,
    watch,
    get open() { return isOpen; },
    onChange(fn) {
      changes.add(fn);
      return () => changes.delete(fn);
    },
  };
})();
