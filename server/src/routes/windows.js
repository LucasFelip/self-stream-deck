'use strict';

// Windows and screens (Deck > Janelas). Actions name a window by handle, and the helper only acts on handles
// that are in the live window list.

const path = require('node:path');
const { execFile } = require('node:child_process');
const { sendJson, readJson } = require('../http');
const { badRequest, notFound, number, percent } = require('../validate');
const { log } = require('../log');

const WINDOW_ACTIONS = new Set(['focus', 'minimize', 'maximize', 'restore', 'close']);
const SHELL_WINDOWS = new Set(['textinputhost', 'searchhost', 'startmenuexperiencehost', 'shellexperiencehost', 'lockapp']);
const PROJECT_MODES = { extend: '/extend', clone: '/clone', first: '/internal', second: '/external' };
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function handleOf(body) {
  const handle = Number(body.handle);
  if (!Number.isSafeInteger(handle) || handle <= 0) throw badRequest('invalid window handle');
  return handle;
}

function monitorOf(body) {
  const monitor = Number(body.monitor);
  if (!Number.isInteger(monitor) || monitor < 0 || monitor > 15) throw badRequest('invalid monitor');
  return monitor;
}

// the helper says "window not found" when the handle is not in the live list (the window just closed, or a bad id)
const gone = (err) => { throw err.message === 'window not found' ? notFound(err.message) : err; };

module.exports = function windowsRoutes(ctx, on) {
  const { system } = ctx;

  ctx.build.windows = async () => {
    const { windows } = await system.windows();
    const byProcess = new Map(ctx.apps().filter((app) => app.proc).map((app) => [app.proc, app]));
    const visible = windows.filter((window) => !SHELL_WINDOWS.has(window.name) && window.title !== 'Program Manager');
    return {
      windows: visible.map((window) => {
        const app = byProcess.get(window.name);
        // UWP apps all run inside ApplicationFrameHost: their title is the useful part
        const label = window.name === 'applicationframehost' ? '' : window.name === 'explorer' ? 'Explorador de Arquivos' : app ? app.name : capitalize(window.name);
        return {
          handle: window.handle, title: window.title, app: label, appId: app ? app.id : null, iconVersion: app ? app.iconVersion : '',
          state: window.state, monitor: window.monitor, x: window.x, y: window.y, w: window.w, h: window.h,
        };
      }),
    };
  };
  on('GET', '/api/windows', async ({ res }) => sendJson(res, 200, await ctx.build.windows()));

  on('POST', '/api/windows/action', async ({ req, res }) => {
    const body = await readJson(req);
    if (!WINDOW_ACTIONS.has(body.action)) throw badRequest('invalid action');
    await system.windowAction(handleOf(body), body.action).catch(gone);
    log.info(`[window] ${body.action} ${body.handle}`);
    sendJson(res, 200, { ok: true });
  });

  on('POST', '/api/windows/move', async ({ req, res }) => {
    const body = await readJson(req);
    const monitor = monitorOf(body);
    await system.moveWindow(handleOf(body), monitor).catch(gone);
    log.info(`[window] move ${body.handle} -> screen ${monitor + 1}`);
    sendJson(res, 200, { ok: true });
  });

  // the position inside the virtual desktop is in real pixels; the page draws the layout to scale
  on('POST', '/api/windows/place', async ({ req, res }) => {
    const body = await readJson(req);
    const x = Math.round(number(body.x, 'x'));
    const y = Math.round(number(body.y, 'y'));
    if (Math.abs(x) > 100000 || Math.abs(y) > 100000) throw badRequest('position out of range');
    await system.placeWindow(handleOf(body), x, y).catch(gone);
    log.info(`[window] place ${body.handle} -> ${x},${y}`);
    sendJson(res, 200, { ok: true });
  });

  on('POST', '/api/windows/snap', async ({ req, res }) => {
    const body = await readJson(req);
    const monitor = monitorOf(body);
    if (!['left', 'right', 'full'].includes(body.zone)) throw badRequest('invalid zone');
    await system.snapWindow(handleOf(body), monitor, body.zone).catch(gone);
    log.info(`[window] snap ${body.zone} ${body.handle} -> screen ${monitor + 1}`);
    sendJson(res, 200, { ok: true });
  });

  // ?brightness=0 skips the slow DDC/CI reads when only the layout is needed
  on('GET', '/api/screens', async ({ res, url }) => sendJson(res, 200, { monitors: await system.monitors(url.searchParams.get('brightness') !== '0') }));

  on('POST', '/api/screens/brightness', async ({ req, res }) => {
    const body = await readJson(req);
    const known = (await system.monitors(false)).some((monitor) => monitor.device === body.device);
    if (!known) throw notFound('unknown screen');
    await system.setBrightness(body.device, percent(body.level));
    sendJson(res, 200, { ok: true });
  });

  on('POST', '/api/screens/off', async ({ res }) => {
    await system.screensOff();
    log.info('[screens] off');
    sendJson(res, 200, { ok: true });
  });

  // Windows' own projection switcher. The single-screen modes can leave one monitor black, so they must be confirmed.
  on('POST', '/api/screens/project', async ({ req, res }) => {
    const body = await readJson(req);
    const flag = PROJECT_MODES[body.mode];
    if (!flag) throw badRequest('invalid mode');
    if ((body.mode === 'first' || body.mode === 'second') && body.confirm !== true) throw badRequest('confirmation required');
    execFile(path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'DisplaySwitch.exe'), [flag], { windowsHide: true }, () => {});
    log.info(`[screens] projection ${body.mode}`);
    sendJson(res, 200, { ok: true });
  });
};
