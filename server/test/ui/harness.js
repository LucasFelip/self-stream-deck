'use strict';

// A browser without a window, driven over the DevTools protocol (no dependencies: Node's own WebSocket), and a fake
// deck server that serves the real public/ files with made-up answers for /api. Used by test/ui/*.test.js.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
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
    apps, // a test can replace it (before opening a page) to get an Apps section with several pages
    calls: [],
    down: false, // true: the PC "went away" (the state answers 503)
    layout: { apps: [], shortcuts: [] },
    power: { enabled: true, hibernate: false, uptimeSec: 3 * 3600, lastBoot: '2026-10-22T08:00:00', rebootPending: false, scheduled: null, openApps: [{ name: 'Navegador', count: 2 }, { name: 'Editor', count: 1 }] },
    // what the Janelas and PC pages ask for: coherent canned answers (a test can change them between steps)
    drives: [{ name: 'C:', label: 'Sistema', totalGB: 500, freeGB: 200 }, { name: 'D:', label: 'Laika', totalGB: 730, freeGB: 195 }, { name: 'E:', label: 'Strelka', totalGB: 466, freeGB: 408 }], // the disk card's drives
    infoFails: false, // true: GET /api/monitor/info answers 500
    noGpu: false, // true: the sample has no GPU
    windows: [
      { handle: 101, title: 'Documento - Editor', app: 'Editor', appId: null, iconVersion: 0, state: 0, monitor: 0, x: 100, y: 80, w: 900, h: 600 },
      { handle: 102, title: 'Navegador', app: 'Navegador', appId: null, iconVersion: 0, state: 2, monitor: 0, x: 0, y: 0, w: 1920, h: 1040 },
      { handle: 103, title: 'Terminal', app: 'Terminal', appId: null, iconVersion: 0, state: 1, monitor: 0, x: 0, y: 0, w: 0, h: 0 },
    ],
    screens: [{ device: 'DISPLAY1', left: 0, top: 0, width: 1920, height: 1080, primary: true, brightness: 60 }],
    // the Som page: devices and per-app sessions, and what is playing (a test can change them before opening a page)
    audio: {
      playback: [{ id: 'out1', name: 'Alto-falantes (Realtek)', adapter: 'Realtek', default: true, level: 40, muted: false }, { id: 'out2', name: 'Fone Bluetooth', adapter: 'BT', default: false, level: 70, muted: false }],
      capture: [{ id: 'in1', name: 'Microfone (USB)', adapter: 'USB', default: true, level: 80, muted: false }, { id: 'in2', name: 'Microfone do headset', adapter: 'BT', default: false, level: 60, muted: false }],
      sessions: [{ pid: 0, system: true, label: 'Sons do sistema', active: false, level: 100, muted: false }, { pid: 11, system: false, label: 'Navegador', active: true, level: 55, muted: false }],
    },
    media: { current: 's1', sessions: [{ id: 's1', app: 'Spotify', status: 'playing', title: 'Uma faixa com um nome bem comprido para testar o corte', artist: 'Banda', album: 'Disco', duration: 215, position: 42, canPlay: true, canPause: true, canPrev: true, canNext: true, canSeek: true, hasArt: false, artKey: 'k1' }] },
    state: { running: ['app0'], open: [], scheduled: null, mic: { available: true, muted: false }, volume: { level: 40, muted: false }, playing: null, miniPlayer: true, ui: 1, appsRev: 1 },
  };
  const streams = new Set(); // open event streams that asked for the game topic
  const sendGame = (res) => res.write(`event: game\ndata: ${JSON.stringify(model.fps)}\n\n`);
  model.pushGame = () => { for (const res of streams) sendGame(res); };
  const shortcuts = [{ id: 'copy', label: 'Copiar', keys: 'ctrl+c', display: 'Ctrl+C' }, { id: 'paste', label: 'Colar', keys: 'ctrl+v', display: 'Ctrl+V' }];

  const sampleReply = () => ({
    cpu: { usage: 23, freqMHz: 4200, temp: 51, tempSource: 'fake', power: 40, processes: 210, threads: 3100, cores: [10, 20, 30, 40] },
    memory: { usedPct: 48, usedMB: 15000, totalMB: 32000, commitUsedMB: 20000, commitLimitMB: 40000 },
    gpu: model.noGpu ? null : { name: 'NVIDIA GeForce RTX 4070', usage: 35, memUsedMB: 4000, memTotalMB: 12000, temp: 60, power: 120, powerLimit: 200, fan: 40, clock: 2100 },
    disk: { total: { active: 5, readBps: 1000, writeBps: 2000 }, drives: model.drives },
    network: [{ name: 'Ethernet', downBps: 5000, upBps: 1000, speed: '1 Gbps' }],
    fps: model.fps ?? null,
  });
  const processesReply = () => ({
    cpu: ['Navegador', 'Editor', 'Terminal', 'Chat', 'Musica', 'Jogos'].map((name, i) => ({ name, cpu: 12 - i, memMB: 800 - i * 50, count: i + 1 })),
    mem: ['Jogos', 'Navegador', 'Editor', 'Chat', 'Terminal', 'Musica'].map((name, i) => ({ name, cpu: i, memMB: 4000 - i * 300, count: 1 })),
  });
  const infoReply = () => ({
    host: 'PC-TESTE',
    user: 'tester',
    os: { name: 'Microsoft Windows 11 Pro', version: '10.0', build: '26100', arch: '64-bit', installed: '2025-01-01T00:00:00', lastBoot: '2026-10-22T08:00:00' },
    cpu: { name: 'CPU de teste', cores: 8, threads: 16, maxMHz: 4500, l2KB: 8192, l3KB: 32768 },
    memory: { totalGB: 32, modules: [{ slot: 'DIMM1', sizeGB: 16, type: 'DDR5', speed: 6000 }] },
    gpus: [{ name: 'GPU de teste', vramGB: 12, driver: '1.0' }],
    board: { maker: 'Fabricante', model: 'Modelo', bios: '1.0', biosDate: '2025-01-01T00:00:00' },
    storage: [{ model: 'NVMe de teste', sizeGB: 1000, type: 'SSD', bus: 'NVMe' }],
    network: [{ name: 'Ethernet', ip: '192.168.0.2', speed: '1 Gbps', mac: 'AA:BB:CC:DD:EE:FF' }],
    monitors: [{ name: 'Tela 1', primary: true, width: 1920, height: 1080 }],
    drives: [{ name: 'C:', label: 'Sistema', fs: 'NTFS', totalGB: 500, freeGB: 200 }],
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && isStaticPath(url.pathname)) return serveStatic(req, res, url.pathname);
    const body = req.method === 'POST' ? await readJson(req, 64 * 1024).catch(() => ({})) : undefined;
    model.calls.push({ method: req.method, path: url.pathname, body, topics: url.searchParams.get('topics') });
    const key = `${req.method} ${url.pathname}`;
    if (key === 'GET /api/apps') return sendJson(res, 200, { host: 'PC-TESTE', apps: model.apps });
    if (key === 'GET /api/state') return model.down ? sendJson(res, 503, { error: 'down' }) : sendJson(res, 200, model.state);
    if (key === 'GET /api/shortcuts') return sendJson(res, 200, { shortcuts });
    if (key === 'GET /api/macros') return sendJson(res, 200, { macros: [] });
    if (key === 'GET /api/editor') return sendJson(res, 200, { shortcuts, macros: [], apps: model.apps.map((app) => ({ ...app, hidden: false, canPlace: true })), devices: { playback: [], capture: [] }, screens: 1 });
    if (key === 'GET /api/layout') return sendJson(res, 200, model.layout);
    if (key === 'POST /api/layout') {
      model.layout = { ...model.layout, [body.page]: body.order };
      return sendJson(res, 200, model.layout);
    }
    if (key === 'GET /api/monitor/fps') return sendJson(res, 200, model.fps ?? null);
    if (key === 'GET /api/windows') return sendJson(res, 200, { windows: model.windows });
    if (key === 'GET /api/screens') return sendJson(res, 200, { monitors: model.screens });
    if (key === 'GET /api/monitor/sample') return sendJson(res, 200, sampleReply());
    if (key === 'GET /api/monitor/processes') return sendJson(res, 200, processesReply());
    if (key === 'GET /api/monitor/info') return model.infoFails ? sendJson(res, 500, { error: 'sem leitura' }) : sendJson(res, 200, infoReply());
    if (key === 'GET /api/power') return sendJson(res, 200, model.power);
    if (key === 'GET /api/audio') return sendJson(res, 200, model.audio);
    if (key === 'GET /api/media') return sendJson(res, 200, model.media);
    if (key === 'GET /api/volume') return sendJson(res, 200, model.state.volume);
    if (url.pathname === '/api/events') {
      // The push stream sends the current value of windows / monitor / processes / power when they are subscribed and nothing
      // after that (every request records the topics it asked for). The "game" topic is sent at once if model.fps is set and
      // again on every model.pushGame().
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': ok\n\n');
      const topics = (url.searchParams.get('topics') || '').split(',');
      if (topics.includes('power')) res.write(`event: power\ndata: ${JSON.stringify(model.power)}\n\n`);
      // like the real server: a topic's current value arrives as soon as it is subscribed
      const push = (name, value) => res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
      if (topics.includes('audio')) push('audio', model.audio);
      if (topics.includes('media')) push('media', model.media);
      if (topics.includes('windows')) push('windows', { windows: model.windows });
      if (topics.includes('monitor')) push('monitor', sampleReply());
      if (topics.includes('processes')) push('processes', processesReply());
      if (topics.includes('game')) {
        streams.add(res);
        res.on('close', () => streams.delete(res));
        if (model.fps) sendGame(res);
      }
      return undefined;
    }
    if (key === 'POST /api/mic') return sendJson(res, 200, { available: true, muted: true });
    if (key === 'POST /api/volume') {
      // like the PC: a level sets the volume (and unmutes), muted: "toggle" flips the mute
      const now = model.state.volume;
      model.state.volume = { level: body.level ?? now.level, muted: body.muted === 'toggle' ? !now.muted : (body.muted ?? (body.level === undefined ? now.muted : false)) };
      return sendJson(res, 200, model.state.volume);
    }
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

  // Stops the browser and deletes its profile (~120 MB). Retries because the browser's helpers (e.g. the crashpad handler)
  // can hold files for a moment after the kill, and also runs on process exit so an aborted test run never leaves it behind.
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    process.removeListener('exit', cleanup);
    // On Windows the process we started can be only a launcher: the real browser (and its helpers) is found by its profile folder
    if (process.platform === 'win32') {
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${path.basename(profile)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
    }
    proc.kill();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* still locked: nothing more to do */ }
  }
  process.on('exit', cleanup);

  let port = null;
  for (let i = 0; i < 100 && !port; i += 1) {
    await sleep(100);
    try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { /* not written yet */ }
  }
  if (!port) { cleanup(); throw new Error('the browser did not open its debugging port'); }

  // `script` runs before the page's own scripts (e.g. to fake window.Android)
  async function open(url, { script } = {}) {
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
    if (script) await send('Page.enable');
    if (script) await send('Page.addScriptToEvaluateOnNewDocument', { source: script });
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
      /** resizes the emulated screen (a rotation) */
      setViewport: (w, hgt) => send('Emulation.setDeviceMetricsOverride', { width: w, height: hgt, deviceScaleFactor: 1, mobile: true }),
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
    close: cleanup,
  };
}

module.exports = { fakeDeck, launchBrowser, findBrowser, sleep };
