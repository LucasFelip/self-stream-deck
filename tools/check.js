'use strict';

// One command for "is everything still fine?" (docs/adr/0006). Runs the checks of every part of the repository that exists.
//
//   node tools/check.js             fast: lint + unit tests + contract tests   (what the pre-push hook runs)
//   node tools/check.js --full      also the interface tests (needs Chrome/Brave/Edge) and the integration tests (needs the real PC)
//   node tools/check.js --ci        fast + interface tests; no integration (a CI runner is not your PC)
//
// Parts are added here as they appear (web/ in Phase 2, agent/ in Phase 3).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const args = new Set(process.argv.slice(2));
const full = args.has('--full');
const ci = args.has('--ci');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const steps = [];
const add = (name, cwd, command, argv, when = true) => { if (when && fs.existsSync(path.join(ROOT, cwd))) steps.push({ name, cwd, command, argv }); };

// legacy Node server
add('legacy: lint', 'legacy/server', npm, ['run', 'lint']);
add('legacy: unit tests', 'legacy/server', npm, ['test']);
add('contract tests', 'tools/contract-test', npm, ['test']);
add('legacy: interface tests', 'legacy/server', npm, ['run', 'test:ui'], full || ci);
add('legacy: integration tests (real PC)', 'legacy/server', npm, ['run', 'test:integration'], full);

// later phases: web/ (Vitest, tsc, Playwright), agent/ (cargo fmt, clippy, test)
add('web: typecheck + tests', 'web', npm, ['test'], fs.existsSync(path.join(ROOT, 'web', 'package.json')));
add('agent: cargo test', 'agent', 'cargo', ['test'], fs.existsSync(path.join(ROOT, 'agent', 'Cargo.toml')));

const results = [];
for (const step of steps) {
  console.log(`\n=== ${step.name} (${step.cwd}) ===`);
  const started = Date.now();
  const run = spawnSync(step.command, step.argv, { cwd: path.join(ROOT, step.cwd), stdio: 'inherit', shell: process.platform === 'win32' });
  const ok = run.status === 0;
  results.push({ name: step.name, ok, seconds: Math.round((Date.now() - started) / 1000) });
  if (!ok) break; // the first red step is the one to look at
}

console.log('\n--- summary ---');
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name} (${r.seconds}s)`);
const skipped = steps.length - results.length;
if (skipped) console.log(`skipped after the failure: ${skipped}`);
process.exit(results.every((r) => r.ok) && results.length === steps.length ? 0 : 1);
