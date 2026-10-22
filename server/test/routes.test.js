'use strict';

// src/routes/*: every route through the real dispatcher with fake PC modules (no Windows needed): what is accepted,
// what is refused (400/403/404/409) and what reaches the PC modules.
const assert = require('node:assert');
const http = require('node:http');
const { createRoutes } = require('../src/routes');

const calls = [];
const record = (name, result) => async (...args) => { calls.push([name, ...args]); return typeof result === 'function' ? result(...args) : result; };

const fakeApps = [
  { id: 'aaaaaaaa', name: 'Navegador', proc: 'browser', hasIcon: false, iconVersion: '' },
  { id: 'bbbbbbbb', name: 'Editor', proc: 'editor', hasIcon: false, iconVersion: '' },
  { id: 'cccccccc', name: 'Escondido', proc: 'hidden', hasIcon: false, iconVersion: '' },
];
const window = (name, title) => ({ handle: 100, name, title, state: 'normal', monitor: 0, x: 0, y: 0, w: 10, h: 10 });

const fakes = {
  taskbar: { cachedApps: () => fakeApps, refreshApps: async () => ({ apps: fakeApps, changed: false }), launch: (app) => calls.push(['launch', app.id]) },
  system: {
    windows: record('windows', { running: ['browser'], windows: [window('browser', 'Pagina'), window('textinputhost', 'x'), window('applicationframehost', 'Calculadora')] }),
    focus: record('focus', true),
    mic: record('mic', { muted: false }),
    getVolume: record('getVolume', { volume: 30, muted: false }),
    setVolume: record('setVolume', (level) => ({ volume: level, muted: false })),
    toggleMute: record('toggleMute', { volume: 30, muted: true }),
    setMute: record('setMute', { volume: 30, muted: true }),
    setMic: record('setMic', { muted: true }),
    pressKeys: record('pressKeys', true),
    devices: record('devices', { playback: [{ id: 'dev1', name: 'Alto-falantes' }], capture: [{ id: 'dev2', name: 'Microfone' }] }),
    sessions: record('sessions', []),
    setDefaultDevice: record('setDefaultDevice', true),
    setDeviceVolume: record('setDeviceVolume', true),
    setDeviceMute: record('setDeviceMute', true),
    setSessionVolume: record('setSessionVolume', true),
    setSessionMute: record('setSessionMute', true),
    monitors: record('monitors', [{ device: 'DISPLAY1', brightness: 50 }]),
    setBrightness: record('setBrightness', true),
    windowAction: record('windowAction', (handle) => { if (handle === 404) throw new Error('window not found'); }),
    moveWindow: record('moveWindow', true),
    placeWindow: record('placeWindow', true),
    snapWindow: record('snapWindow', true),
    screensOff: record('screensOff', true),
    onWindowsChanged: () => () => {},
    watchWindows: async () => {},
  },
  media: { state: record('mediaState', { current: null, sessions: [] }), control: record('mediaControl', true), art: record('mediaArt', null) },
  monitor: { sample: record('sample', {}), processes: record('processes', {}), info: record('info', {}) },
  power: { schedule: () => null, info: record('powerInfo', {}), perform: record('perform', {}), ACTIONS: ['shutdown', 'restart', 'cancel'] },
  camera: { MAX_FRAME: 1000, push() {}, wanted: () => false, attach() {}, status: () => ({}) },
  vcam: { status: record('vcamStatus', {}), install: record('vcamInstall', true), uninstall: record('vcamUninstall', true) },
  events: { register() {}, names: () => ['state'], subscribe() {} },
  update: (config, patch) => { calls.push(['update', patch]); Object.assign(config, patch); },
  uiVersion: () => 1,
};

const config = { port: 7878, token: 't', hidden: ['cccccccc'], editor: true, powerControls: true, miniPlayer: false, macros: [], shortcuts: [{ id: 'copy', label: 'Copiar', keys: 'ctrl+c' }], tileOrder: { apps: [], shortcuts: [] } };
const routes = createRoutes(config, fakes);

const server = http.createServer(async (req, res) => {
  if (!(await routes.dispatch({ req, res, url: new URL(req.url, 'http://x') }))) { res.writeHead(404); res.end('{"error":"not found"}'); }
});

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

