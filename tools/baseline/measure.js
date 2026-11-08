'use strict';

// Numbers to compare every phase of the restructuring against (docs/plano-reestruturacao.md, Phase 0).
//
//   node tools/baseline/measure.js                      static numbers: size of the code and of the web interface
//   node tools/baseline/measure.js --live http://127.0.0.1:7878 --token T [--pid N] [--runs 50]
//                                                       also: latency of a few routes and the memory of the agent process
//
// The live part only reads (GET). Run it against YOUR agent, with your token: nothing here reads config.json.
// Output is one JSON object (also written to tools/baseline/last.json) so two runs can be diffed.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'data', '.git', 'target', 'dist', 'build', '.gradle'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').length;
const sum = (files) => files.reduce((n, f) => n + lines(f), 0);

function staticNumbers() {
  const server = path.join(ROOT, 'server');
  const byExt = (dir, exts) => (fs.existsSync(dir) ? walk(dir, (f) => exts.includes(path.extname(f))) : []);
  const publicDir = path.join(server, 'public');
  const web = walk(publicDir, (f) => ['.js', '.css', '.html'].includes(path.extname(f)));
  const bytes = web.reduce((n, f) => n + fs.statSync(f).size, 0);
  const gzip = web.reduce((n, f) => n + zlib.gzipSync(fs.readFileSync(f)).length, 0);
  const tests = byExt(path.join(server, 'test'), ['.js', '.ps1']);
  return {
    loc: {
      serverJs: sum(byExt(path.join(server, 'src'), ['.js'])),
      webJs: sum(web.filter((f) => f.endsWith('.js'))),
      webCss: sum(web.filter((f) => f.endsWith('.css'))),
      nativeCs: sum(byExt(path.join(server, 'native'), ['.cs'])),
      powershell: sum(byExt(path.join(server, 'scripts'), ['.ps1'])),
      androidJava: sum(byExt(path.join(ROOT, 'android'), ['.java', '.kt'])),
      tests: sum(tests),
    },
    web: { files: web.length, bytes, gzipBytes: gzip },
    dependencies: { server: Object.keys(JSON.parse(fs.readFileSync(path.join(server, 'package.json'), 'utf8')).dependencies || {}).length },
  };
}

function get(base, token, route) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, base);
    const started = process.hrtime.bigint();
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers: { 'X-Token': token } }, (res) => {
      let size = 0;
      res.on('data', (c) => { size += c.length; });
      res.on('end', () => resolve({ ms: Number(process.hrtime.bigint() - started) / 1e6, status: res.statusCode, size }));
    });
    req.on('error', reject);
    req.end();
  });
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function liveNumbers(base, token, runs, pid) {
  const result = { routes: {}, process: null };
  for (const route of ['/api/ping', '/api/state', '/api/apps', '/api/windows', '/api/audio', '/api/monitor/sample']) {
    const times = [];
    let status = 0;
    let size = 0;
    for (let i = 0; i < runs; i += 1) {
      const r = await get(base, token, route);
      times.push(r.ms);
      status = r.status;
      size = r.size;
    }
    times.sort((a, b) => a - b);
    result.routes[route] = { status, bytes: size, p50: +percentile(times, 50).toFixed(2), p95: +percentile(times, 95).toFixed(2), max: +times[times.length - 1].toFixed(2) };
  }
  if (pid && process.platform === 'win32') {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `$p = Get-Process -Id ${Number(pid)}; "$($p.WorkingSet64) $($p.PrivateMemorySize64) $($p.StartTime.ToString('o'))"`], { encoding: 'utf8' }).trim().split(' ');
    result.process = { pid: Number(pid), workingSetMB: +(Number(out[0]) / 1048576).toFixed(1), privateMB: +(Number(out[1]) / 1048576).toFixed(1), startedAt: out[2] };
  }
  return result;
}

(async () => {
  const report = { takenAt: new Date().toISOString(), static: staticNumbers() };
  const base = option('--live');
  if (base) report.live = await liveNumbers(base, option('--token') || '', Number(option('--runs') || 50), option('--pid'));
  const text = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(__dirname, 'last.json'), `${text}\n`);
  console.log(text);
})().catch((err) => { console.error(err.message); process.exit(1); });
