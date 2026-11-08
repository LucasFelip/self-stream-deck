'use strict';

// src/host.js with a stand-in helper (a Node script that speaks the same line protocol): a helper that dies in the middle
// of a request is started again and a read is asked once more, but an action is never repeated.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Host } = require('../src/host');

process.env.SSD_LOG = 'error'; // the warnings about the deaths below are expected

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssd-host-'));
const log = path.join(dir, 'calls.log');
const helper = path.join(dir, 'helper.js');

// "die-<op>" requests: the first time one of an op arrives the helper records it and exits without answering; later ones are answered
fs.writeFileSync(helper, `
const fs = require('fs');
const log = ${JSON.stringify(log)};
const seen = new Set(fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).map((l) => l.split(' ')[0] + ' ' + l.split(' ')[1]) : []);
process.stdout.write(JSON.stringify({ id: 0, ok: true }) + '\\n');
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, op } = JSON.parse(line);
  const first = !fs.readFileSync(log, 'utf8').split('\\n').some((l) => l.startsWith('start ' + op));
  fs.appendFileSync(log, (first ? 'start ' : 'again ') + op + '\\n');
  if (first && op.startsWith('die-')) process.exit(3);
  process.stdout.write(JSON.stringify({ id, ok: true, op }) + '\\n');
});
`);
fs.writeFileSync(log, '');

const make = (options) => {
  const host = new Host('fake', 'input-host.ps1', options);
  host.resolveCommand = async () => (host.command = { file: process.execPath, args: [helper], native: false });
  return host;
};
const calls = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };

(async () => {
  await test('a read is asked again when the helper dies while answering, and the helper comes back', async () => {
    const host = make({ retryOps: ['die-read'] });
    let ready = 0;
    host.events.on('ready', () => { ready += 1; });
    const reply = await host.request({ op: 'die-read' });
    assert.strictEqual(reply.ok, true);
    assert.deepStrictEqual(calls().filter((l) => l.endsWith('die-read')), ['start die-read', 'again die-read']);
    assert.strictEqual(ready, 2); // once for the first process, once for the new one
    host.stop();
  });

  await test('an action is never repeated: the failure is reported and the next request works', async () => {
    const host = make({ retryOps: ['die-read'] });
    await assert.rejects(host.request({ op: 'die-act' }), /helper exited/);
    assert.deepStrictEqual(calls().filter((l) => l.endsWith('die-act')), ['start die-act']); // asked exactly once
    assert.strictEqual((await host.request({ op: 'ping' })).ok, true); // a fresh helper takes over
    host.stop();
  });

  await test('the log level hides what is below it (SSD_LOG)', () => {
    const { log: logger } = require('../src/log');
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      process.env.SSD_LOG = 'warn';
      logger.info('[t] hidden');
      logger.debug('[t] hidden too');
      process.env.SSD_LOG = 'debug';
      logger.debug('[t] shown');
    } finally {
      console.log = original;
      process.env.SSD_LOG = 'error';
    }
    assert.deepStrictEqual(lines, ['[t] shown']);
  });

  console.log(`${passed} passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
