'use strict';

// The taskbar apps: list, icons, re-reading the taskbar, launching. And the state the header and the volume strip show.

const os = require('node:os');
const path = require('node:path');
const { ICON_DIR } = require('../config');
const { sendJson, sendFile, readJson } = require('../http');
const { badRequest, notFound } = require('../validate');
const { swallow } = require('../log');

module.exports = function appsRoutes(ctx, on) {
  const { config, system, media, power } = ctx;

  on('GET', '/api/ping', async ({ res }) => sendJson(res, 200, { ok: true }));

  on('GET', '/api/apps', async ({ res }) =>
    sendJson(res, 200, {
      host: os.hostname(),
      apps: ctx.apps().map(({ id, name, hasIcon, iconVersion }) => ({ id, name, hasIcon, iconVersion })),
    }));

  on('GET', '/api/icon/:id', async ({ res, params }) => {
    const app = ctx.allApps().find((candidate) => candidate.id === params.id);
    if (!app || !app.hasIcon) throw notFound('not found');
    // the URL carries ?v=<icon hash>, so a cached copy can never be stale
    sendFile(res, path.join(ICON_DIR, `${app.id}.png`), 'image/png', { 'Cache-Control': 'max-age=31536000, immutable' });
  });

  on('POST', '/api/refresh', async ({ res }) => sendJson(res, 200, { count: (await ctx.refreshApps({ force: true })).length }));

  on('POST', '/api/launch/:id', async ({ res, params }) => {
    const app = ctx.apps().find((candidate) => candidate.id === params.id);
    if (!app) throw notFound('unknown app');
    sendJson(res, 200, { ok: true, name: app.name, action: await ctx.launchApp(app) });
  });

  // What is playing, for the header's mini player. Several clients/pages ask within the same second: share one lookup.
  let playingCache = { at: 0, promise: null };
  async function readNowPlaying() {
    try {
      const { current, sessions } = await media.state();
      const session = sessions.find((s) => s.id === current) || sessions.find((s) => s.status === 'playing') || sessions[0];
      if (!session) return null;
      return { session: session.id, title: session.title, artist: session.artist, app: session.app, status: session.status, canToggle: session.canPlay || session.canPause };
    } catch (err) {
      swallow('[state] could not read what is playing', err); // the header just hides the player
      return null;
    }
  }
  const nowPlaying = () => {
    if (config.miniPlayer === false) return Promise.resolve(null);
    if (!playingCache.promise || Date.now() - playingCache.at > 1500) playingCache = { at: Date.now(), promise: readNowPlaying() };
    return playingCache.promise;
  };

  // everything the header and the volume strip show, in one object (GET /api/state and the "state" event)
  ctx.build.state = async () => {
    const [{ running, windows }, mic, playing, volume] = await Promise.all([
      ctx.windowSnapshot().catch(() => ({ running: [], windows: [] })),
      system.mic().catch(() => null),
      nowPlaying(),
      system.getVolume().catch(() => null),
    ]);
    const runningNames = new Set(running);
    const windowNames = new Set(windows.map((window) => window.name));
    const apps = ctx.apps();
    return {
      running: apps.filter((app) => app.proc && runningNames.has(app.proc)).map((app) => app.id),
      open: apps.filter((app) => app.proc && windowNames.has(app.proc)).map((app) => app.id),
      scheduled: power.schedule(), // a pending shutdown/restart, shown as a pill in the header
      mic,
      volume,
      playing,
      miniPlayer: config.miniPlayer !== false,
      ui: ctx.uiVersion(), // the page reloads itself when this changes
      appsRev: ctx.appsRev(), // the page reads the apps again when this changes
    };
  };
  on('GET', '/api/state', async ({ res }) => sendJson(res, 200, await ctx.build.state()));

  on('POST', '/api/mic', async ({ req, res }) => {
    const { muted } = await readJson(req);
    if (muted !== 'toggle' && typeof muted !== 'boolean') throw badRequest('muted must be true, false or "toggle"');
    sendJson(res, 200, await system.setMic(muted));
  });
};