let passed = 0;
const test = async (name, fn) => { calls.length = 0; await fn(); passed += 1; console.log(`ok     ${name}`); };
const names = () => calls.map((call) => call[0]);

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await test('apps lists the visible taskbar apps only; unknown routes fall through', async () => {
      const { json } = await request('GET', '/api/apps');
      assert.deepStrictEqual(json.apps.map((a) => a.id), ['aaaaaaaa', 'bbbbbbbb']);
      assert.strictEqual((await request('GET', '/api/nope')).status, 404);
      assert.strictEqual(routes.appCount(), 2);
    });

    await test('launch: a listed app starts (or focuses), a hidden or unknown id is 404', async () => {
      assert.strictEqual((await request('POST', '/api/launch/aaaaaaaa')).json.action, 'focused');
      assert.strictEqual((await request('POST', '/api/launch/bbbbbbbb')).json.action, 'launched');
      assert.strictEqual((await request('POST', '/api/launch/cccccccc')).status, 404);
      assert.strictEqual((await request('POST', '/api/launch/..%2f..')).status, 404);
    });

    await test('state combines running apps, volume and the interface version', async () => {
      const { json } = await request('GET', '/api/state');
      assert.deepStrictEqual(json.running, ['aaaaaaaa']);
      assert.strictEqual(json.volume.volume, 30);
      assert.strictEqual(json.ui, 1);
      assert.strictEqual(json.playing, null);
    });

    await test('shortcuts and media keys go to the PC only by known id', async () => {
      assert.strictEqual((await request('POST', '/api/shortcut/copy')).status, 200);
      assert.strictEqual((await request('POST', '/api/shortcut/rm-rf')).status, 404);
      assert.strictEqual((await request('POST', '/api/mediakey/playpause')).status, 200);
      assert.strictEqual((await request('POST', '/api/mediakey/format')).status, 404);
      assert.strictEqual(names().filter((n) => n === 'pressKeys').length, 2);
    });

    await test('mic and volume: bad values are 400, good ones reach the PC', async () => {
      assert.strictEqual((await request('POST', '/api/mic', { muted: 'yes' })).status, 400);
      assert.strictEqual((await request('POST', '/api/mic', { muted: 'toggle' })).status, 200);
      assert.strictEqual((await request('POST', '/api/volume', { level: 'loud' })).status, 400);
      assert.strictEqual((await request('POST', '/api/volume', { level: 250 })).json.volume, 100);
      assert.strictEqual((await request('POST', '/api/volume', { level: -5 })).json.volume, 0);
    });

    await test('audio: only known devices; pid must be a non-negative integer', async () => {
      assert.strictEqual((await request('POST', '/api/audio/default', { id: 'nope' })).status, 404);
      assert.strictEqual((await request('POST', '/api/audio/default', { id: 'dev1' })).status, 200);
      assert.strictEqual((await request('POST', '/api/audio/device', { id: 'nope', level: 10 })).status, 404);
      assert.strictEqual((await request('POST', '/api/audio/session', { pid: -1, level: 10 })).status, 400);
      assert.strictEqual((await request('POST', '/api/audio/session', { pid: 1.5, level: 10 })).status, 400);
      assert.strictEqual((await request('POST', '/api/audio/session', { pid: 'x' })).status, 400);
      assert.strictEqual((await request('POST', '/api/audio/session', { pid: 42, level: 10 })).status, 200);
    });

    await test('media control validates session, action and position', async () => {
      assert.strictEqual((await request('POST', '/api/media/control', { action: 'play' })).status, 400);
      assert.strictEqual((await request('POST', '/api/media/control', { session: 's', action: 'explode' })).status, 400);
      assert.strictEqual((await request('POST', '/api/media/control', { session: 's', action: 'seek', position: -1 })).status, 400);
      assert.strictEqual((await request('POST', '/api/media/control', { session: 's', action: 'seek', position: 30 })).status, 200);
      assert.strictEqual((await request('GET', '/api/media/art?session=s&key=zz')).status, 400);
      assert.strictEqual((await request('GET', '/api/media/art?session=s&key=0123456789ab')).status, 404);
    });

    await test('power: refused without confirm, unknown actions are 400, disabled controls are 403', async () => {
      assert.strictEqual((await request('POST', '/api/power', { action: 'reboot-now' })).status, 400);
      assert.strictEqual((await request('POST', '/api/power', { action: 'shutdown' })).status, 400);
      assert.ok(!names().includes('perform'));
      assert.strictEqual((await request('POST', '/api/power', { action: 'shutdown', confirm: true })).status, 200);
      assert.strictEqual((await request('POST', '/api/power', { action: 'cancel' })).status, 200);
      config.powerControls = false;
      assert.strictEqual((await request('POST', '/api/power', { action: 'cancel' })).status, 403);
      config.powerControls = true;
    });

    await test('windows: handle, monitor, zone and position are validated; a vanished window is 404', async () => {
      assert.strictEqual((await request('POST', '/api/windows/action', { handle: 100, action: 'format' })).status, 400);
      assert.strictEqual((await request('POST', '/api/windows/action', { handle: 'x', action: 'focus' })).status, 400);
      assert.strictEqual((await request('POST', '/api/windows/action', { handle: -1, action: 'focus' })).status, 400);
      assert.strictEqual((await request('POST', '/api/windows/action', { handle: 404, action: 'close' })).status, 404);
      assert.strictEqual((await request('POST', '/api/windows/action', { handle: 100, action: 'close' })).status, 200);
      assert.strictEqual((await request('POST', '/api/windows/move', { handle: 100, monitor: 16 })).status, 400);
      assert.strictEqual((await request('POST', '/api/windows/place', { handle: 100, x: 1e9, y: 0 })).status, 400);
      assert.strictEqual((await request('POST', '/api/windows/snap', { handle: 100, monitor: 0, zone: 'top' })).status, 400);
      assert.strictEqual((await request('POST', '/api/windows/snap', { handle: 100, monitor: 0, zone: 'left' })).status, 200);
    });

    await test('windows list hides shell windows and names UWP and known apps', async () => {
      const { json } = await request('GET', '/api/windows');
      assert.deepStrictEqual(json.windows.map((w) => w.app), ['Navegador', '']);
    });

    await test('screens: brightness only for known screens, single-screen projection needs confirm', async () => {
      assert.strictEqual((await request('POST', '/api/screens/brightness', { device: 'nope', level: 10 })).status, 404);
      assert.strictEqual((await request('POST', '/api/screens/brightness', { device: 'DISPLAY1', level: 10 })).status, 200);
      assert.strictEqual((await request('POST', '/api/screens/project', { mode: 'banana' })).status, 400);
      assert.strictEqual((await request('POST', '/api/screens/project', { mode: 'first' })).status, 400);
    });

    await test('camera: installing or removing the system camera needs an explicit confirm', async () => {
      assert.strictEqual((await request('POST', '/api/camera/direct/install', {})).status, 400);
      assert.strictEqual((await request('POST', '/api/camera/direct/uninstall', { confirm: 'true' })).status, 400);
      assert.ok(!names().includes('vcamInstall') && !names().includes('vcamUninstall'));
      assert.strictEqual((await request('POST', '/api/camera/direct/install', { confirm: true })).status, 200);
    });

    await test('layout: only the two pages and well-formed keys are saved; duplicates collapse', async () => {
      assert.strictEqual((await request('POST', '/api/layout', { page: 'power', order: [] })).status, 400);
      assert.strictEqual((await request('POST', '/api/layout', { page: 'apps', order: ['a:ok', '../x'] })).status, 400);
      assert.strictEqual((await request('POST', '/api/layout', { page: 'apps', order: Array(201).fill('a:x') })).status, 400);
      const saved = await request('POST', '/api/layout', { page: 'apps', order: ['a:one', 'a:two', 'a:one'] });
      assert.deepStrictEqual(saved.json.apps, ['a:one', 'a:two']);
    });

    await test('editor: hidden accepts only known apps; shortcuts and macros are validated before saving', async () => {
      assert.strictEqual((await request('POST', '/api/editor/apps', { hidden: ['ghost'] })).status, 400);
      assert.strictEqual((await request('POST', '/api/editor/apps', { hidden: ['bbbbbbbb'] })).status, 200);
      // the list saved by the editor replaces the old one: bbbbbbbb is hidden now, cccccccc shows again
      assert.deepStrictEqual((await request('GET', '/api/apps')).json.apps.map((a) => a.id), ['aaaaaaaa', 'cccccccc']);
      const bad = await request('POST', '/api/editor/shortcuts', { items: [{ label: 'x', keys: 'ctrl+nonexistentkey' }] });
      assert.ok(bad.status >= 400 && bad.status < 500, String(bad.status));
      assert.strictEqual((await request('POST', '/api/editor/macros', { items: [{ label: 'x', steps: [{ type: 'format-disk' }] }] })).status >= 400, true);
      const good = await request('POST', '/api/editor/shortcuts', { items: [{ label: 'Salvar', keys: 'ctrl+s' }] });
      assert.strictEqual(good.status, 200);
      assert.strictEqual(good.json.shortcuts[0].keys, 'ctrl+s');
    });

    await test('with "editor": false the editor and the layout refuse changes (403)', async () => {
      config.editor = false;
      for (const [path, body] of [['/api/editor/apps', { hidden: [] }], ['/api/editor/shortcuts', { items: [] }], ['/api/editor/macros', { items: [] }], ['/api/layout', { page: 'apps', order: [] }]]) {
        assert.strictEqual((await request('POST', path, body)).status, 403, path);
      }
      assert.strictEqual((await request('GET', '/api/editor')).status, 403);
      config.editor = true;
    });

    await test('macros: unknown ids are 404, and one run of a macro at a time (409)', async () => {
      assert.strictEqual((await request('POST', '/api/macro/ghost')).status, 404);
      config.macros = [{ id: 'm1', label: 'Lento', steps: [{ type: 'wait', ms: 300 }] }];
      const first = request('POST', '/api/macro/m1');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.strictEqual((await request('POST', '/api/macro/m1')).status, 409);
      assert.strictEqual((await first).status, 200);
    });

    await test('events: unknown or missing topics are 400', async () => {
      assert.strictEqual((await request('GET', '/api/events')).status, 400);
      assert.strictEqual((await request('GET', '/api/events?topics=state,secrets')).status, 400);
    });

    await test('an exception inside a PC module becomes a 500 that does not leak a stack', async () => {
      fakes.system.getVolume = async () => { throw new Error('helper died'); };
      const res = await request('GET', '/api/volume');
      assert.strictEqual(res.status, 500);
      assert.deepStrictEqual(res.json, { error: 'helper died' });
    });
  } finally {
    server.close();
  }
  console.log(`${passed} passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
