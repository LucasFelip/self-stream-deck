'use strict';

// src/config.js against a throw-away data folder (SSD_DATA_DIR): defaults, BOM, token stability, unreadable file, atomic update.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok     ${name}`); };

// config.js reads SSD_DATA_DIR when loaded, so every scenario runs in its own process
function run(dir, code) {
  const result = spawnSync(process.execPath, ['-e', `const c = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config.js'))}); ${code}`], {
    env: { ...process.env, SSD_DATA_DIR: dir, SSD_PORT: '' },
    encoding: 'utf8',
  });
  return { status: result.status, out: result.stdout.trim(), err: result.stderr };
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ssd-config-'));
const readConfig = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

test('a first run writes the defaults and a random token, and the token survives the next run', () => {
  const dir = tempDir();
  const first = run(dir, 'console.log(c.load().token)');
  assert.match(first.out, /^[0-9a-f]{32}$/);
  const second = run(dir, 'console.log(c.load().token)');
  assert.strictEqual(second.out, first.out);
  const stored = readConfig(dir);
  assert.strictEqual(stored.token, first.out);
  assert.ok(Array.isArray(stored.shortcuts) && stored.shortcuts.length > 0);
});

test('a file with a UTF-8 BOM is read', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'config.json'), '﻿' + JSON.stringify({ token: 'b'.repeat(32), hidden: ['x'] }));
  const res = run(dir, 'const k = c.load(); console.log(k.token + " " + k.hidden)');
  assert.strictEqual(res.out, `${'b'.repeat(32)} x`);
});

test('an unreadable file stops the server and is left untouched (the token is never rotated silently)', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
  const res = run(dir, 'c.load()');
  assert.notStrictEqual(res.status, 0);
  assert.match(res.err, /not valid JSON/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{ not json');
});

test('SSD_PORT overrides the port for the run but is not written to the file', () => {
  const dir = tempDir();
  const result = spawnSync(process.execPath, ['-e', `const c = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config.js'))}); console.log(c.load().port)`], {
    env: { ...process.env, SSD_DATA_DIR: dir, SSD_PORT: '9999' },
    encoding: 'utf8',
  });
  assert.strictEqual(result.stdout.trim(), '9999');
  assert.strictEqual(readConfig(dir).port, 7878);
});

test('update changes only the editable keys, keeps the token, and leaves no temporary file', () => {
  const dir = tempDir();
  const res = run(dir, `
    const k = c.load();
    c.update(k, { shortcuts: [{ id: 'a', label: 'Á', keys: 'ctrl+a' }], token: 'hacked', lan: true });
    console.log(JSON.stringify({ token: k.token, lan: k.lan, shortcuts: k.shortcuts }));
  `);
  const memory = JSON.parse(res.out);
  assert.notStrictEqual(memory.token, 'hacked');
  assert.strictEqual(memory.lan, false);
  const stored = readConfig(dir);
  assert.strictEqual(stored.token, memory.token);
  assert.strictEqual(stored.lan, false);
  assert.strictEqual(stored.shortcuts[0].label, 'Á');
  assert.ok(!fs.existsSync(path.join(dir, 'config.json.tmp')));
});

test('every save keeps the previous version as config.json.bak', () => {
  const dir = tempDir();
  const res = run(dir, `
    const k = c.load();
    c.update(k, { hidden: ['one'] });
    c.update(k, { hidden: ['one', 'two'] });
  `);
  assert.strictEqual(res.status, 0, res.err);
  assert.deepStrictEqual(readConfig(dir).hidden, ['one', 'two']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json.bak'), 'utf8')).hidden, ['one']);
});

test('a change that would damage the file is refused with a 400 and nothing is written', () => {
  const dir = tempDir();
  const res = run(dir, `
    const k = c.load();
    const before = require('fs').readFileSync(${JSON.stringify(path.join(dir, 'config.json'))}, 'utf8');
    const attempts = [
      { shortcuts: [{ id: 'a', label: '\\uFFFDrea', keys: 'ctrl+a' }] },
      { shortcuts: [{ id: 'a', label: 'A', keys: 'ctrl+a' }, { id: 'a', label: 'B', keys: 'ctrl+b' }] },
      { macros: [{ id: 'm', steps: [] }, { id: 'm', steps: [] }] },
      { hidden: 'not a list' },
      { tileOrder: { apps: [1, 2] } },
    ];
    const out = [];
    for (const patch of attempts) {
      try { c.update(k, patch); out.push('saved'); } catch (err) { out.push(err.status + ' ' + err.message); }
    }
    out.push(String(require('fs').readFileSync(${JSON.stringify(path.join(dir, 'config.json'))}, 'utf8') === before));
    console.log(JSON.stringify(out));
  `);
  const out = JSON.parse(res.out);
  assert.match(out[0], /^400 .*damaged characters/);
  assert.match(out[1], /^400 .*unique/);
  assert.match(out[2], /^400 .*unique/);
  assert.match(out[3], /^400 .*list of app ids/);
  assert.match(out[4], /^400 .*tileOrder/);
  assert.strictEqual(out[5], 'true'); // the file is byte for byte what it was
});

test('a problem already in the file is a warning at start-up, not a reason to stop', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ token: 'c'.repeat(32), editor: 'yes', lan: false, shortcuts: [{ id: 'x', label: '�rea', keys: 'ctrl+a' }] }));
  const res = run(dir, 'console.log(c.load().token)');
  assert.strictEqual(res.status, 0, res.err);
  assert.strictEqual(res.out, 'c'.repeat(32));
  assert.match(res.err, /editor must be true or false/);
  assert.match(res.err, /damaged characters/);
});

test('an unreadable file names the backup when there is one', () => {
  const dir = tempDir();
  run(dir, 'const k = c.load(); c.update(k, { hidden: ["x"] });'); // makes config.json.bak
  fs.writeFileSync(path.join(dir, 'config.json'), '{ broken');
  const res = run(dir, 'c.load()');
  assert.notStrictEqual(res.status, 0);
  assert.match(res.err, /config\.json\.bak/);
  // and the backup itself is a usable config
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'config.json.bak'), 'utf8')).token);
});

test('a file that is already complete is not rewritten (no needless backup at every start)', () => {
  const dir = tempDir();
  run(dir, 'c.load()');
  const first = fs.statSync(path.join(dir, 'config.json')).mtimeMs;
  run(dir, 'c.load()');
  assert.strictEqual(fs.statSync(path.join(dir, 'config.json')).mtimeMs, first);
});

console.log(`${passed} passed`);
