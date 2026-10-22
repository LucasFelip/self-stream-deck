'use strict';

// The two ways to run a helper, through src/host.js: the native exe, and the PowerShell script it falls back to
// (forced here with SSD_NO_NATIVE). Plus a guard that the C# has one copy: no class of native/*.cs is also written inside a script.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };

const root = path.join(__dirname, '..');

// the Host of a child process, so SSD_NO_NATIVE is read when native.js is first used
function ask(env) {
  const code = `
    const { Host } = require(${JSON.stringify(path.join(root, 'src', 'host.js'))});
    const host = new Host('probe', 'input-host.ps1', { native: 'input' });
    host.request({ op: 'ping' }, 30000).then(async (reply) => {
      const volume = await host.request({ op: 'getVolume' });
      console.log(JSON.stringify({ ok: reply.ok, native: host.command.native, level: typeof volume.level }));
      host.stop();
      process.exit(0);
    }).catch((err) => { console.log(JSON.stringify({ error: err.message })); process.exit(1); });
  `;
  const result = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 90000 });
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

(async () => {
  await test('with the native helper available it is the one that runs (when it can be built)', async () => {
    const exe = await require('../src/native').ensure();
    if (!exe) { console.log('       skipped: the native helper cannot be built here'); return; }
    const reply = ask({});
    assert.strictEqual(reply.ok, true);
    assert.strictEqual(reply.native, true);
    assert.strictEqual(reply.level, 'number');
  });

  await test('SSD_NO_NATIVE=1 runs the PowerShell script instead, and it answers the same requests', async () => {
    const reply = ask({ SSD_NO_NATIVE: '1' });
    assert.strictEqual(reply.ok, true);
    assert.strictEqual(reply.native, false);
    assert.strictEqual(reply.level, 'number');
  });

  await test('the C# has one copy: no class from native/*.cs is also written inside a script', () => {
    const classes = new Set();
    for (const file of fs.readdirSync(path.join(root, 'native')).filter((name) => name.endsWith('.cs'))) {
      for (const [, name] of fs.readFileSync(path.join(root, 'native', file), 'utf8').matchAll(/\bclass\s+(\w+)/g)) classes.add(name);
    }
    assert.ok(classes.has('DeckNative') && classes.has('VCam'));
    for (const script of fs.readdirSync(path.join(root, 'scripts')).filter((name) => name.endsWith('.ps1'))) {
      const text = fs.readFileSync(path.join(root, 'scripts', script), 'utf8');
      for (const name of classes) assert.ok(!new RegExp(`\\bclass\\s+${name}\\b`).test(text), `${script} defines class ${name} again`);
    }
  });

  console.log(`${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
