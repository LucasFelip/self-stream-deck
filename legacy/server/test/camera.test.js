'use strict';

// camera.js: frames in, an MJPEG stream out. Fake request/response objects, no network.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const camera = require('../src/camera');

const frame = fs.readFileSync(path.join(__dirname, '..', 'assets', 'nosignal.jpg'));
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok     ${name}`); };

function viewer() {
  const req = new EventEmitter();
  const res = { chunks: [], head: null, writableNeedDrain: false, writeHead(status, headers) { this.head = { status, headers }; }, write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; }, end() { this.ended = true; } };
  return { req, res };
}
const parts = (res) => Buffer.concat(res.chunks).toString('latin1').split('--ssdframe').length - 1;

test('a viewer gets multipart headers and a first picture right away', () => {
  const { req, res } = viewer();
  camera.attach(req, res);
  assert.strictEqual(res.head.status, 200);
  assert.match(res.head.headers['Content-Type'], /^multipart\/x-mixed-replace; boundary=ssdframe$/);
  assert.strictEqual(parts(res), 1); // the "no signal" picture, since nothing was sent yet
  req.emit('close');
});

test('a pushed frame reaches every viewer, a closed viewer gets nothing more', () => {
  const a = viewer();
  const b = viewer();
  camera.attach(a.req, a.res);
  camera.attach(b.req, b.res);
  b.req.emit('close');
  camera.push(frame);
  assert.strictEqual(parts(a.res), 2);
  assert.strictEqual(parts(b.res), 1);
  a.req.emit('close');
});

test('a new viewer starts with the latest frame while the phone is live', () => {
  const { req, res } = viewer();
  camera.attach(req, res);
  assert.ok(Buffer.concat(res.chunks).includes(frame.subarray(0, 64)));
  assert.strictEqual(camera.status().live, true);
  req.emit('close');
});

test('anything that is not a JPEG is refused', () => {
  assert.throws(() => camera.push(Buffer.from('hello world')), /not a JPEG/);
  assert.throws(() => camera.push(Buffer.alloc(camera.MAX_FRAME + 1, 0xff)), /not a JPEG/);
});

test('a slow viewer drops frames instead of buffering them', () => {
  const { req, res } = viewer();
  camera.attach(req, res);
  res.writableNeedDrain = true;
  const before = res.chunks.length;
  camera.push(frame);
  assert.strictEqual(res.chunks.length, before);
  req.emit('close');
});

test('status reports the frame rate and data rate of what arrived', () => {
  for (let i = 0; i < 5; i += 1) camera.push(frame);
  const status = camera.status();
  assert.ok(status.kbps > 0);
  assert.ok(status.fps >= 0);
});

test('wanted: true only while somebody watches the stream', () => {
  const watcher = viewer();
  camera.attach(watcher.req, watcher.res);
  assert.strictEqual(camera.wanted(), true);
  assert.strictEqual(camera.status().wanted, true);
  watcher.req.emit('close');
  assert.strictEqual(camera.wanted(), false);
});

console.log(`\n${passed} passed`);
process.exit(0);
