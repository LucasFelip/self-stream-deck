'use strict';

// src/security.js: token check (query, header, cookie), lock-out after repeated failures, Host and Origin checks.
const assert = require('node:assert');
const os = require('node:os');
const { createGuard } = require('../src/security');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok     ${name}`); };

const TOKEN = 'a'.repeat(32);
const guard = createGuard({ token: TOKEN });
const req = (headers = {}) => ({ headers });
const url = (query = '') => new URL(`http://localhost/${query}`);

test('the token is accepted from the query string, the X-Token header and the cookie', () => {
  assert.ok(guard.isAuthenticated(req(), url(`?token=${TOKEN}`)));
  assert.ok(guard.isAuthenticated(req({ 'x-token': TOKEN }), url()));
  assert.ok(guard.isAuthenticated(req({ cookie: `other=1; ssd_token=${TOKEN}` }), url()));
});

test('a missing, wrong or malformed token is refused', () => {
  assert.ok(!guard.isAuthenticated(req(), url()));
  assert.ok(!guard.isAuthenticated(req({ 'x-token': 'b'.repeat(32) }), url()));
  assert.ok(!guard.isAuthenticated(req({ 'x-token': TOKEN.slice(1) }), url()));
  assert.ok(!guard.isAuthenticated(req({ cookie: 'ssd_token=%E0%A4%A' }), url()));
});

test('ten failures lock an address out; another address is unaffected', () => {
  const g = createGuard({ token: TOKEN });
  for (let i = 0; i < 9; i += 1) g.recordFailure('10.0.0.5');
  assert.ok(!g.isLockedOut('10.0.0.5'));
  g.recordFailure('10.0.0.5');
  assert.ok(g.isLockedOut('10.0.0.5'));
  assert.ok(!g.isLockedOut('10.0.0.6'));
});

test('the lock-out ends after the window', () => {
  const g = createGuard({ token: TOKEN });
  const realNow = Date.now;
  try {
    for (let i = 0; i < 10; i += 1) g.recordFailure('10.0.0.7');
    assert.ok(g.isLockedOut('10.0.0.7'));
    Date.now = () => realNow() + 61_000;
    assert.ok(!g.isLockedOut('10.0.0.7'));
  } finally {
    Date.now = realNow;
  }
});

test('the failure table stays bounded', () => {
  const g = createGuard({ token: TOKEN });
  for (let i = 0; i < 500; i += 1) g.recordFailure(`10.1.${i >> 8}.${i & 255}`);
  g.recordFailure('10.9.9.9');
  assert.ok(!g.isLockedOut('10.1.0.0'));
});

test('only IPs, localhost and this machine name are valid Host headers (DNS rebinding)', () => {
  assert.ok(guard.isAllowedHost('127.0.0.1:7878'));
  assert.ok(guard.isAllowedHost('192.168.0.10:7879'));
  assert.ok(guard.isAllowedHost('localhost:7878'));
  assert.ok(guard.isAllowedHost('[::1]:7878'));
  assert.ok(guard.isAllowedHost(`${os.hostname().toUpperCase()}:7878`));
  assert.ok(!guard.isAllowedHost('evil.example.com'));
  assert.ok(!guard.isAllowedHost('evil.example.com:7878'));
  assert.ok(!guard.isAllowedHost(undefined));
});

test('a cross-site Origin is refused, same-origin and no Origin are accepted', () => {
  assert.ok(guard.isSameOrigin(req({ host: '127.0.0.1:7878' })));
  assert.ok(guard.isSameOrigin(req({ host: '127.0.0.1:7878', origin: 'http://127.0.0.1:7878' })));
  assert.ok(!guard.isSameOrigin(req({ host: '127.0.0.1:7878', origin: 'https://evil.example.com' })));
  assert.ok(!guard.isSameOrigin(req({ host: '127.0.0.1:7878', origin: 'not a url' })));
});

test('the pairing cookie is HttpOnly and SameSite, and Secure only over HTTPS', () => {
  assert.match(guard.pairingCookie(false), /HttpOnly; SameSite=Lax$/);
  assert.match(guard.pairingCookie(true), /; Secure$/);
});

console.log(`${passed} passed`);
