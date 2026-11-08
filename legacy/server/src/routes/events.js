'use strict';

// Live updates (server-sent events). GET /api/events?topics=windows,state keeps the response open and pushes a topic's new
// value when it changes. A producer runs only while somebody listens to its topic; when it cannot do better it asks the PC
// on a timer (still one asking for all the phones, and nothing is sent when the answer did not change).
// The builders (ctx.build.*) are the same functions the plain GET routes use, so a pushed value is what a request would return.

const { badRequest } = require('../validate');
const { swallow } = require('../log');

// runs `fetch` every `ms` while the topic has listeners; one run at a time (a slow answer never piles up)
const every = (ms, fetch, options = () => ({})) => {
  let timer = null;
  let busy = false;
  return {
    start(publish) {
      const run = async () => {
        if (busy) return;
        busy = true;
        try {
          const data = await fetch();
          publish(data, options(data));
        } catch (err) {
          swallow('[events] a producer could not read (it tries again next turn)', err); // helper busy or restarting
        } finally {
          busy = false;
        }
      };
      run();
      timer = setInterval(run, ms);
    },
    stop() { clearInterval(timer); },
  };
};

// a title that only changes its leading spinner glyph (a terminal at work) is not news
const withoutSpinner = (title) => String(title).replace(/^[^\p{L}\p{N}]+/u, '');

// the countdown of a scheduled shutdown is counted by the phone itself, so it is not part of what "changed" means
const withoutCountdown = (data) => JSON.stringify({ ...data, scheduled: data.scheduled ? { ...data.scheduled, inSec: 0 } : null });

module.exports = function eventsRoutes(ctx, on) {
  const { system, media, notifications, monitor, events } = ctx;

  events.register('windows', {
    stopFns: [],
    start(publish) {
      let waiting = null;
      let last = 0;
      let poller = null;
      const emit = async () => {
        try {
          const data = await ctx.build.windows();
          publish(data, { signature: JSON.stringify(data.windows.map((w) => ({ ...w, title: withoutSpinner(w.title) }))) });
        } catch (err) {
          swallow('[events] could not read the windows (the next change or the timer tries again)', err);
        }
      };
      // at most one read per 100 ms while windows are being dragged, and always one after the last change
      const soon = () => {
        if (waiting) return;
        waiting = setTimeout(() => { waiting = null; last = Date.now(); emit(); }, Math.max(0, 100 - (Date.now() - last)));
      };
      const off = system.onWindowsChanged(soon);
      this.stopFns = [off, () => clearTimeout(waiting), () => clearInterval(poller), () => system.watchWindows(false).catch((err) => swallow('[events] could not stop the window watch', err))];
      emit();
      // the native helper pushes changes; the PowerShell one cannot, so it is asked every 600 ms instead
      system.watchWindows(true).catch(() => {
        off();
        poller = setInterval(emit, 600);
      });
    },
    stop() {
      for (const fn of this.stopFns) fn();
      this.stopFns = [];
    },
  });

  // the header, the volume strip and the apps' dots
  events.register('state', every(3000, () => ctx.build.state(), (state) => ({ signature: withoutCountdown(state) })));
  events.register('audio', every(2000, () => ctx.build.audio()));
  // the playback position moves all the time: it is resent every 5 s, the rest only when it changes
  events.register('media', every(1500, () => media.state(), (state) => ({
    signature: JSON.stringify(state.sessions.map((s) => ({ ...s, position: Math.floor((s.position || 0) / 5) }))),
  })));
  // what Windows kept quiet (Do Not Disturb, a game) from the apps listed in config.notifications.apps; the phone shows the new ones
  events.register('notifications', every(2000, () => notifications.list(ctx.config.notifications && ctx.config.notifications.enabled === false ? [] : (ctx.config.notifications || {}).apps)));
  events.register('monitor', every(2000, () => monitor.sample(), () => ({ force: true })));
  // the game's frame rate (or null): lets the phone notice a game from any page, not only from Desempenho
  events.register('game', every(1000, () => monitor.fps()));
  events.register('processes', every(3000, () => monitor.processes(), () => ({ force: true })));
  events.register('power', every(5000, () => ctx.build.power(), (info) => ({ signature: withoutCountdown(info) })));

  on('GET', '/api/events', async ({ req, res, url }) => {
    const requested = String(url.searchParams.get('topics') || '').split(',').map((name) => name.trim()).filter(Boolean);
    if (!requested.length || requested.some((name) => !events.names().includes(name))) throw badRequest(`topics: ${events.names().join(', ')}`);
    events.subscribe(req, res, requested);
  });
};
