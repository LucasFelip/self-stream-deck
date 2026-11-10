'use strict';

// The behaviour cases. Each one is a request and the status the contract promises; the runner also validates the answer
// (and, for 2xx cases, the request body) against contracts/openapi.yaml. Cases run in order and share the fake PC's state.
//
//   target: 'default' (everything on) or 'locked' (config.json with "editor": false and "powerControls": false)
//   osEffect: the route itself runs an OS program (clipboard, display switcher): skipped unless the target runs on a fake platform
//   orClosed: the server may drop the connection instead of sending the 413 (the Node server destroys the socket of an oversize body); both count
//   fixtureBound: needs the ids of contracts/fixtures/fake-pc.json: skipped on an agent whose fake PC is its own
//   expectType: the content type the answer must have; firstChunk: a stream: take the first chunk and hang up
//   inProcess: needs a hook into the Node fakes (fault injection); other implementations cover it with their own fake platform
//   check(res, env): extra assertions on the parsed answer; env = { calls, fixture, assert }

const FIXTURE_APPS = ['aaaaaaaa', 'bbbbbbbb', 'dddddddd']; // visible apps (cccccccc is hidden by the config)
const big = (bytes) => Buffer.alloc(bytes, 0x61);

const cases = [
  // ---- system
  { name: 'ping', method: 'GET', path: '/api/ping', status: 200 },
  { name: 'request counters', method: 'GET', path: '/api/requests', status: 200, check: (r, e) => e.assert.ok(Object.keys(r.json.counts).length > 0) },
  { name: 'pair-code is the token', method: 'GET', path: '/api/pair-code', status: 200, check: (r, e) => e.assert.strictEqual(r.json.code, e.fixture.token) },
  { name: 'an unknown route is a JSON 404', method: 'GET', path: '/api/nope', status: 404, spec: false, check: (r, e) => e.assert.ok(typeof r.json.error === 'string') },

  // ---- apps
  { name: 'apps lists the visible taskbar apps only', method: 'GET', path: '/api/apps', status: 200, check: (r, e) => e.assert.deepStrictEqual(r.json.apps.map((a) => a.id), FIXTURE_APPS) },
  { name: 'icon of an app without icon is 404', method: 'GET', path: '/api/icon/aaaaaaaa', status: 404 },
  { name: 'icon of an unknown id is 404', method: 'GET', path: '/api/icon/zzzzzzzz', status: 404 },
  { name: 'state: running apps, volume, now playing', method: 'GET', path: '/api/state', status: 200, check: (r, e) => {
    e.assert.deepStrictEqual(r.json.running, ['aaaaaaaa', 'bbbbbbbb']);
    e.assert.strictEqual(r.json.volume.level, e.fixture.volume.level);
    e.assert.strictEqual(r.json.playing.session, 's1');
    e.assert.strictEqual(r.json.scheduled, null);
  } },
  { name: 'refresh reads the taskbar again', method: 'POST', path: '/api/refresh', status: 200, check: (r, e) => e.assert.strictEqual(r.json.count, FIXTURE_APPS.length) },
  { name: 'launch focuses an app that already has a window', fixtureBound: true, method: 'POST', path: '/api/launch/aaaaaaaa', status: 200, check: (r, e) => e.assert.strictEqual(r.json.action, 'focused') },
  { name: 'launch starts an app without a window', fixtureBound: true, method: 'POST', path: '/api/launch/dddddddd', status: 200, check: (r, e) => e.assert.strictEqual(r.json.action, 'launched') },
  { name: 'launch of a hidden app is 404', method: 'POST', path: '/api/launch/cccccccc', status: 404 },
  { name: 'launch never takes a path', method: 'POST', path: '/api/launch/..%2f..%2fwindows', status: 404 },

  // ---- keys, macros
  { name: 'mic: toggle', method: 'POST', path: '/api/mic', body: { muted: 'toggle' }, status: 200, check: (r, e) => e.assert.strictEqual(r.json.muted, true) },
  { name: 'mic: back to unmuted', method: 'POST', path: '/api/mic', body: { muted: false }, status: 200, check: (r, e) => e.assert.strictEqual(r.json.muted, false) },
  { name: 'mic: any other value is 400', method: 'POST', path: '/api/mic', body: { muted: 'yes' }, status: 400 },
  { name: 'shortcuts hide the key combination', method: 'GET', path: '/api/shortcuts', status: 200, check: (r, e) => {
    e.assert.deepStrictEqual(r.json.shortcuts.map((s) => s.id), ['copy', 'paste']);
    e.assert.strictEqual(r.json.shortcuts[0].display, 'Ctrl+C');
    e.assert.ok(!('keys' in r.json.shortcuts[0]));
  } },
  { name: 'shortcut: a known id presses the keys', method: 'POST', path: '/api/shortcut/copy', status: 200, check: (r, e) => e.assert.ok(e.calls.some((c) => c[0] === 'pressKeys')) },
  { name: 'shortcut: an unknown id is 404 and presses nothing', method: 'POST', path: '/api/shortcut/rm-rf', status: 404, check: (r, e) => e.assert.strictEqual(e.calls.filter((c) => c[0] === 'pressKeys').length, 0) },
  { name: 'media key', method: 'POST', path: '/api/mediakey/playpause', status: 200 },
  { name: 'media key: unknown is 404', method: 'POST', path: '/api/mediakey/format', status: 404 },
  { name: 'macros list counts the steps', method: 'GET', path: '/api/macros', status: 200, check: (r, e) => e.assert.deepStrictEqual(r.json.macros.map((m) => [m.id, m.steps]), [['foco', 2], ['lento', 1]]) },
  { name: 'macro runs its steps in order', method: 'POST', path: '/api/macro/foco', status: 200, check: (r, e) => {
    e.assert.strictEqual(r.json.ok, true);
    e.assert.deepStrictEqual(r.json.steps.map((s) => s.type), ['volume', 'mute']);
    e.assert.deepStrictEqual(e.calls.map((c) => c[0]).filter((n) => n === 'setVolume' || n === 'setMute'), ['setVolume', 'setMute']);
  } },
  { name: 'macro: unknown id is 404', method: 'POST', path: '/api/macro/ghost', status: 404 },
  { name: 'macro: a second run while it is running is 409', method: 'POST', path: '/api/macro/lento', status: 409, concurrentWith: { method: 'POST', path: '/api/macro/lento', status: 200 } },

  // ---- audio
  { name: 'volume read (the foco macro above set it to 20)', method: 'GET', path: '/api/volume', status: 200, check: (r, e) => e.assert.deepStrictEqual(r.json, { level: 20, muted: false }) },
  { name: 'volume above 100 is clamped', method: 'POST', path: '/api/volume', body: { level: 250 }, status: 200, check: (r, e) => e.assert.strictEqual(r.json.level, 100) },
  { name: 'volume below 0 is clamped', method: 'POST', path: '/api/volume', body: { level: -5 }, status: 200, check: (r, e) => e.assert.strictEqual(r.json.level, 0) },
  { name: 'volume: not a number is 400', method: 'POST', path: '/api/volume', body: { level: 'loud' }, status: 400 },
  { name: 'volume: toggle mute', method: 'POST', path: '/api/volume', body: { muted: 'toggle' }, status: 200, check: (r, e) => e.assert.strictEqual(r.json.muted, true) },
  { name: 'volume: restore level and mute', method: 'POST', path: '/api/volume', body: { level: 30 }, status: 200, check: (r, e) => e.assert.deepStrictEqual(r.json, { level: 30, muted: false }) },
  { name: 'audio: devices and mixer', method: 'GET', path: '/api/audio', status: 200, check: (r, e) => e.assert.deepStrictEqual(r.json, e.fixture.audio) },
  { name: 'audio default: a known device', method: 'POST', path: '/api/audio/default', body: { id: 'out2' }, status: 200 },
  { name: 'audio default: an unknown device is 404', method: 'POST', path: '/api/audio/default', body: { id: 'nope' }, status: 404 },
  { name: 'audio device: level and mute', method: 'POST', path: '/api/audio/device', body: { id: 'out2', level: 10, muted: true }, status: 200 },
  { name: 'audio device: unknown is 404', method: 'POST', path: '/api/audio/device', body: { id: 'nope', level: 10 }, status: 404 },
  { name: 'audio session: by pid', method: 'POST', path: '/api/audio/session', body: { pid: 11, level: 10 }, status: 200 },
  { name: 'audio session: the system sounds', method: 'POST', path: '/api/audio/session', body: { system: true, muted: true }, status: 200 },
  { name: 'audio session: negative pid is 400', method: 'POST', path: '/api/audio/session', body: { pid: -1, level: 10 }, status: 400 },
  { name: 'audio session: fractional pid is 400', method: 'POST', path: '/api/audio/session', body: { pid: 1.5, level: 10 }, status: 400 },
  { name: 'audio session: text pid is 400', method: 'POST', path: '/api/audio/session', body: { pid: 'x' }, status: 400 },

  // ---- media
  { name: 'media: players', method: 'GET', path: '/api/media', status: 200, check: (r, e) => e.assert.deepStrictEqual(r.json, e.fixture.media) },
  { name: 'media control: seek', method: 'POST', path: '/api/media/control', body: { session: 's1', action: 'seek', position: 30 }, status: 200, check: (r, e) => e.assert.strictEqual(r.json.accepted, true) },
  { name: 'media control: toggle', method: 'POST', path: '/api/media/control', body: { session: 's1', action: 'toggle' }, status: 200 },
  { name: 'media control: a session is required', method: 'POST', path: '/api/media/control', body: { action: 'play' }, status: 400 },
  { name: 'media control: unknown action is 400', method: 'POST', path: '/api/media/control', body: { session: 's1', action: 'explode' }, status: 400 },
  { name: 'media control: seek needs a position', method: 'POST', path: '/api/media/control', body: { session: 's1', action: 'seek' }, status: 400 },
  { name: 'media control: negative position is 400', method: 'POST', path: '/api/media/control', body: { session: 's1', action: 'seek', position: -1 }, status: 400 },
  { name: 'media art: the current track', method: 'GET', path: '/api/media/art?session=s1&key=0123456789ab', status: 200, contentType: 'image/png' },
  { name: 'media art: a malformed key is 400', method: 'GET', path: '/api/media/art?session=s1&key=zz', status: 400 },
  { name: 'media art: another track is 404', fixtureBound: true, method: 'GET', path: '/api/media/art?session=s1&key=ffffffffffff', status: 404 },

  // ---- windows and screens
  { name: 'windows: shell windows are left out and apps are named', method: 'GET', path: '/api/windows', status: 200, check: (r, e) => {
    e.assert.deepStrictEqual(r.json.windows.map((w) => [w.handle, w.app]), [[101, 'Editor'], [102, 'Navegador'], [104, '']]);
    e.assert.strictEqual(r.json.windows[0].appId, 'bbbbbbbb');
  } },
  { name: 'window action: focus', method: 'POST', path: '/api/windows/action', body: { handle: 101, action: 'focus' }, status: 200 },
  { name: 'window action: unknown action is 400', method: 'POST', path: '/api/windows/action', body: { handle: 101, action: 'format' }, status: 400 },
  { name: 'window action: text handle is 400', method: 'POST', path: '/api/windows/action', body: { handle: 'x', action: 'focus' }, status: 400 },
  { name: 'window action: negative handle is 400', method: 'POST', path: '/api/windows/action', body: { handle: -1, action: 'focus' }, status: 400 },
  { name: 'window action: a vanished window is 404', method: 'POST', path: '/api/windows/action', body: { handle: 999, action: 'close' }, status: 404 },
  { name: 'window move', method: 'POST', path: '/api/windows/move', body: { handle: 101, monitor: 0 }, status: 200 },
  { name: 'window move: screen 16 is 400', method: 'POST', path: '/api/windows/move', body: { handle: 101, monitor: 16 }, status: 400 },
  { name: 'window move: a vanished window is 404', method: 'POST', path: '/api/windows/move', body: { handle: 999, monitor: 0 }, status: 404 },
  { name: 'window place', method: 'POST', path: '/api/windows/place', body: { handle: 101, x: 10, y: -20 }, status: 200 },
  { name: 'window place: out of range is 400', method: 'POST', path: '/api/windows/place', body: { handle: 101, x: 1e9, y: 0 }, status: 400 },
  { name: 'window place: text position is 400', method: 'POST', path: '/api/windows/place', body: { handle: 101, x: 'a', y: 0 }, status: 400 },
  { name: 'window place: a vanished window is 404', method: 'POST', path: '/api/windows/place', body: { handle: 999, x: 0, y: 0 }, status: 404 },
  { name: 'window snap', method: 'POST', path: '/api/windows/snap', body: { handle: 101, monitor: 0, zone: 'left' }, status: 200 },
  { name: 'window snap: unknown zone is 400', method: 'POST', path: '/api/windows/snap', body: { handle: 101, monitor: 0, zone: 'top' }, status: 400 },
  { name: 'window snap: negative screen is 400', method: 'POST', path: '/api/windows/snap', body: { handle: 101, monitor: -1, zone: 'full' }, status: 400 },
  { name: 'window snap: a vanished window is 404', method: 'POST', path: '/api/windows/snap', body: { handle: 999, monitor: 0, zone: 'full' }, status: 404 },
  { name: 'screens', method: 'GET', path: '/api/screens', status: 200, check: (r, e) => e.assert.deepStrictEqual(r.json.monitors, e.fixture.screens) },
  { name: 'screens without the slow brightness reads', method: 'GET', path: '/api/screens?brightness=0', status: 200 },
  { name: 'brightness of a known screen', fixtureBound: true, method: 'POST', path: '/api/screens/brightness', body: { device: 'DISPLAY1', level: 10 }, status: 200 },
  { name: 'brightness of an unknown screen is 404', method: 'POST', path: '/api/screens/brightness', body: { device: 'nope', level: 10 }, status: 404 },
  { name: 'brightness: text level is 400', fixtureBound: true, method: 'POST', path: '/api/screens/brightness', body: { device: 'DISPLAY1', level: 'x' }, status: 400 },
  { name: 'screens off', method: 'POST', path: '/api/screens/off', status: 200 },
  { name: 'project: unknown mode is 400', method: 'POST', path: '/api/screens/project', body: { mode: 'banana' }, status: 400 },
  { name: 'project: single-screen mode needs confirm', method: 'POST', path: '/api/screens/project', body: { mode: 'first' }, status: 400 },
  { name: 'project: extend', method: 'POST', path: '/api/screens/project', body: { mode: 'extend' }, status: 200, osEffect: true },

  // ---- pc
  { name: 'monitor sample', method: 'GET', path: '/api/monitor/sample', status: 200 },
  { name: 'monitor fps is null without a game', method: 'GET', path: '/api/monitor/fps', status: 200, check: (r, e) => e.assert.strictEqual(r.json, null) },
  { name: 'monitor processes', method: 'GET', path: '/api/monitor/processes', status: 200 },
  { name: 'monitor info', method: 'GET', path: '/api/monitor/info', status: 200 },
  { name: 'power: info', method: 'GET', path: '/api/power', status: 200, check: (r, e) => { e.assert.strictEqual(r.json.enabled, true); e.assert.strictEqual(r.json.scheduled, null); } },
  { name: 'power: unknown action is 400', method: 'POST', path: '/api/power', body: { action: 'reboot-now' }, status: 400 },
  { name: 'power: a destructive action needs confirm', method: 'POST', path: '/api/power', body: { action: 'shutdown' }, status: 400, check: (r, e) => e.assert.ok(!e.calls.some((c) => c[0] === 'power')) },
  { name: 'power: delay over a day is 400', method: 'POST', path: '/api/power', body: { action: 'shutdown', confirm: true, delaySec: 99999999 }, status: 400 },
  { name: 'power: a delayed shutdown is scheduled', method: 'POST', path: '/api/power', body: { action: 'shutdown', confirm: true, delaySec: 600 }, status: 200, check: (r, e) => e.assert.strictEqual(typeof r.json.at, 'number') },
  { name: 'power: the schedule shows in /api/power', method: 'GET', path: '/api/power', status: 200, check: (r, e) => { e.assert.strictEqual(r.json.scheduled.action, 'shutdown'); e.assert.strictEqual(r.json.scheduled.inSec, 600); } },
  { name: 'power: cancel needs no confirm', method: 'POST', path: '/api/power', body: { action: 'cancel' }, status: 200, check: (r, e) => e.assert.strictEqual(r.json.cancelled, true) },
  { name: 'power: lock', method: 'POST', path: '/api/power', body: { action: 'lock', confirm: true }, status: 200 },
  { name: 'power: disabled in config is 403', target: 'locked', method: 'POST', path: '/api/power', body: { action: 'cancel' }, status: 403 },
  { name: 'power: info says it is disabled', target: 'locked', method: 'GET', path: '/api/power', status: 200, check: (r, e) => e.assert.strictEqual(r.json.enabled, false) },

  // ---- camera
  { name: 'camera frame: accepted, tells the phone nobody watches', method: 'POST', path: '/api/camera/frame', rawBody: 'JPEG', contentType: 'image/jpeg', status: 204, check: (r, e) => e.assert.strictEqual(r.headers['x-camera-wanted'], '0') },
  { name: 'camera frame: too large is 413', method: 'POST', path: '/api/camera/frame', rawBody: big(4 * 1024 * 1024), contentType: 'image/jpeg', status: 413, orClosed: true },
  { name: 'camera stream is multipart', method: 'GET', path: '/api/camera/stream', status: 200, expectType: 'multipart/x-mixed-replace', firstChunk: true },
  { name: 'camera status', method: 'GET', path: '/api/camera/status', status: 200, check: (r, e) => e.assert.strictEqual(r.json.live, false) },
  { name: 'camera copy-link', method: 'POST', path: '/api/camera/copy-link', status: 200, osEffect: true },
  { name: 'virtual camera install needs confirm', method: 'POST', path: '/api/camera/direct/install', body: {}, status: 400, check: (r, e) => e.assert.ok(!e.calls.some((c) => c[0] === 'vcamInstall')) },
  { name: 'virtual camera install: confirm must be the boolean true', method: 'POST', path: '/api/camera/direct/install', body: { confirm: 'true' }, status: 400 },
  { name: 'virtual camera install', method: 'POST', path: '/api/camera/direct/install', body: { confirm: true }, status: 200, check: (r, e) => e.assert.strictEqual(r.json.installed, true) },
  { name: 'virtual camera uninstall needs confirm', method: 'POST', path: '/api/camera/direct/uninstall', body: {}, status: 400 },
  { name: 'virtual camera uninstall', method: 'POST', path: '/api/camera/direct/uninstall', body: { confirm: true }, status: 200, check: (r, e) => e.assert.strictEqual(r.json.installed, false) },

  // ---- events (the stream itself is tested apart: see sse in run.js)
  { name: 'events: topics are required', method: 'GET', path: '/api/events', status: 400 },
  { name: 'events: an unknown topic is 400', method: 'GET', path: '/api/events?topics=state,secrets', status: 400 },

  // ---- layout and editor (these change the config: they come last and put back what they changed)
  { name: 'layout read', method: 'GET', path: '/api/layout', status: 200, check: (r, e) => e.assert.deepStrictEqual(r.json, { apps: [], shortcuts: [] }) },
  { name: 'layout: unknown page is 400', method: 'POST', path: '/api/layout', body: { page: 'power', order: [] }, status: 400 },
  { name: 'layout: a malformed key is 400', method: 'POST', path: '/api/layout', body: { page: 'apps', order: ['a:ok', '../x'] }, status: 400 },
  { name: 'layout: more than 200 keys is 400', method: 'POST', path: '/api/layout', body: { page: 'apps', order: Array(201).fill('a:x') }, status: 400 },
  { name: 'layout: duplicates collapse, order is kept', method: 'POST', path: '/api/layout', body: { page: 'apps', order: ['a:one', 'a:two', 'a:one'] }, status: 200, check: (r, e) => e.assert.deepStrictEqual(r.json.apps, ['a:one', 'a:two']) },
  { name: 'layout: put back', method: 'POST', path: '/api/layout', body: { page: 'apps', order: [] }, status: 200 },
  { name: 'editor data', method: 'GET', path: '/api/editor', status: 200, check: (r, e) => {
    e.assert.deepStrictEqual(r.json.apps.map((a) => [a.id, a.hidden]), [['aaaaaaaa', false], ['bbbbbbbb', false], ['cccccccc', true], ['dddddddd', false]]);
    e.assert.strictEqual(r.json.screens, 1);
  } },
  { name: 'editor shortcuts: keys are normalised and ids kept', method: 'POST', path: '/api/editor/shortcuts', body: { items: [{ id: 'copy', label: ' Copiar ', keys: ' Ctrl + C ' }, { id: 'paste', label: 'Colar', keys: 'ctrl+v' }] }, status: 200, check: (r, e) => {
    e.assert.deepStrictEqual(r.json.shortcuts.map((s) => [s.id, s.label, s.keys]), [['copy', 'Copiar', 'ctrl+c'], ['paste', 'Colar', 'ctrl+v']]);
  } },
  { name: 'editor shortcuts: an unknown key is a 400, not a 500', method: 'POST', path: '/api/editor/shortcuts', body: { items: [{ label: 'x', keys: 'ctrl+nonexistentkey' }] }, status: 400 },
  { name: 'editor shortcuts: not a list is 400', method: 'POST', path: '/api/editor/shortcuts', body: { items: 'x' }, status: 400 },
  { name: 'editor shortcuts: a body over the limit is 413', method: 'POST', path: '/api/editor/shortcuts', rawBody: Buffer.from(JSON.stringify({ items: [], pad: 'x'.repeat(70 * 1024) })), contentType: 'application/json', status: 413, orClosed: true },
  { name: 'editor macros: a new macro gets an id', method: 'POST', path: '/api/editor/macros', body: { items: [{ id: 'foco', label: 'Foco', page: 'shortcuts', steps: [{ type: 'volume', level: 20 }, { type: 'mute', muted: false }] }, { id: 'lento', label: 'Lento', page: 'shortcuts', steps: [{ type: 'wait', ms: 400 }] }, { label: 'Novo', steps: [{ type: 'wait', ms: 100 }, { type: 'camera', on: true }] }] }, status: 200, check: (r, e) => {
    e.assert.strictEqual(r.json.macros.length, 3);
    e.assert.match(r.json.macros[2].id, /^[a-z0-9-]{1,40}$/);
  } },
  { name: 'editor macros: a step that is not on the whitelist is 400', method: 'POST', path: '/api/editor/macros', body: { items: [{ label: 'x', steps: [{ type: 'format-disk' }] }] }, status: 400 },
  { name: 'editor macros: an app that is not on the taskbar is 400', method: 'POST', path: '/api/editor/macros', body: { items: [{ label: 'x', steps: [{ type: 'launch', app: 'ghost' }] }] }, status: 400 },
  { name: 'editor macros: a wait under 100 ms is 400', method: 'POST', path: '/api/editor/macros', body: { items: [{ label: 'x', steps: [{ type: 'wait', ms: 5 }] }] }, status: 400 },
  { name: 'editor macros: a macro without steps is 400', method: 'POST', path: '/api/editor/macros', body: { items: [{ label: 'x', steps: [] }] }, status: 400 },
  { name: 'editor macros: put back', method: 'POST', path: '/api/editor/macros', body: { items: [{ id: 'foco', label: 'Foco', page: 'shortcuts', steps: [{ type: 'volume', level: 20 }, { type: 'mute', muted: false }] }, { id: 'lento', label: 'Lento', page: 'shortcuts', steps: [{ type: 'wait', ms: 400 }] }] }, status: 200 },
  { name: 'editor apps: an unknown app is 400', method: 'POST', path: '/api/editor/apps', body: { hidden: ['ghost'] }, status: 400 },
  { name: 'editor apps: hide one', fixtureBound: true, method: 'POST', path: '/api/editor/apps', body: { hidden: ['bbbbbbbb'] }, status: 200 },
  { name: 'editor apps: the deck list follows', method: 'GET', path: '/api/apps', status: 200, check: (r, e) => e.assert.deepStrictEqual(r.json.apps.map((a) => a.id), ['aaaaaaaa', 'cccccccc', 'dddddddd']) },
  { name: 'editor apps: put back', fixtureBound: true, method: 'POST', path: '/api/editor/apps', body: { hidden: ['cccccccc'] }, status: 200 },
  { name: 'editor off: data is 403', target: 'locked', method: 'GET', path: '/api/editor', status: 403 },
  { name: 'editor off: shortcuts are 403', target: 'locked', method: 'POST', path: '/api/editor/shortcuts', body: { items: [] }, status: 403 },
  { name: 'editor off: macros are 403', target: 'locked', method: 'POST', path: '/api/editor/macros', body: { items: [] }, status: 403 },
  { name: 'editor off: apps are 403', target: 'locked', method: 'POST', path: '/api/editor/apps', body: { hidden: [] }, status: 403 },
  { name: 'editor off: layout is 403', target: 'locked', method: 'POST', path: '/api/layout', body: { page: 'apps', order: [] }, status: 403 },

  // ---- failures stay on the PC side
  { name: 'a failure in a PC module is a 500 with a message and no stack', inProcess: true, method: 'GET', path: '/api/volume', status: 500, before: (env) => env.fail('getVolume', 'helper died'), after: (env) => env.restore('getVolume'), check: (r, e) => {
    e.assert.deepStrictEqual(r.json, { error: 'helper died' });
  } },
];

// Operations that cannot be exercised against the Node fakes, and why. The coverage report lists them.
const UNCOVERED = {
  'GET /api/icon/{id}': 'a 200 needs an icon file in the data folder (the 404 paths are covered)',
};

module.exports = { cases, UNCOVERED };
