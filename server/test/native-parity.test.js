'use strict';

// The native helper (native/*.cs) against the PowerShell helper it replaces: same requests, same answers.
// Read-only operations only. Skipped where the native helper cannot be built.
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
let passed = 0;

function start(command, args) {
  const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let buffered = '';
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, at).trim().replace(/^\uFEFF/, '');
      buffered = buffered.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id === 0) ready();
      else if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    }
  });
  let next = 1;
  return {
    ready: readyPromise,
    ask: (payload) => new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
    }),
    stop: () => child.kill(),
  };
}

// types and key names only: the values of live things (titles, positions, volumes) move between two calls
const shape = (value) => {
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter((k) => k !== 'id').sort().map((k) => [k, shape(value[k])]));
  return value === null ? 'null' : typeof value;
};
const strip = ({ id, ...rest }) => rest;

(async () => {
  const exe = await require('../src/native').ensure();
  if (!exe) { console.log('skipped (the native helper cannot be built here)'); process.exit(0); }

  const ps = start('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'input-host.ps1')]);
  const native = start(exe, ['input']);
  await Promise.all([ps.ready, native.ready]);

  const both = async (payload) => [await ps.ask(payload), await native.ask(payload)];
  const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };

  await test('ping, getVolume and getMic answer the same', async () => {
    for (const op of ['ping', 'getVolume', 'getMic']) {
      const [a, b] = await both({ op });
      assert.deepStrictEqual(strip(b), strip(a), op);
    }
  });

  await test('devices: same playback and capture lists, names and defaults', async () => {
    const [a, b] = await both({ op: 'devices' });
    assert.deepStrictEqual(b.playback, a.playback);
    assert.deepStrictEqual(b.capture, a.capture);
  });

  await test('writes that change nothing: the same volume and the same mute state give the same answer', async () => {
    const [{ level, muted }] = await both({ op: 'getVolume' });
    const [va, vb] = await both({ op: 'setVolume', level });
    assert.deepStrictEqual(strip(vb), strip(va));
    assert.strictEqual(va.level, level);
    const [ma, mb] = await both({ op: 'setMute', muted });
    assert.deepStrictEqual(strip(mb), strip(ma));
    assert.strictEqual(ma.muted, muted);
  });

  await test('writes aimed at a device or session that does not exist behave the same (the routes check ids first anyway)', async () => {
    // changing the default device fails in both, each with the wording Windows gave it
    const [da, db] = await both({ op: 'setDefaultDevice', id: 'no-such-device' });
    assert.strictEqual(da.ok, false);
    assert.strictEqual(db.ok, false);
    assert.ok(da.error && db.error);
    // volume and mute of a missing device or session are quietly ignored in both
    for (const payload of [{ op: 'setDeviceVolume', id: 'no-such-device', level: 10 }, { op: 'setDeviceMute', id: 'no-such-device', muted: false }, { op: 'setSessionVolume', pid: 999999, level: 10 }, { op: 'setSessionMute', pid: 999999, muted: false }]) {
      const [a, b] = await both(payload);
      assert.deepStrictEqual(strip(b), strip(a), payload.op);
    }
  });

  await test('monitors: same screens and geometry', async () => {
    const [a, b] = await both({ op: 'monitors', brightness: false });
    assert.deepStrictEqual(b.monitors, a.monitors);
  });

  await test('sessions and windows: same shape, same set of apps', async () => {
    const [sa, sb] = await both({ op: 'sessions' });
    assert.deepStrictEqual(shape(sb), shape(sa));
    assert.deepStrictEqual(sb.sessions.map((s) => s.name).sort(), sa.sessions.map((s) => s.name).sort());
    const [wa, wb] = await both({ op: 'windows' });
    assert.deepStrictEqual(shape(wb), shape(wa));
    assert.deepStrictEqual(wb.windows.map((w) => w.handle).sort(), wa.windows.map((w) => w.handle).sort());
    assert.deepStrictEqual([...wb.running].sort(), [...wa.running].sort());
  });

  await test('refusals match: a handle that is not a window, an unknown op, and focus on a name nobody runs', async () => {
    const [a, b] = await both({ op: 'windowAction', handle: 123456789, action: 'minimize' });
    assert.strictEqual(a.ok, false);
    assert.strictEqual(b.ok, false);
    assert.strictEqual(b.error, a.error);
    const [ua, ub] = await both({ op: 'definitelyNot' });
    assert.strictEqual(ub.ok, false);
    assert.strictEqual(ub.error, ua.error);
    const [fa, fb] = await both({ op: 'focus', name: 'no-such-process-name' });
    assert.deepStrictEqual(strip(fb), strip(fa));
  });

  ps.stop();
  native.stop();

  // --- media ---
  const psMedia = start('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'media-host.ps1')]);
  const nativeMedia = start(exe, ['media']);
  await Promise.all([psMedia.ready, nativeMedia.ready]);
  const bothMedia = async (payload) => [await psMedia.ask(payload), await nativeMedia.ask(payload)];

  await test('media state: same sessions, titles and controls (the position moves between the two calls)', async () => {
    const [a, b] = await bothMedia({ op: 'state' });
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(b.current, a.current);
    assert.strictEqual(b.sessions.length, a.sessions.length);
    const drop = ({ position, ...rest }) => rest;
    assert.deepStrictEqual(b.sessions.map(drop), a.sessions.map(drop));
    assert.deepStrictEqual(shape(b.sessions), shape(a.sessions));
    if (a.sessions.length) {
      const [ra, rb] = await bothMedia({ op: 'art', session: a.sessions[0].id });
      // PowerShell cannot read the content type of the WinRT stream (null); the native helper can
      assert.ok(rb.mime === ra.mime || ra.mime == null, `mime ${rb.mime} vs ${ra.mime}`);
      assert.strictEqual(rb.data, ra.data);
    }
  });

  await test('media refusals match: unknown session and unknown op', async () => {
    const [a, b] = await bothMedia({ op: 'control', session: 'no.such.app', action: 'toggle' });
    assert.strictEqual(b.ok, false);
    assert.strictEqual(b.error, a.error);
    const [ua, ub] = await bothMedia({ op: 'nope' });
    assert.strictEqual(ub.error, ua.error);
  });
  psMedia.stop();
  nativeMedia.stop();

  // --- monitor ---
  const psMonitor = start('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'monitor-host.ps1')]);
  const nativeMonitor = start(exe, ['monitor']);
  await Promise.all([psMonitor.ready, nativeMonitor.ready]);
  const bothMonitor = async (payload) => [await psMonitor.ask(payload), await nativeMonitor.ask(payload)];

  await test('monitor info: the same hardware and system description', async () => {
    const [a, b] = await bothMonitor({ op: 'info' });
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
    assert.deepStrictEqual(b.info, a.info);
  });

  await test('monitor sample: same shape, same cores and disks, plausible values', async () => {
    await bothMonitor({ op: 'sample' }); // the first sample only primes the counters
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const [c, d] = await bothMonitor({ op: 'sample' });
    assert.deepStrictEqual(shape(d), shape(c));
    assert.strictEqual(d.cpu.cores.length, c.cpu.cores.length);
    assert.deepStrictEqual(d.disk.disks.map((x) => x.name), c.disk.disks.map((x) => x.name));
    assert.deepStrictEqual(d.network.map((x) => x.name), c.network.map((x) => x.name));
    assert.deepStrictEqual(d.disk.drives.map((x) => x.name), c.disk.drives.map((x) => x.name));
    assert.ok(Math.abs(d.memory.usedPct - c.memory.usedPct) <= 5);
    assert.ok(d.cpu.usage >= 0 && d.cpu.usage <= 100);
    assert.ok(d.uptime > 0);
  });

  await test('monitor processes: same shape', async () => {
    await bothMonitor({ op: 'processes' });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const [a, b] = await bothMonitor({ op: 'processes' });
    assert.deepStrictEqual(shape(b), shape(a));
    assert.strictEqual(b.top.cpu.length, a.top.cpu.length);
    assert.strictEqual(b.top.mem.length, a.top.mem.length);
  });
  psMonitor.stop();
  nativeMonitor.stop();

  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((err) => { console.log(err); process.exit(1); });
