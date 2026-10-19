'use strict';

const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { ICON_DIR, update } = require('./config');
const macros = require('./macros');
const taskbar = require('./taskbar');
const system = require('./system');
const media = require('./media');
const monitor = require('./monitor');
const power = require('./power');
const camera = require('./camera');
const vcam = require('./vcam');
const keys = require('./keys');
const { sendJson, sendBuffer, sendFile, readJson, readBuffer, uiVersion } = require('./http');

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const notFound = (message) => Object.assign(new Error(message), { status: 404 });

function number(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`${name} must be a number`);
  return parsed;
}

const percent = (value) => Math.max(0, Math.min(100, Math.round(number(value, 'level'))));

function createRoutes(config) {
  let apps = [];

  let allApps = []; // every taskbar app, hidden ones included (the editor lists them all)

  // `apps` is what the deck shows: the taskbar apps without the hidden ones (the order on screen is the deck's tileOrder)
  function applyAppConfig() {
    const hidden = new Set(config.hidden || []);
    apps = allApps.filter((app) => !hidden.has(app.id));
  }

  const refreshApps = async () => {
    allApps = await taskbar.listApps([]);
    applyAppConfig();
    return apps;
  };

  // Shortcuts come only from config.json (or the editor, which validates them) and are sent by id.
  let shortcuts = [];
  function loadShortcuts() {
    shortcuts = [];
    for (const [index, entry] of (config.shortcuts || []).entries()) {
      try {
        shortcuts.push({
          id: String(entry.id ?? `shortcut-${index}`),
          label: String(entry.label ?? entry.keys),
          keys: String(entry.keys),
          display: keys.display(entry.keys),
          vks: keys.parse(entry.keys),
        });
      } catch (err) {
        console.warn(`[shortcuts] ignoring "${entry.label ?? entry.id}": ${err.message}`);
      }
    }
  }
  loadShortcuts();

  // Macros: lists of whitelisted steps, validated when saved (src/macros.js)
  const macroList = () => (Array.isArray(config.macros) ? config.macros.filter((macro) => macro && macro.id && Array.isArray(macro.steps)) : []);
  const macrosRunning = new Set(); // macros being run: one run of each at a time

  const MEDIA_KEYS = { prev: keys.vkOf('prevtrack'), playpause: keys.vkOf('playpause'), next: keys.vkOf('nexttrack') };
  const MEDIA_ACTIONS = new Set(['toggle', 'play', 'pause', 'next', 'previous', 'seek']);

  // Which apps are running / have a window. Several panels ask in the same second, so share one lookup.
  let snapshot = { at: 0, promise: null };
  const windowSnapshot = () => {
    if (!snapshot.promise || Date.now() - snapshot.at > 1500) {
      snapshot = { at: Date.now(), promise: system.windows() };
      snapshot.promise.catch(() => { snapshot.at = 0; });
    }
    return snapshot.promise;
  };

  async function knownDeviceIds() {
    const { playback, capture } = await system.devices();
    return new Set([...playback, ...capture].map((device) => device.id));
  }

  // --- route table ----------------------------------------------------------------------------

  const table = [];
  const on = (method, pattern, handler) => table.push({ method, pattern, handler });

  on('GET', '/api/ping', async ({ res }) => sendJson(res, 200, { ok: true }));

  // apps
  on('GET', '/api/apps', async ({ res }) =>
    sendJson(res, 200, {
      host: os.hostname(),
      apps: apps.map(({ id, name, hasIcon, iconVersion }) => ({ id, name, hasIcon, iconVersion })),
    }));

  // What is playing, for the header's mini player. Several clients/pages ask within the same second: share one lookup.
  let playingCache = { at: 0, promise: null };
  async function readNowPlaying() {
    try {
      const { current, sessions } = await media.state();
      const session = sessions.find((s) => s.id === current) || sessions.find((s) => s.status === 'playing') || sessions[0];
      if (!session) return null;
      return { session: session.id, title: session.title, artist: session.artist, app: session.app, status: session.status, canToggle: session.canPlay || session.canPause };
    } catch {
      return null;
    }
  }
  const nowPlaying = () => {
    if (config.miniPlayer === false) return Promise.resolve(null);
    if (!playingCache.promise || Date.now() - playingCache.at > 1500) playingCache = { at: Date.now(), promise: readNowPlaying() };
    return playingCache.promise;
  };

  on('GET', '/api/state', async ({ res }) => {
    // one request carries everything the header and the volume strip show, so the phone asks once per tick
    const [{ running, windows }, mic, playing, volume] = await Promise.all([
      windowSnapshot().catch(() => ({ running: [], windows: [] })),
      system.mic().catch(() => null),
      nowPlaying(),
      system.getVolume().catch(() => null),
    ]);
    const runningNames = new Set(running);
    const windowNames = new Set(windows.map((window) => window.name));
    sendJson(res, 200, {
      running: apps.filter((app) => app.proc && runningNames.has(app.proc)).map((app) => app.id),
      open: apps.filter((app) => app.proc && windowNames.has(app.proc)).map((app) => app.id),
      scheduled: power.schedule(), // a pending shutdown/restart, shown as a pill in the header
      mic,
      volume,
      playing,
      miniPlayer: config.miniPlayer !== false,
      ui: uiVersion(), // the page reloads itself when this changes
    });
  });

  on('POST', '/api/mic', async ({ req, res }) => {
    const { muted } = await readJson(req);
    if (muted !== 'toggle' && typeof muted !== 'boolean') throw badRequest('muted must be true, false or "toggle"');
    sendJson(res, 200, await system.setMic(muted));
  });

  on('GET', '/api/icon/:id', async ({ res, params }) => {
    const app = allApps.find((candidate) => candidate.id === params.id);
    if (!app || !app.hasIcon) throw notFound('not found');
    // the URL carries ?v=<icon hash>, so a cached copy can never be stale
    sendFile(res, path.join(ICON_DIR, `${app.id}.png`), 'image/png', { 'Cache-Control': 'max-age=31536000, immutable' });
  });

  // the phone's camera as a webcam: frames in, an MJPEG stream out (see camera.js)
  const cameraLink = () => `http://127.0.0.1:${config.port}/camera.html?token=${config.token}`;
  on('POST', '/api/camera/frame', async ({ req, res }) => {
    camera.push(await readBuffer(req, camera.MAX_FRAME));
    res.writeHead(204);
    res.end();
  });
  on('GET', '/api/camera/stream', async ({ req, res }) => camera.attach(req, res));
  on('GET', '/api/camera/status', async ({ res }) => sendJson(res, 200, { ...camera.status(), link: cameraLink(), direct: await vcam.status() }));
  // the direct virtual camera (no OBS): installing registers a system-wide camera device, so it needs an explicit confirm
  on('POST', '/api/camera/direct/install', async ({ req, res }) => {
    const { confirm } = await readJson(req);
    if (confirm !== true) throw badRequest('confirm must be true');
    await vcam.install();
    sendJson(res, 200, await vcam.status());
  });
  on('POST', '/api/camera/direct/uninstall', async ({ req, res }) => {
    const { confirm } = await readJson(req);
    if (confirm !== true) throw badRequest('confirm must be true');
    await vcam.uninstall();
    sendJson(res, 200, await vcam.status());
  });
  // puts the link for OBS's Browser Source on this PC's clipboard, so nobody has to type a token
  on('POST', '/api/camera/copy-link', async ({ res }) => {
    await new Promise((resolve, reject) => {
      const child = spawn('clip.exe', [], { windowsHide: true });
      child.on('error', reject);
      child.on('close', resolve);
      child.stdin.end(cameraLink());
    });
    sendJson(res, 200, { ok: true });
  });

  on('POST', '/api/refresh', async ({ res }) => sendJson(res, 200, { count: (await refreshApps()).length }));

  // Only ids from the taskbar list can be launched, never arbitrary paths. An app that already has a window is
  // brought to the front instead of being started again.
  async function launchApp(app) {
    if (app.proc) {
      try {
        const { windows } = await windowSnapshot();
        if (windows.some((window) => window.name === app.proc) && (await system.focus(app.proc))) {
          console.log(`[focus] ${app.name}`);
          return 'focused';
        }
      } catch (err) {
        console.warn(`[focus] ${app.name}: ${err.message}`);
      }
    }
    taskbar.launch(app);
    console.log(`[launch] ${app.name}`);
    return 'launched';
  }

  on('POST', '/api/launch/:id', async ({ res, params }) => {
    const app = apps.find((candidate) => candidate.id === params.id);
    if (!app) throw notFound('unknown app');
    sendJson(res, 200, { ok: true, name: app.name, action: await launchApp(app) });
  });

  // keyboard shortcuts
  on('GET', '/api/shortcuts', async ({ res }) =>
    sendJson(res, 200, { shortcuts: shortcuts.map(({ id, label, display }) => ({ id, label, display })) }));

  on('POST', '/api/shortcut/:id', async ({ res, params }) => {
    const shortcut = shortcuts.find((candidate) => candidate.id === params.id);
    if (!shortcut) throw notFound('unknown shortcut');
    await system.pressKeys(shortcut.vks);
    console.log(`[shortcut] ${shortcut.label} (${shortcut.display})`);
    sendJson(res, 200, { ok: true, label: shortcut.label });
  });

  // --- macros ---------------------------------------------------------------------------------

  on('GET', '/api/macros', async ({ res }) =>
    sendJson(res, 200, { macros: macroList().map(({ id, label, page, steps }) => ({ id, label, page: page || 'shortcuts', steps: steps.length })) }));

  // One handler per step type; each throws when its step cannot be done. Apps and devices are looked up by id here, at run time.
  const macroHandlers = {
    async launch(step) {
      const app = allApps.find((candidate) => candidate.id === step.app);
      if (!app) throw new Error('app not on the taskbar anymore');
      await launchApp(app);
    },
    async keys(step) { await system.pressKeys(keys.parse(step.keys)); },
    async media(step) { await system.pressKeys([MEDIA_KEYS[step.key]]); },
    async volume(step) { await system.setVolume(step.level); },
    async mute(step) {
      if (step.muted === 'toggle') await system.toggleMute();
      else await system.setMute(step.muted);
    },
    async mic(step) { await system.setMic(step.muted); },
    async output(step) {
      if (!(await knownDeviceIds()).has(step.device)) throw new Error(`device not found${step.name ? `: ${step.name}` : ''}`);
      await system.setDefaultDevice(step.device);
    },
    // brings an app's window to a screen's half or full size, waiting a few seconds for the window to exist (it may just have been launched)
    async place(step) {
      const app = allApps.find((candidate) => candidate.id === step.app);
      if (!app || !app.proc) throw new Error('app not found');
      const until = Date.now() + 8000;
      for (;;) {
        const { windows } = await system.windows();
        const window = windows.find((item) => item.name === app.proc && item.title);
        if (window) {
          await system.snapWindow(window.handle, step.monitor, step.zone);
          return;
        }
        if (Date.now() > until) throw new Error(`${app.name} has no window`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    },
  };

  on('POST', '/api/macro/:id', async ({ res, params }) => {
    const macro = macroList().find((candidate) => candidate.id === params.id);
    if (!macro) throw notFound('unknown macro');
    if (macrosRunning.has(macro.id)) throw Object.assign(new Error('this macro is already running'), { status: 409 });
    macrosRunning.add(macro.id);
    try {
      const outcome = await macros.run(macro, macroHandlers);
      console.log(`[macro] ${macro.label}: ${outcome.results.length - outcome.failed}/${outcome.results.length} steps`);
      sendJson(res, 200, { ok: outcome.failed === 0, label: macro.label, steps: outcome.results, client: outcome.client });
    } finally {
      macrosRunning.delete(macro.id);
    }
  });

  // --- the button editor ------------------------------------------------------------------------
  // Everything it saves is validated against a whitelist (src/macros.js). The editor can be turned off with "editor": false.

  const editorOn = () => {
    if (config.editor === false) throw Object.assign(new Error('the editor is turned off in config.json'), { status: 403 });
  };

  on('GET', '/api/editor', async ({ res }) => {
    editorOn();
    const hidden = new Set(config.hidden || []);
    const [devices, monitors] = await Promise.all([system.devices().catch(() => ({ playback: [], capture: [] })), system.monitors(false).catch(() => [])]);
    sendJson(res, 200, {
      shortcuts: shortcuts.map(({ id, label, keys: spec, display }) => ({ id, label, keys: spec, display })),
      macros: macroList(),
      apps: allApps.map(({ id, name, hasIcon, iconVersion, proc }) => ({ id, name, hasIcon, iconVersion, hidden: hidden.has(id), canPlace: Boolean(proc) })),
      devices: { playback: devices.playback.map(({ id, name }) => ({ id, name })), capture: devices.capture.map(({ id, name }) => ({ id, name })) },
      screens: monitors.length || 1,
    });
  });

  on('POST', '/api/editor/shortcuts', async ({ req, res }) => {
    editorOn();
    const { items } = await readJson(req, 64 * 1024);
    update(config, { shortcuts: macros.normalizeShortcuts(items) });
    loadShortcuts();
    console.log(`[editor] ${config.shortcuts.length} shortcuts saved`);
    sendJson(res, 200, { shortcuts: shortcuts.map(({ id, label, keys: spec, display }) => ({ id, label, keys: spec, display })) });
  });

  on('POST', '/api/editor/macros', async ({ req, res }) => {
    editorOn();
    const { items } = await readJson(req, 128 * 1024);
    update(config, { macros: macros.normalizeMacros(items, new Set(allApps.map((app) => app.id))) });
    console.log(`[editor] ${config.macros.length} macros saved`);
    sendJson(res, 200, { macros: macroList() });
  });

  on('POST', '/api/editor/apps', async ({ req, res }) => {
    editorOn();
    const { hidden } = await readJson(req, 64 * 1024);
    const known = new Set(allApps.map((app) => app.id));
    if (!Array.isArray(hidden) || hidden.length > 200 || hidden.some((id) => typeof id !== 'string' || !known.has(id))) throw badRequest('invalid hidden');
    update(config, { hidden: [...new Set(hidden)] });
    applyAppConfig();
    console.log(`[editor] apps: ${config.hidden.length} hidden`);
    sendJson(res, 200, { ok: true });
  });

  // Where each key sits on the Apps and Shortcuts pages. Holding and dragging a key on the deck saves it here.
  const TILE_KEY = /^[asmc]:[A-Za-z0-9-]{1,48}$/;
  const tileOrder = () => ({ apps: [], shortcuts: [], ...(config.tileOrder || {}) });
  on('GET', '/api/layout', async ({ res }) => sendJson(res, 200, tileOrder()));
  on('POST', '/api/layout', async ({ req, res }) => {
    editorOn();
    const { page, order } = await readJson(req, 64 * 1024);
    if (page !== 'apps' && page !== 'shortcuts') throw badRequest('invalid page');
    if (!Array.isArray(order) || order.length > 200 || order.some((key) => typeof key !== 'string' || !TILE_KEY.test(key))) throw badRequest('invalid order');
    update(config, { tileOrder: { ...tileOrder(), [page]: [...new Set(order)] } });
    sendJson(res, 200, tileOrder());
  });

  // global media keys (what the strip buttons send); the Media page talks to a specific player instead
  on('POST', '/api/mediakey/:key', async ({ res, params }) => {
    const vk = MEDIA_KEYS[params.key];
    if (!vk) throw notFound('unknown media key');
    await system.pressKeys([vk]);
    sendJson(res, 200, { ok: true });
  });

  // master volume
  on('GET', '/api/volume', async ({ res }) => sendJson(res, 200, await system.getVolume()));
  on('POST', '/api/volume', async ({ req, res }) => {
    const body = await readJson(req);
    let result;
    if (body.level !== undefined) result = await system.setVolume(percent(body.level));
    if (body.muted === 'toggle') result = await system.toggleMute();
    else if (typeof body.muted === 'boolean') result = await system.setMute(body.muted);
    sendJson(res, 200, result ?? (await system.getVolume()));
  });

  // advanced audio: devices and per-application mixer
  on('GET', '/api/audio', async ({ res }) => {
    const [devices, sessions] = await Promise.all([system.devices(), system.sessions().catch(() => [])]);
    sendJson(res, 200, { ...devices, sessions });
  });

  on('POST', '/api/audio/default', async ({ req, res }) => {
    const { id } = await readJson(req);
    if (!(await knownDeviceIds()).has(id)) throw notFound('unknown device');
    await system.setDefaultDevice(id);
    console.log(`[audio] default device -> ${id}`);
    sendJson(res, 200, { ok: true });
  });

  on('POST', '/api/audio/device', async ({ req, res }) => {
    const body = await readJson(req);
    if (!(await knownDeviceIds()).has(body.id)) throw notFound('unknown device');
    if (body.level !== undefined) await system.setDeviceVolume(body.id, percent(body.level));
    if (typeof body.muted === 'boolean') await system.setDeviceMute(body.id, body.muted);
    sendJson(res, 200, { ok: true });
  });

  on('POST', '/api/audio/session', async ({ req, res }) => {
    const body = await readJson(req);
    const isSystemSounds = body.system === true;
    const pid = isSystemSounds ? 0 : number(body.pid, 'pid');
    if (!Number.isInteger(pid) || pid < 0) throw badRequest('invalid pid');
    if (body.level !== undefined) await system.setSessionVolume(pid, isSystemSounds, percent(body.level));
    if (typeof body.muted === 'boolean') await system.setSessionMute(pid, isSystemSounds, body.muted);
    sendJson(res, 200, { ok: true });
  });

  // now playing (Windows media session: Spotify, YouTube in a browser, ...)
  on('GET', '/api/media', async ({ res }) => sendJson(res, 200, await media.state()));

  on('POST', '/api/media/control', async ({ req, res }) => {
    const body = await readJson(req);
    if (typeof body.session !== 'string' || !body.session || body.session.length > 300) throw badRequest('invalid session');
    if (!MEDIA_ACTIONS.has(body.action)) throw badRequest('invalid action');
    const position = body.action === 'seek' ? number(body.position, 'position') : undefined;
    if (position !== undefined && (position < 0 || position > 7 * 24 * 3600)) throw badRequest('invalid position');
    sendJson(res, 200, { ok: true, accepted: await media.control(body.session, body.action, position) });
  });

  on('GET', '/api/media/art', async ({ res, url }) => {
    const session = url.searchParams.get('session') || '';
    const key = url.searchParams.get('key') || '';
    if (!session || !/^[0-9a-f]{12}$/.test(key)) throw badRequest('invalid art request');
    const art = await media.art(session, key);
    if (!art) throw notFound('no artwork');
    sendBuffer(res, art.data, art.mime, { 'Cache-Control': 'max-age=31536000, immutable' }); // the key changes per track
  });

  // system monitor
  on('GET', '/api/monitor/sample', async ({ res }) => sendJson(res, 200, await monitor.sample()));
  on('GET', '/api/monitor/processes', async ({ res }) => sendJson(res, 200, await monitor.processes()));
  on('GET', '/api/monitor/info', async ({ res }) => sendJson(res, 200, await monitor.info()));

  // power
  on('GET', '/api/power', async ({ res }) => {
    const appNames = new Map(apps.filter((app) => app.proc).map((app) => [app.proc, app.name]));
    sendJson(res, 200, { enabled: config.powerControls !== false, ...(await power.info(appNames)) });
  });
  on('POST', '/api/power', async ({ req, res }) => {
    if (config.powerControls === false) throw Object.assign(new Error('power controls are disabled in config.json'), { status: 403 });
    const body = await readJson(req);
    if (!power.ACTIONS.includes(body.action)) throw badRequest('unknown action');
    // a destructive action must say so explicitly; the UI asks the person to hold the button
    if (body.action !== 'cancel' && body.confirm !== true) throw badRequest('confirmation required');

    const options = { action: body.action, delaySec: body.delaySec, force: body.force === true, hybrid: body.hybrid === true };
    const result = await power.perform(options);
    console.log(`[power] ${body.action}${options.delaySec ? ` in ${options.delaySec}s` : ''}${options.force ? ' (force)' : ''}`);
    sendJson(res, 200, { ok: true, ...result });
  });

  // windows and screens (Deck > Janelas). Actions name a window by handle, and the helper only acts on handles
  // that are in the live window list.
  const WINDOW_ACTIONS = new Set(['focus', 'minimize', 'maximize', 'restore', 'close']);
  const SHELL_WINDOWS = new Set(['textinputhost', 'searchhost', 'startmenuexperiencehost', 'shellexperiencehost', 'lockapp']);
  const PROJECT_MODES = { extend: '/extend', clone: '/clone', first: '/internal', second: '/external' };
  const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

  function handleOf(body) {
    const handle = Number(body.handle);
    if (!Number.isSafeInteger(handle) || handle <= 0) throw badRequest('invalid window handle');
    return handle;
  }

  on('GET', '/api/windows', async ({ res }) => {
    const { windows } = await system.windows();
    const byProcess = new Map(apps.filter((app) => app.proc).map((app) => [app.proc, app]));
    const visible = windows.filter((window) => !SHELL_WINDOWS.has(window.name) && window.title !== 'Program Manager');
    sendJson(res, 200, {
      windows: visible.map((window) => {
        const app = byProcess.get(window.name);
        // UWP apps all run inside ApplicationFrameHost: their title is the useful part
        const label = window.name === 'applicationframehost' ? '' : window.name === 'explorer' ? 'Explorador de Arquivos' : app ? app.name : capitalize(window.name);
        return {
          handle: window.handle, title: window.title, app: label, appId: app ? app.id : null, iconVersion: app ? app.iconVersion : '',
          state: window.state, monitor: window.monitor, x: window.x, y: window.y, w: window.w, h: window.h,
        };
      }),
    });
  });

  // the helper says "window not found" when the handle is not in the live list (the window just closed, or a bad id)
  const gone = (err) => { throw err.message === 'window not found' ? notFound(err.message) : err; };

  on('POST', '/api/windows/action', async ({ req, res }) => {
    const body = await readJson(req);
    if (!WINDOW_ACTIONS.has(body.action)) throw badRequest('invalid action');
    await system.windowAction(handleOf(body), body.action).catch(gone);
    console.log(`[window] ${body.action} ${body.handle}`);
    sendJson(res, 200, { ok: true });
  });

  on('POST', '/api/windows/move', async ({ req, res }) => {
    const body = await readJson(req);
    const monitor = Number(body.monitor);
    if (!Number.isInteger(monitor) || monitor < 0 || monitor > 15) throw badRequest('invalid monitor');
    await system.moveWindow(handleOf(body), monitor).catch(gone);
    console.log(`[window] move ${body.handle} -> screen ${monitor + 1}`);
    sendJson(res, 200, { ok: true });
  });

  // the position inside the virtual desktop is in real pixels; the page draws the layout to scale
  on('POST', '/api/windows/place', async ({ req, res }) => {
    const body = await readJson(req);
    const x = Math.round(number(body.x, 'x'));
    const y = Math.round(number(body.y, 'y'));
    if (Math.abs(x) > 100000 || Math.abs(y) > 100000) throw badRequest('position out of range');
    await system.placeWindow(handleOf(body), x, y).catch(gone);
    console.log(`[window] place ${body.handle} -> ${x},${y}`);
    sendJson(res, 200, { ok: true });
  });

  on('POST', '/api/windows/snap', async ({ req, res }) => {
    const body = await readJson(req);
    const monitor = Number(body.monitor);
    if (!Number.isInteger(monitor) || monitor < 0 || monitor > 15) throw badRequest('invalid monitor');
    if (!['left', 'right', 'full'].includes(body.zone)) throw badRequest('invalid zone');
    await system.snapWindow(handleOf(body), monitor, body.zone).catch(gone);
    console.log(`[window] snap ${body.zone} ${body.handle} -> screen ${monitor + 1}`);
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
    console.log('[screens] off');
    sendJson(res, 200, { ok: true });
  });

  // Windows' own projection switcher. The single-screen modes can leave one monitor black, so they must be confirmed.
  on('POST', '/api/screens/project', async ({ req, res }) => {
    const body = await readJson(req);
    const flag = PROJECT_MODES[body.mode];
    if (!flag) throw badRequest('invalid mode');
    if ((body.mode === 'first' || body.mode === 'second') && body.confirm !== true) throw badRequest('confirmation required');
    execFile(path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'DisplaySwitch.exe'), [flag], { windowsHide: true }, () => {});
    console.log(`[screens] projection ${body.mode}`);
    sendJson(res, 200, { ok: true });
  });

  // --- matching -------------------------------------------------------------------------------

  const compiled = table.map((entry) => {
    const names = [];
    const source = entry.pattern.replace(/:(\w+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
    return { ...entry, regex: new RegExp(`^${source}$`), names };
  });

  async function dispatch(ctx) {
    const { req, res, url } = ctx;
    for (const route of compiled) {
      if (route.method !== req.method) continue;
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
      try {
        await route.handler({ ...ctx, params });
      } catch (err) {
        if (res.headersSent) return true;
        if (!err.status) console.error(`[${req.method} ${url.pathname}]`, err.message);
        sendJson(res, err.status || 500, { error: err.message });
      }
      return true;
    }
    return false;
  }

  return { dispatch, refreshApps, appCount: () => apps.length };
}

module.exports = { createRoutes };
