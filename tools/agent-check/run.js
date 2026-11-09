'use strict';

// Conformance of the Rust agent in transition mode (plan 3.1): `ssd` starts the Node agent behind it, and from outside it must behave like the
// Node agent did on the security side (Host, token, pairing, Origin, lockout, static files) while handing every route it does not answer yet to
// Node, SSE included. Needs a built agent (`cargo build --release` in agent/) and web/dist. The route-by-route contract runs against the Rust
// agent as the routes are ported (3.2); this is what must already hold today.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const EXE = process.env.SSD_AGENT_EXE || path.join(ROOT, 'agent', 'target', 'release', process.platform === 'win32' ? 'ssd.exe' : 'ssd');
const WEB = path.join(ROOT, 'web', 'dist');
const NODE_INDEX = path.join(ROOT, 'legacy', 'server', 'src', 'index.js');
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PORT = 7890 + (process.pid % 50);
const NODE_PORT = PORT + 100;

if (!fs.existsSync(EXE) || !fs.existsSync(path.join(WEB, 'index.html'))) {
  console.log('skipped (build the agent with `cargo build --release` in agent/ and the interface with `npm run build` in web/)');
  process.exit(0);
}

function request(pathname, { method = 'GET', headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers: { ...(host ? { Host: host } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
const step = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ssd-agent-check-'));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ token: TOKEN, port: PORT }));
  const agent = spawn(EXE, ['--data-dir', data, '--web-dir', WEB, '--port', String(PORT), '--node', NODE_INDEX, '--node-port', String(NODE_PORT), '--fake-platform'], { stdio: 'ignore' });
  const stop = () => { agent.kill(); };
  process.on('exit', stop);
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ready = await request('/api/ping', { headers: { 'X-Token': TOKEN } }).then((r) => r.status === 200, () => false);
      if (ready) break;
      await sleep(250);
    }
    const auth = { 'X-Token': TOKEN };

    await step('Host: a stranger name is 421', async () => {
      assert.strictEqual((await request('/api/ping', { host: 'evil.example.com', headers: auth })).status, 421);
    });
    await step('no token: 401 for the API, the pairing page for a browser, the manifest and pair.js are public', async () => {
      assert.strictEqual((await request('/api/state')).status, 401);
      const page = await request('/', { headers: { Accept: 'text/html' } });
      assert.strictEqual(page.status, 200);
      assert.match(page.body, /<html/i);
      assert.strictEqual((await request('/manifest.webmanifest')).status, 200);
      assert.strictEqual((await request('/pair.js')).status, 200);
      assert.strictEqual((await request('/index.html')).status, 401);
    });
    await step('the pairing link sets an HttpOnly, SameSite=Lax cookie that then opens the interface', async () => {
      const r = await request(`/?token=${TOKEN}`, { headers: { Accept: 'text/html' } });
      assert.strictEqual(r.status, 302);
      assert.strictEqual(r.headers.location, '/');
      const cookie = String(r.headers['set-cookie']);
      assert.ok(cookie.includes(`ssd_token=${TOKEN}`) && /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie), cookie);
      assert.strictEqual((await request('/', { headers: { Cookie: `ssd_token=${TOKEN}` } })).status, 200);
    });
    await step('every answer carries the hardening headers; static files revalidate with ETag/304', async () => {
      const r = await request('/index.html', { headers: auth });
      assert.strictEqual(r.status, 200);
      assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
      assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(r.headers['x-frame-options'], 'DENY');
      const again = await request('/index.html', { headers: { ...auth, 'If-None-Match': r.headers.etag } });
      assert.strictEqual(again.status, 304);
      assert.strictEqual(again.body, '');
    });
    await step('static files cannot leave the interface folder', async () => {
      for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/package.json', '/..%5c..%5cpackage.json', '/assets/..%2f..%2f..%2fpackage.json', '/nope.js']) {
        const r = await request(p, { headers: auth });
        assert.ok(r.status === 404 || r.status === 400, `${p} gave ${r.status}`);
      }
    });
    await step('a POST from another origin is 403; the same origin passes through to Node', async () => {
      assert.strictEqual((await request('/api/refresh', { method: 'POST', headers: { ...auth, Origin: 'https://evil.example.com' } })).status, 403);
      const same = await request('/api/refresh', { method: 'POST', headers: { ...auth, Origin: `http://127.0.0.1:${PORT}` } });
      assert.ok(same.status !== 403 && same.status !== 502, `same-origin POST gave ${same.status}`);
    });
    await step('routes this agent does not answer yet are served by Node behind it (JSON and SSE)', async () => {
      const ping = await request('/api/ping', { headers: auth });
      assert.strictEqual(ping.status, 200);
      assert.deepStrictEqual(JSON.parse(ping.body), { ok: true });
      assert.strictEqual((await request('/api/state', { headers: auth })).status, 200);
      const sse = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/events?topics=power', headers: auth }, (res) => {
          let text = '';
          res.on('data', (c) => { text += c; if (text.includes('event: power')) { req.destroy(); resolve({ type: res.headers['content-type'], text }); } });
        });
        req.on('error', (e) => (e.code === 'ECONNRESET' ? undefined : reject(e)));
        setTimeout(() => { req.destroy(); reject(new Error('no SSE event in 8 s')); }, 8000);
        req.end();
      });
      assert.match(sse.type, /text\/event-stream/);
    });
    await step('ported routes answered by this agent: /api/pair-code and /api/layout (read, save, bad input)', async () => {
      assert.deepStrictEqual(JSON.parse((await request('/api/pair-code', { headers: auth })).body), { code: TOKEN });
      const json = { ...auth, 'Content-Type': 'application/json' };
      const post = (body) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/layout', method: 'POST', headers: json }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end(body);
      });
      const saved = await post(JSON.stringify({ page: 'shortcuts', order: ['s:copy', 'm:one', 's:copy'] }));
      assert.strictEqual(saved.status, 200);
      assert.deepStrictEqual(JSON.parse(saved.body).shortcuts, ['s:copy', 'm:one']);
      assert.deepStrictEqual(JSON.parse((await request('/api/layout', { headers: auth })).body).shortcuts, ['s:copy', 'm:one']);
      assert.strictEqual((await post(JSON.stringify({ page: 'power', order: [] }))).status, 400);
      assert.strictEqual((await post(JSON.stringify({ page: 'apps', order: ['not a key'] }))).status, 400);
    });
    await step('audio module (fake platform): volume, mic, devices, mixer, default device', async () => {
      const send = (route, body) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: route, method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; } })() }));
        });
        req.on('error', reject);
        req.end(JSON.stringify(body));
      });
      const get = async (route) => JSON.parse((await request(route, { headers: auth })).body);
      assert.deepStrictEqual(await get('/api/volume'), { level: 30, muted: false });
      assert.deepStrictEqual((await send('/api/volume', { level: '41.6', muted: 'toggle' })).json, { level: 42, muted: true });
      assert.deepStrictEqual((await send('/api/volume', { level: 500 })).json, { level: 100, muted: false });
      assert.strictEqual((await send('/api/volume', { level: 'abc' })).status, 400);
      assert.deepStrictEqual((await send('/api/mic', { muted: 'toggle' })).json, { available: true, muted: true });
      assert.strictEqual((await send('/api/mic', { muted: 'yes' })).status, 400);
      assert.strictEqual((await send('/api/audio/default', { id: 'out2' })).status, 200);
      assert.strictEqual((await send('/api/audio/default', { id: 'nope' })).status, 404);
      assert.strictEqual((await send('/api/audio/device', { id: 'in1', level: 10, muted: true })).status, 200);
      assert.strictEqual((await send('/api/audio/session', { pid: 11, level: 20, muted: true })).status, 200);
      assert.strictEqual((await send('/api/audio/session', { pid: -1 })).status, 400);
      const audio = await get('/api/audio');
      assert.strictEqual(audio.playback[1].default, true);
      assert.deepStrictEqual([audio.capture[0].level, audio.capture[0].muted], [10, true]);
      assert.deepStrictEqual([audio.sessions[1].level, audio.sessions[1].muted], [20, true]);
    });
    await step('media module (fake platform): now playing, control, seek validation, cover art', async () => {
      const send = (route, body) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: route, method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; } })() }));
        });
        req.on('error', reject);
        req.end(JSON.stringify(body));
      });
      const state = JSON.parse((await request('/api/media', { headers: auth })).body);
      assert.strictEqual(state.current, 's1');
      assert.strictEqual(state.sessions[0].app, 'Spotify');
      assert.deepStrictEqual((await send('/api/media/control', { session: 's1', action: 'toggle' })).json, { ok: true, accepted: true });
      assert.strictEqual((await send('/api/media/control', { session: 's1', action: 'seek', position: 90 })).status, 200);
      assert.strictEqual(JSON.parse((await request('/api/media', { headers: auth })).body).sessions[0].position, 90);
      for (const bad of [{ session: '', action: 'play' }, { session: 's1', action: 'explode' }, { session: 's1', action: 'seek' }, { session: 's1', action: 'seek', position: -1 }]) {
        assert.strictEqual((await send('/api/media/control', bad)).status, 400, JSON.stringify(bad));
      }
      const art = await request('/api/media/art?session=s1&key=0123456789ab', { headers: auth });
      assert.strictEqual(art.status, 200);
      assert.strictEqual(art.headers['content-type'], 'image/png');
      assert.match(art.headers['cache-control'], /immutable/);
      assert.strictEqual((await request('/api/media/art?session=s1&key=nope', { headers: auth })).status, 400);
    });
    await step('shortcuts and media keys (fake keyboard): the list, unknown ids, the global media keys', async () => {
      const list = JSON.parse((await request('/api/shortcuts', { headers: auth })).body).shortcuts;
      assert.ok(list.length >= 9 && list.every((s) => s.id && s.label && s.display), JSON.stringify(list).slice(0, 200));
      assert.strictEqual(list.find((s) => s.id === 'task-manager').display, 'Ctrl+Shift+Esc');
      const post = (route) => request(route, { method: 'POST', headers: auth });
      const copied = await post('/api/shortcut/copy');
      assert.strictEqual(copied.status, 200);
      assert.deepStrictEqual(JSON.parse(copied.body), { ok: true, label: 'Copiar' });
      assert.strictEqual((await post('/api/shortcut/nope')).status, 404);
      assert.strictEqual((await post('/api/mediakey/playpause')).status, 200);
      assert.strictEqual((await post('/api/mediakey/explode')).status, 404);
    });
    await step('taskbar apps (fake taskbar): refresh, list, icons', async () => {
      const refreshed = await request('/api/refresh', { method: 'POST', headers: auth });
      assert.deepStrictEqual(JSON.parse(refreshed.body), { count: 3 });
      const apps = JSON.parse((await request('/api/apps', { headers: auth })).body);
      assert.ok(apps.host);
      assert.deepStrictEqual(apps.apps.map((a) => a.name), ['Brave', 'Code', 'Terminal']);
      assert.ok(apps.apps.every((a) => a.hasIcon && /^[0-9a-f]{8}$/.test(a.iconVersion)));
      const icon = await request(`/api/icon/${apps.apps[0].id}`, { headers: auth });
      assert.strictEqual(icon.status, 200);
      assert.strictEqual(icon.headers['content-type'], 'image/png');
      assert.match(icon.headers['cache-control'], /immutable/);
      assert.strictEqual((await request('/api/icon/nope', { headers: auth })).status, 404);
    });
    await step('windows, screens and launching (fake windows): list, actions, snap, brightness, projection, focus or start', async () => {
      const send = (route, body) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: route, method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; } })() }));
        });
        req.on('error', reject);
        req.end(JSON.stringify(body));
      });
      const windows = JSON.parse((await request('/api/windows', { headers: auth })).body).windows;
      assert.deepStrictEqual(windows.map((w) => w.app), ['Brave', 'Notepad']);
      assert.strictEqual((await send('/api/windows/action', { handle: 101, action: 'minimize' })).status, 200);
      assert.strictEqual((await send('/api/windows/action', { handle: 999, action: 'close' })).status, 404);
      assert.strictEqual((await send('/api/windows/action', { handle: 101, action: 'explode' })).status, 400);
      assert.strictEqual((await send('/api/windows/snap', { handle: 102, monitor: 0, zone: 'left' })).status, 200);
      assert.strictEqual((await send('/api/windows/place', { handle: 102, x: 1e9, y: 0 })).status, 400);
      const screens = JSON.parse((await request('/api/screens', { headers: auth })).body).monitors;
      assert.deepStrictEqual(screens.map((m) => [m.primary, m.brightness]), [[true, 60], [false, 60]]);
      assert.strictEqual(JSON.parse((await request('/api/screens?brightness=0', { headers: auth })).body).monitors[0].brightness, null);
      assert.strictEqual((await send('/api/screens/brightness', { device: 'nope', level: 10 })).status, 404);
      assert.strictEqual((await send('/api/screens/project', { mode: 'first' })).status, 400);
      const apps = JSON.parse((await request('/api/apps', { headers: auth })).body).apps;
      const named = (name) => apps.find((a) => a.name === name).id;
      assert.strictEqual((await send(`/api/launch/${named('Brave')}`, {})).json.action, 'focused');
      assert.strictEqual((await send(`/api/launch/${named('Code')}`, {})).json.action, 'launched');
      assert.strictEqual((await send('/api/launch/nope', {})).status, 404);
    });
    await step('live events: topics of this agent (windows, audio, media) and of Node (power) in one stream; unknown topics are refused', async () => {
      assert.strictEqual((await request('/api/events?topics=nope', { headers: auth })).status, 400);
      assert.strictEqual((await request('/api/events', { headers: auth })).status, 400);
      const seen = await new Promise((resolve, reject) => {
        let text = '';
        const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/events?topics=windows,audio,media,power', headers: auth }, (res) => {
          res.on('data', (c) => {
            text += c;
            if (['windows', 'audio', 'media', 'power'].every((name) => text.includes(`event: ${name}\n`))) { req.destroy(); resolve(text); }
          });
        });
        req.on('error', (e) => (e.code === 'ECONNRESET' ? undefined : reject(e)));
        setTimeout(() => { req.destroy(); reject(new Error(`not every topic arrived in 10 s: ${text.slice(0, 300)}`)); }, 10000);
        req.end();
      });
      assert.ok(seen.startsWith('retry: 2000\n\n'), 'one retry line, from this agent');
      assert.strictEqual(seen.split('retry:').length - 1, 1, 'the retry line of the Node stream is not repeated');
    });
    await step('/api/requests counts the routes (static files as one)', async () => {
      const r = JSON.parse((await request('/api/requests', { headers: auth })).body);
      assert.ok(r.counts['GET static'] >= 1 && r.counts['GET /api/ping'] >= 1, JSON.stringify(r.counts));
    });
    await step('wrong tokens lock the address out (10 in a minute, the earlier steps already spent some), even for the right token', async () => {
      let locked = false;
      for (let i = 0; i < 10 && !locked; i += 1) locked = (await request('/api/state', { headers: { 'X-Token': 'wrong' } })).status === 429;
      assert.ok(locked, 'no lockout after 10 wrong tokens');
      assert.strictEqual((await request('/api/state', { headers: auth })).status, 429);
    });
  } finally {
    stop();
    await sleep(300);
    fs.rmSync(data, { recursive: true, force: true });
  }
  console.log(`${passed} passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
