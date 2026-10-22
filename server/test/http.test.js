'use strict';

// src/http.js against a real local server: security headers, static file rules (no traversal, known types only), ETag/304, body limits.
const assert = require('node:assert');
const http = require('node:http');
const { sendJson, serveStatic, readJson, readBuffer, isStaticPath } = require('../src/http');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/json') return sendJson(res, 200, await readJson(req));
    if (url.pathname === '/small-json') return sendJson(res, 200, await readJson(req, 16));
    if (url.pathname === '/buffer') return sendJson(res, 200, { bytes: (await readBuffer(req, 8)).length });
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.message });
  }
});

function request(path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await test('the home page is served with the security headers', async () => {
      const res = await request('/');
      assert.strictEqual(res.status, 200);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(res.headers['x-frame-options'], 'DENY');
      assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
    });

    await test('an unchanged file answers 304 with the same ETag and no body', async () => {
      const first = await request('/app.js');
      assert.ok(first.headers.etag);
      const second = await request('/app.js', { headers: { 'If-None-Match': first.headers.etag } });
      assert.strictEqual(second.status, 304);
      assert.strictEqual(second.body, '');
    });

    await test('paths outside public/, unknown types and missing files are 404', async () => {
      for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%5csrc%5cconfig.js', '/%2e%2e%2fsrc%2fconfig.js', '/nope.js', '/data.json', '/%E0%A4%A.js']) {
        const res = await request(path);
        assert.strictEqual(res.status, 404, path);
      }
    });

    await test('isStaticPath only accepts the root and known web file types', () => {
      assert.ok(isStaticPath('/'));
      assert.ok(isStaticPath('/js/live.js'));
      assert.ok(!isStaticPath('/api/state'));
      assert.ok(!isStaticPath('/config.json'));
    });

    await test('readJson parses a body, treats an empty one as {}, and rejects invalid JSON with 400', async () => {
      const ok = await request('/json', { method: 'POST', body: '{"a":1}' });
      assert.deepStrictEqual(JSON.parse(ok.body), { a: 1 });
      const empty = await request('/json', { method: 'POST' });
      assert.deepStrictEqual(JSON.parse(empty.body), {});
      const bad = await request('/json', { method: 'POST', body: '{nope' });
      assert.strictEqual(bad.status, 400);
    });

    await test('bodies over the limit are refused with 413', async () => {
      const json = await request('/small-json', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(100) }) }).catch((err) => ({ status: err.code }));
      assert.ok(json.status === 413 || json.status === 'ECONNRESET', String(json.status));
      const buffer = await request('/buffer', { method: 'POST', body: Buffer.alloc(64) }).catch((err) => ({ status: err.code }));
      assert.ok(buffer.status === 413 || buffer.status === 'ECONNRESET', String(buffer.status));
    });
  } finally {
    server.close();
  }
  console.log(`${passed} passed`);
})().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
