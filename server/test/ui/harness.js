'use strict';

// A browser without a window, driven over the DevTools protocol (no dependencies: Node's own WebSocket), and a fake
// deck server that serves the real public/ files with made-up answers for /api. Used by test/ui/*.test.js.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sendJson, serveStatic, isStaticPath, readJson } = require('../../src/http');

const BROWSERS = [
  process.env.CHROME_PATH,
  path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  path.join(process.env.ProgramFiles || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const findBrowser = () => BROWSERS.find((candidate) => fs.existsSync(candidate)) || null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The deck server with canned data. `calls` records every request; `state` can be changed by a test between steps. */
async function fakeDeck() {
  const apps = ['Navegador', 'Terminal', 'Editor', 'Chat', 'Música', 'Jogos'].map((name, i) => ({ id: `app${i}`, name, hasIcon: false, iconVersion: 0 }));
  const model = {
    calls: [],
    down: false, // true: the PC "went away" (the state answers 503)
    layout: { apps: [], shortcuts: [] },
    power: { enabled: true, hibernate: false, uptimeSec: 3 * 3600, lastBoot: '2026-10-22T08:00:00', rebootPending: false, scheduled: null, openApps: [{ name: 'Navegador', count: 2 }, { name: 'Editor', count: 1 }] },
    state: { running: ['app0'], open: [], scheduled: null, mic: { available: true, muted: false }, volume: { level: 40, muted: false }, playing: null, miniPlayer: true, ui: 1, appsRev: 1 },
  };
  const streams = new Set(); // open event streams that asked for the game topic
  const sendGame = (res) => res.write(`event: game\ndata: ${JSON.stringify(model.fps)}\n\n`);
  model.pushGame = () => { for (const res of streams) sendGame(res); };
  const shortcuts = [{ id: 'copy', label: 'Copiar', display: 'Ctrl+C' }, { id: 'paste', label: 'Colar', display: 'Ctrl+V' }];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && isStaticPath(url.pathname)) return serveStatic(req, res, url.pathname);
    const body = req.method === 'POST' ? await readJson(req, 64 * 1024).catch(() => ({})) : undefined;
    model.calls.push({ method: req.method, path: url.pathname, body });
    const key = `${req.method} ${url.pathname}`;
    if (key === 'GET /api/apps') return sendJson(res, 200, { host: 'PC-TESTE', apps });
    if (key === 'GET /api/state') return model.down ? sendJson(res, 503, { error: 'down' }) : sendJson(res, 200, model.state);
    if (key === 'GET /api/shortcuts') return sendJson(res, 200, { shortcuts });
    if (key === 'GET /api/macros') return sendJson(res, 200, { macros: [] });
    if (key === 'GET /api/layout') return sendJson(res, 200, model.layout);
    if (key === 'POST /api/layout') {
      model.layout = { ...model.layout, [body.page]: body.order };
      return sendJson(res, 200, model.layout);
    }
    if (key === 'GET /api/monitor/fps') return sendJson(res, 200, model.fps ?? null);
    if (key === 'GET /api/power') return sendJson(res, 200, model.power);
    if (key === 'GET /api/volume') return sendJson(res, 200, model.state.volume);
    if (url.pathname === '/api/events') {
      // the push stream is silent (the page falls back to its own requests) unless a test sets model.fps: the "game" topic
      // is then sent at once and on every model.pushGame()
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': ok\n\n');
      const topics = (url.searchParams.get('topics') || '').split(',');
      if (topics.includes('power')) res.write(`event: power\ndata: ${JSON.stringify(model.power)}\n\n`);
      if (topics.includes('game')) {
        streams.add(res);
        res.on('close', () => streams.delete(res));
        if (model.fps) sendGame(res);
      }
      return undefined;
    }
    if (key === 'POST /api/mic') return sendJson(res, 200, { available: true, muted: true });
    if (key === 'POST /api/volume') return sendJson(res, 200, { level: body.level ?? model.state.volume.level, muted: false });
    if (req.method === 'POST') return sendJson(res, 200, { ok: true });
    return sendJson(res, 404, { error: 'not in the fake deck' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { model, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** Starts the browser, returns { open(url) -> page, close() }. A page has eval, click, touch helpers, waitFor, errors. */
async function launchBrowser({ width = 412, height = 915 } = {}) {
  const exe = findBrowser();
  if (!exe) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssd-ui-'));
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--disable-extensions', '--mute-audio', 'about:blank'], { stdio: 'ignore' });

  let port = null;
  for (let i = 0; i < 100 && !port; i += 1) {
    await sleep(100);
    try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { /* not written yet */ }
  }
  if (!port) { proc.kill(); throw new Error('the browser did not open its debugging port'); }

  async function open(url) {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const waiting = new Map();
    const errors = [];
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && waiting.has(message.id)) {
        const { resolve, reject } = waiting.get(message.id);
        waiting.delete(message.id);
        return message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map((a) => a.value || a.description).join(' '));
      return undefined;
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => { id += 1; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });

    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await send('Page.navigate', { url });

    const page = {
      errors,
      async eval(expression) {
        const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
        return result.value;
      },
      async waitFor(expression, what = expression, timeout = 6000) {
        const until = Date.now() + timeout;
        while (Date.now() < until) {
          if (await page.eval(`Boolean(${expression})`).catch(() => false)) return;
          await sleep(60);
        }
        throw new Error(`timed out waiting for: ${what}`);
      },
      /** the centre of the first element matching the selector, in page coordinates, once it has stopped moving (pages slide) */
      async center(selector) {
        const read = () => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
        let last = await read();
        for (let i = 0; i < 40; i += 1) {
          await sleep(80);
          const now = await read();
          if (now.x === last.x && now.y === last.y) return now;
          last = now;
        }
        return last;
      },
      touch: (type, x, y) => send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] }),
      async tap(selector) {
        const { x, y } = await page.center(selector);
        await page.touch('touchStart', x, y);
        await page.touch('touchEnd', x, y);
      },
      /** hold on a key until it lifts, then drag to another and let go */
      async holdAndDrag(fromSelector, toSelector, holdMs = 700) {
        const from = await page.center(fromSelector);
        const to = await page.center(toSelector);
        await page.touch('touchStart', from.x, from.y);
        await sleep(holdMs);
        for (let step = 1; step <= 8; step += 1) {
          await page.touch('touchMove', from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8);
          await sleep(30);
        }
        await page.touch('touchEnd', to.x, to.y);
      },
      /** a PNG of the page, written to `file` (for looking at a layout by hand) */
      async shot(file) {
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
      },
      close: () => { socket.close(); },
    };
    return page;
  }

  return {
    open,
    close() {
      proc.kill();
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold files for a moment */ }
    },
  };
}

module.exports = { fakeDeck, launchBrowser, findBrowser, sleep };
