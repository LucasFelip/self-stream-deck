'use strict';

// src/macros.js: what the editor may store, and how a macro runs.
const assert = require('node:assert');
const macros = require('../src/macros');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };
const apps = new Set(['brave-1', 'discord-2']);

(async () => {
  await test('a shortcut keeps a valid id, gets a new one otherwise, and normalizes its keys', () => {
    const [a, b] = macros.normalizeShortcuts([{ id: 'copy', label: '  Copiar  ', keys: 'Ctrl + C' }, { label: 'Captura de tela', keys: 'win+shift+s' }]);
    assert.deepStrictEqual(a, { id: 'copy', label: 'Copiar', keys: 'ctrl+c' });
    assert.match(b.id, /^captura-de-tela-[0-9a-f]{4}$/);
  });

  await test('shortcuts with an unknown key, too many keys or no label are refused', () => {
    assert.throws(() => macros.normalizeShortcuts([{ label: 'x', keys: 'ctrl+banana' }]), /unknown key/);
    assert.throws(() => macros.normalizeShortcuts([{ label: 'x', keys: 'a+b+c+d+e+f' }]), /too many keys/);
    assert.throws(() => macros.normalizeShortcuts([{ label: ' ', keys: 'ctrl+c' }]), /empty/);
    assert.throws(() => macros.normalizeShortcuts('nope'), /invalid/);
  });

  await test('a macro accepts every step type and keeps their order', () => {
    const [macro] = macros.normalizeMacros([{ label: 'Call', page: 'apps', steps: [
      { type: 'launch', app: 'discord-2' }, { type: 'place', app: 'brave-1', monitor: 1, zone: 'left' }, { type: 'keys', keys: 'ctrl+shift+m' },
      { type: 'media', key: 'playpause' }, { type: 'volume', level: '40' }, { type: 'mute', muted: 'toggle' }, { type: 'mic', muted: false },
      { type: 'output', device: '{0.0.0.00000000}.{abc}', name: 'Fones' }, { type: 'wait', ms: 1500 }, { type: 'camera', on: true },
    ] }], apps);
    assert.deepStrictEqual(macro.steps.map((step) => step.type), ['launch', 'place', 'keys', 'media', 'volume', 'mute', 'mic', 'output', 'wait', 'camera']);
    assert.strictEqual(macro.page, 'apps');
    assert.strictEqual(macro.steps[4].level, 40);
  });

  await test('steps that could run anything else are refused', () => {
    const attempt = (step) => () => macros.normalizeMacros([{ label: 'x', steps: [step] }], apps);
    assert.throws(attempt({ type: 'run', command: 'calc.exe' }), /unknown step type/);
    assert.throws(attempt({ type: 'launch', app: 'C:\\Windows\\notepad.exe' }), /unknown app/);
    assert.throws(attempt({ type: 'launch', app: 'not-an-app' }), /unknown app/);
    assert.throws(attempt({ type: 'power', action: 'shutdown' }), /unknown step type/);
    assert.throws(attempt({ type: 'volume', level: 150 }), /level/);
    assert.throws(attempt({ type: 'wait', ms: 99999 }), /wait/);
    assert.throws(attempt({ type: 'media', key: 'eject' }), /media key/);
    assert.throws(attempt({ type: 'place', app: 'brave-1', monitor: 0, zone: 'top' }), /zone/);
  });

  await test('size limits: too many steps, endless waits, no steps', () => {
    const many = Array.from({ length: 41 }, () => ({ type: 'media', key: 'next' }));
    assert.throws(() => macros.normalizeMacros([{ label: 'x', steps: many }], apps), /steps/);
    const waits = Array.from({ length: 7 }, () => ({ type: 'wait', ms: 10000 }));
    assert.throws(() => macros.normalizeMacros([{ label: 'x', steps: waits }], apps), /minute/);
    assert.throws(() => macros.normalizeMacros([{ label: 'x', steps: [] }], apps), /steps/);
  });

  await test('run: steps go in order, a failing step is reported and the rest still run, camera steps go back to the phone', async () => {
    const calls = [];
    const handlers = {
      launch: async (step) => { calls.push(`launch ${step.app}`); },
      keys: async () => { throw new Error('boom'); },
      volume: async (step) => { calls.push(`volume ${step.level}`); },
    };
    const waited = [];
    const outcome = await macros.run({ steps: [
      { type: 'launch', app: 'a' }, { type: 'keys', keys: 'ctrl+c' }, { type: 'wait', ms: 500 }, { type: 'camera', on: true }, { type: 'volume', level: 30 },
    ] }, handlers, async (ms) => { waited.push(ms); });
    assert.deepStrictEqual(calls, ['launch a', 'volume 30']);
    assert.deepStrictEqual(waited, [500]);
    assert.strictEqual(outcome.failed, 1);
    assert.deepStrictEqual(outcome.results.map((result) => result.ok), [true, false, true, true, true]);
    assert.strictEqual(outcome.results[1].error, 'boom');
    assert.deepStrictEqual(outcome.client, [{ type: 'camera', on: true }]);
  });

  console.log(`\n${passed} passed`);
})().catch((err) => { console.log(err); process.exit(1); });
