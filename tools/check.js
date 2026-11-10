'use strict';

// One command for "is everything still fine?" (docs/adr/0006). Runs the checks of every part of the repository that exists.
//
//   node tools/check.js             fast: lint + unit tests + the Rust agent against the contract   (what the pre-push hook runs)
//   node tools/check.js --full      also the interface tests (needs Chrome/Brave/Edge)
//   node tools/check.js --ci        the same as --full (a CI runner is not your PC)
//
// Parts are added here as they appear (web/ since Phase 2, agent/ in Phase 3).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const args = new Set(process.argv.slice(2));
const full = args.has('--full');
const ci = args.has('--ci');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

process.env.PATH = `${path.join(process.env.USERPROFILE || process.env.HOME || '', '.cargo', 'bin')}${path.delimiter}${process.env.PATH}`;
const steps = [];
const add = (name, cwd, command, argv, when = true) => { if (when && fs.existsSync(path.join(ROOT, cwd))) steps.push({ name, cwd, command, argv }); };

// the new interface: generated API types up to date, tsc --strict, ESLint, Vitest; then its build and browser tests (same harness as the old UI)
add('web: types + lint + unit tests', 'web', npm, ['test']);
add('web: build + browser tests', 'web', npm, ['run', 'test:e2e'], full || ci);

// the Rust agent (agent/): format, lints as errors, unit tests, then the release build checked from outside (contract + security)
const hasAgent = fs.existsSync(path.join(ROOT, 'agent', 'Cargo.toml'));
add('agent: cargo fmt --check', 'agent', 'cargo', ['fmt', '--all', '--check'], hasAgent);
add('agent: cargo clippy', 'agent', 'cargo', ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings'], hasAgent);
add('agent: cargo test', 'agent', 'cargo', ['test', '--workspace'], hasAgent);
add('agent: release build', 'agent', 'cargo', ['build', '--release', '-p', 'ssd-agent'], hasAgent);
// the contract (every operation, schemas, security) and the outside-in checks run against that build, on a fake PC
steps.push({ name: 'docs: links and anchors', cwd: 'tools/docs-check', command: 'node', argv: ['run.cjs'] });
add('contract tests (agent on a fake PC)', 'tools/contract-test', npm, ['test']);
if (hasAgent) steps.push({ name: 'agent: conformance (security, pairing, static files, camera)', cwd: 'tools/agent-check', command: 'node', argv: ['run.js'] });

const results = [];
for (const step of steps) {
  console.log(`\n=== ${step.name} (${step.cwd}) ===`);
  const started = Date.now();
  const run = spawnSync(step.command, step.argv, { cwd: path.join(ROOT, step.cwd), stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...(step.env || {}) } });
  const ok = run.status === 0;
  results.push({ name: step.name, ok, seconds: Math.round((Date.now() - started) / 1000) });
  if (!ok) break; // the first red step is the one to look at
}

console.log('\n--- summary ---');
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name} (${r.seconds}s)`);
const skipped = steps.length - results.length;
if (skipped) console.log(`skipped after the failure: ${skipped}`);
process.exit(results.every((r) => r.ok) && results.length === steps.length ? 0 : 1);
