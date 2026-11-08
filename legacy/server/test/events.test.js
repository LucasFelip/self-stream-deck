'use strict';

// src/events.js: producers run only while somebody listens, a value is sent only when it changed, a client that joins gets the last one.
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok     ${name}`); };

function client() {
  const req = Object.assign(new EventEmitter(), { socket: { setNoDelay() {} } });
  const res = { chunks: [], writableNeedDrain: false, writeHead(status, headers) { this.status = status; this.headers = headers; }, write(chunk) { this.chunks.push(String(chunk)); return true; }, end() { this.ended = true; } };
  return { req, res, text: () => res.chunks.join('') };
}

const events = require('../src/events');
const calls = { start: 0, stop: 0 };
let publishNow = null;
events.register('demo', { start(publish) { calls.start += 1; publishNow = publish; }, stop() { calls.stop += 1; publishNow = null; } });

test('the producer starts with the first client and sends event-stream headers', () => {
  const a = client();
  events.subscribe(a.req, a.res, ['demo']);
  assert.strictEqual(calls.start, 1);
  assert.strictEqual(a.res.status, 200);
  assert.strictEqual(a.res.headers['Content-Type'], 'text/event-stream');
  publishNow({ n: 1 });
  assert.match(a.text(), /event: demo\ndata: \{"n":1\}\n\n/);
  a.req.emit('close');
});

test('it stops with the last client and starts again for the next one', () => {
  assert.strictEqual(calls.stop, 1);
  const a = client();
  events.subscribe(a.req, a.res, ['demo']);
  assert.strictEqual(calls.start, 2);
  a.req.emit('close');
});

test('an identical value is not sent twice; a different one is; force sends anyway', () => {
  const a = client();
  events.subscribe(a.req, a.res, ['demo']);
  publishNow({ n: 1 });
  publishNow({ n: 1 });
  publishNow({ n: 2 });
  publishNow({ n: 2 }, { force: true });
  const sent = a.text().match(/event: demo/g).length;
  assert.strictEqual(sent, 3);
  a.req.emit('close');
});

test('the signature decides what counts as a change (a moving counter does not)', () => {
  const a = client();
  events.subscribe(a.req, a.res, ['demo']);
  publishNow({ shown: 'x', ticking: 1 }, { signature: 'x' });
  publishNow({ shown: 'x', ticking: 2 }, { signature: 'x' });
  publishNow({ shown: 'y', ticking: 3 }, { signature: 'y' });
  assert.strictEqual(a.text().match(/event: demo/g).length, 2);
  a.req.emit('close');
});

test('a client that joins a running topic gets the last value at once, and both then get the next', () => {
  const first = client();
  events.subscribe(first.req, first.res, ['demo']);
  publishNow({ n: 7 });
  const second = client();
  events.subscribe(second.req, second.res, ['demo']);
  assert.match(second.text(), /data: \{"n":7\}/);
  publishNow({ n: 8 });
  assert.match(first.text(), /\{"n":8\}/);
  assert.match(second.text(), /\{"n":8\}/);
  const stopsBefore = calls.stop;
  first.req.emit('close');
  assert.strictEqual(calls.stop, stopsBefore, 'still one client: keeps running');
  second.req.emit('close');
  assert.strictEqual(calls.stop, stopsBefore + 1);
});

test('a client that cannot keep up misses a value instead of making the server buffer it', () => {
  const slow = client();
  events.subscribe(slow.req, slow.res, ['demo']);
  slow.res.writableNeedDrain = true;
  const before = slow.res.chunks.length;
  publishNow({ n: 99 });
  assert.strictEqual(slow.res.chunks.length, before);
  slow.req.emit('close');
});

test('unknown topics are ignored by subscribe and listed by names()', () => {
  assert.deepStrictEqual(events.names(), ['demo']);
  const startsBefore = calls.start;
  const a = client();
  events.subscribe(a.req, a.res, ['nope']);
  assert.strictEqual(calls.start, startsBefore); // an unknown topic starts nothing
  a.req.emit('close');
});

console.log(`\n${passed} passed`);
process.exit(0);
