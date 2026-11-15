'use strict';

// Records the made-up PC of the Rust agent (`ssd --fake-platform`) as web/src/demo/snapshot.json: the answer of every GET route the panel reads,
// which web/src/demo/shim.ts then plays back in a browser with no PC (the demo, docs/desenvolvimento.md).
//
//   node tools/demo/record.cjs        (needs agent/target/release/ssd.exe: cargo build --release -p ssd-agent in agent/)
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const EXE = process.env.SSD_AGENT_EXE || path.join(ROOT, 'agent', 'target', 'release', process.platform === 'win32' ? 'ssd.exe' : 'ssd');
const OUT = path.join(ROOT, 'web', 'src', 'demo', 'snapshot.json');
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'fixtures', 'fake-pc.json'), 'utf8'));
const PORT = 7999;
const TOKEN = fixture.token;

// the routes the panel reads (a GET each); the rest is played by the shim
const ROUTES = [
  '/api/state', '/api/apps', '/api/shortcuts', '/api/macros', '/api/layout', '/api/windows', '/api/screens', '/api/audio', '/api/volume', '/api/media',
  '/api/monitor/sample', '/api/monitor/processes', '/api/monitor/info', '/api/monitor/fps', '/api/power', '/api/camera/status', '/api/editor', '/api/pair-code',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const get = (route) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: route, headers: { 'X-Token': TOKEN } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  }).on('error', reject);
});

(async () => {
  if (!fs.existsSync(EXE)) { console.error(`no agent at ${EXE}: cargo build --release -p ssd-agent in agent/`); process.exit(1); }
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ssd-demo-'));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ ...fixture.config, token: TOKEN, port: PORT }));
  const child = spawn(EXE, ['--data-dir', data, '--port', String(PORT), '--fake-platform', '--no-tray'], { stdio: 'ignore', // the name of the PC is the made-up one: nothing of the machine that records goes into the file
  env: { ...process.env, SSD_NO_FIREWALL: '1', COMPUTERNAME: 'PC-DEMO' } });
  try {
    for (let i = 0; i < 60; i += 1) {
      const up = await get('/api/ping').then((r) => r.status === 200, () => false);
      if (up) break;
      await sleep(250);
    }
    const snapshot = {};
    for (const route of ROUTES) {
      const answer = await get(route);
      if (answer.status !== 200) { console.error(`${route} answered ${answer.status}`); process.exit(1); }
      snapshot[route] = JSON.parse(answer.body);
    }
    // the pairing code of a demo is not the fixture's token
    snapshot['/api/pair-code'] = { code: 'demo' };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`${ROUTES.length} routes recorded in ${path.relative(ROOT, OUT)}`);
  } finally {
    child.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
})();
