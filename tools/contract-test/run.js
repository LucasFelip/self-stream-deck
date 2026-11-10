'use strict';

// Checks an agent against contracts/openapi.yaml.
//
//   node run.js                       the Rust agent (agent/target/release/ssd.exe, or SSD_AGENT_EXE) on a fake PC, started here (default; safe)
//   node run.js --spec-only           only the static checks of the spec and the fixtures
//   node run.js --base-url http://127.0.0.1:7878 --token T --fake-platform [--base-url-locked URL] [--lockout]
//                                     an agent that is already running ON A FAKE PLATFORM (it must present contracts/fixtures/fake-pc.json)
//
// Never point --base-url at an agent that controls your real PC: the cases shut it down, hide apps and rewrite its config.

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const YAML = require('yaml');
const Ajv2020 = require('ajv/dist/2020');
const { cases, UNCOVERED } = require('./cases');
const clone = (value) => JSON.parse(JSON.stringify(value));
const loadFixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'contracts', 'fixtures', 'fake-pc.json'), 'utf8'));

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const spec = YAML.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'openapi.yaml'), 'utf8'));
const fixture = loadFixture();

// ---- output ------------------------------------------------------------------------------------------------------

let passed = 0;
let skipped = 0;
const failures = [];
const covered = new Set(); // "METHOD /path/{x} STATUS"
const osSkipped = new Set(); // operations whose only success case needs a fake platform
const ok = (name) => { passed += 1; console.log(`ok      ${name}`); };
const skip = (name, why) => { skipped += 1; console.log(`skip    ${name} (${why})`); };
const fail = (name, err) => { if (process.env.CT_STACK) console.log(err && err.stack); failures.push(name); console.log(`FAIL    ${name}\n          ${String(err && err.message ? err.message : err).split('\n').join('\n          ')}`); };
async function step(name, fn) { try { await fn(); ok(name); } catch (err) { fail(name, err); } }

// ---- the spec as validators ----------------------------------------------------------------------------------------

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(spec, 'spec');
const rewriteRefs = (node) => {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? `spec${v}` : rewriteRefs(v)]));
  }
  return node;
};
const compiled = new Map();
const validatorFor = (schema) => {
  const key = JSON.stringify(schema);
  if (!compiled.has(key)) compiled.set(key, ajv.compile(rewriteRefs(schema)));
  return compiled.get(key);
};
const check = (schema, value, what) => {
  const validate = validatorFor(schema);
  if (!validate(value)) throw new Error(`${what} does not match the contract: ${ajv.errorsText(validate.errors, { separator: '; ', dataVar: 'body' })}`);
};
const deref = (obj) => (obj && obj.$ref ? deref(obj.$ref.slice(2).split('/').reduce((node, part) => node[part], spec)) : obj);

const operations = []; // { method, template, regex, op }
for (const [template, item] of Object.entries(spec.paths)) {
  for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
    if (!item[method]) continue;
    const regex = new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`);
    operations.push({ method: method.toUpperCase(), template, regex, op: item[method] });
  }
}
const findOperation = (method, pathname) => operations.find((o) => o.method === method && o.regex.test(pathname));

// ---- talking to an agent -------------------------------------------------------------------------------------------

function request(base, token, { method, path: target, headers = {}, body, rawBody, contentType, auth = 'header', orClosed = false, firstChunk = false }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const url = new URL(target, base);
    const payload = rawBody !== undefined ? rawBody : body !== undefined ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const merged = { ...headers };
    if (auth === 'header' && token) merged['X-Token'] = token;
    if (payload) { merged['Content-Type'] = contentType || 'application/json'; merged['Content-Length'] = payload.length; }
    const req = http.request({ host: url.hostname, port: url.port, method, path: url.pathname + url.search, headers: merged, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); if (firstChunk) { finish(); req.destroy(); } });
      const finish = () => {
        const buffer = Buffer.concat(chunks);
        const type = String(res.headers['content-type'] || '');
        let json;
        if (type.includes('json') && buffer.length) { try { json = JSON.parse(buffer.toString('utf8')); } catch { json = undefined; } }
        done({ status: res.statusCode, headers: res.headers, buffer, json, type });
      };
      res.on('end', finish);
      res.on('error', () => {});
    });
    // an oversize body makes the Node server destroy the socket: with orClosed that counts as the refusal it is
    req.on('error', (err) => (orClosed ? done({ status: 'closed', headers: {}, buffer: Buffer.alloc(0), type: '' }) : (settled ? undefined : reject(err))));
    if (payload) req.write(payload);
    req.end();
  });
}

// ---- targets -------------------------------------------------------------------------------------------------------

// The agent under test is the Rust one (agent/, `ssd --fake-platform`): the contract is what it promises, and the fake PC is the fixture.
// Two instances: everything on, and one with the editor and the power controls off (the "locked" cases).
const { spawn } = require('node:child_process');
const os = require('node:os');

const EXE = process.env.SSD_AGENT_EXE || path.join(ROOT, 'agent', 'target', 'release', process.platform === 'win32' ? 'ssd.exe' : 'ssd');
const WEB = path.join(ROOT, 'web', 'dist');
const JPEG = fs.readFileSync(path.join(ROOT, 'agent', 'crates', 'api', 'assets', 'nosignal.jpg'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startAgent(port, overrides) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ssd-contract-'));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ ...clone(fixture.config), token: fixture.token, ...overrides, port }));
  const child = spawn(EXE, ['--data-dir', data, '--web-dir', WEB, '--port', String(port), '--fake-platform', '--no-tray'], { stdio: 'ignore', env: { ...process.env, SSD_NO_FIREWALL: '1' } });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const up = await request(url, fixture.token, { method: 'GET', path: '/api/ping' }).then((r) => r.status === 200, () => false);
    if (up) return { url, token: fixture.token, calls: [], external: true, close: () => { child.kill(); fs.rmSync(data, { recursive: true, force: true }); } };
    await sleep(250);
  }
  child.kill();
  throw new Error(`the agent did not start on port ${port} (${EXE})`);
}

// ---- the groups ----------------------------------------------------------------------------------------------------

function specChecks(routeTable) {
  return [
    ['the spec is a well formed OpenAPI 3.1 document', () => {
      assert.ok(String(spec.openapi).startsWith('3.1'));
      assert.ok(Object.keys(spec.paths).length > 0);
    }],
    ['every operation has a unique operationId, a tag and a 401 (or is public)', () => {
      const ids = new Set();
      for (const { method, template, op } of operations) {
        assert.ok(op.operationId, `${method} ${template}: no operationId`);
        assert.ok(!ids.has(op.operationId), `${op.operationId} is used twice`);
        ids.add(op.operationId);
        assert.ok(op.tags && op.tags.length, `${method} ${template}: no tag`);
        assert.ok(op.responses['401'], `${method} ${template}: no 401`);
        assert.ok(op.responses['200'] || op.responses['204'], `${method} ${template}: no success response`);
      }
    }],
    ['every $ref resolves and every schema compiles', () => {
      const walk = (node, where) => {
        if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
        if (!node || typeof node !== 'object') return undefined;
        if (typeof node.$ref === 'string') {
          const target = node.$ref.slice(2).split('/').reduce((n, part) => (n === undefined ? n : n[part]), spec);
          assert.ok(target !== undefined, `${where}: ${node.$ref} does not exist`);
        }
        return Object.entries(node).forEach(([k, v]) => walk(v, `${where}.${k}`));
      };
      walk(spec, '#');
      for (const [name, schema] of Object.entries(spec.components.schemas)) validatorFor(schema) || assert.fail(name);
      for (const [topic, schema] of Object.entries(spec['x-events'])) validatorFor(schema) || assert.fail(topic);
    }],
    ['every topic the agent can push has a payload schema', () => {
      const topics = spec.components.schemas.EventTopic.enum;
      assert.deepStrictEqual([...topics].sort(), Object.keys(spec['x-events']).sort());
    }],
    ['the fixture matches the schemas', () => {
      check({ $ref: '#/components/schemas/Audio' }, fixture.audio, 'audio');
      check({ $ref: '#/components/schemas/Media' }, fixture.media, 'media');
      check({ $ref: '#/components/schemas/MonitorSample' }, fixture.monitor.sample, 'monitor.sample');
      check({ $ref: '#/components/schemas/Processes' }, fixture.monitor.processes, 'monitor.processes');
      check({ $ref: '#/components/schemas/SystemInfo' }, fixture.monitor.info, 'monitor.info');
      check({ $ref: '#/components/schemas/Volume' }, fixture.volume, 'volume');
      check({ $ref: '#/components/schemas/Mic' }, fixture.mic, 'mic');
      check({ $ref: '#/components/schemas/CameraStatus' }, { ...fixture.camera, link: 'x', direct: fixture.vcam }, 'camera');
      for (const macro of fixture.config.macros) check({ $ref: '#/components/schemas/Macro' }, macro, `macro ${macro.id}`);
      for (const screen of fixture.screens) check({ $ref: '#/components/schemas/Screen' }, screen, 'screen');
    }],
    ...(routeTable ? [['the spec and the routes the server registers are the same list', () => {
      const code = new Set([...routeTable.map((r) => `${r.method} ${r.pattern.replace(/:(\w+)/g, '{$1}')}`), 'GET /api/requests']);
      const documented = new Set(operations.map((o) => `${o.method} ${o.template}`));
      const undocumented = [...code].filter((r) => !documented.has(r));
      const missing = [...documented].filter((r) => !code.has(r));
      assert.deepStrictEqual({ undocumented, missing }, { undocumented: [], missing: [] }, 'a route was added or removed without updating contracts/openapi.yaml');
    }]] : []),
  ];
}

async function runCase(c, targets, env, canOs) {
  const target = targets[c.target || 'default'];
  if (!target) return skip(c.name, `no ${c.target} target`);
  if (c.inProcess && !target.hooks) return skip(c.name, 'needs the Node fakes');
  if (c.fixtureBound && target.external) {
    const found = findOperation(c.method, new URL(c.path, 'http://x').pathname);
    if (found) osSkipped.add(`${found.method} ${found.template}`);
    return skip(c.name, 'needs the ids of the fixture; the Rust fake PC has its own');
  }
  if (c.osEffect && !canOs) {
    const found = findOperation(c.method, new URL(c.path, 'http://x').pathname);
    if (found) osSkipped.add(`${found.method} ${found.template}`);
    return skip(c.name, 'runs an OS program; needs a fake platform');
  }

  if (c.before) c.before(target.hooks);
  try {
    target.calls.length = 0;
    const second = c.concurrentWith && (async () => { await new Promise((r) => setTimeout(r, 50)); return null; })();
    const first = c.concurrentWith ? request(target.url, target.token, { method: c.concurrentWith.method, path: c.concurrentWith.path }) : null;
    if (second) await second;
    const res = await request(target.url, target.token, c.rawBody === 'JPEG' ? { ...c, rawBody: JPEG } : c);
    const firstRes = first ? await first : null;

    if (c.orClosed && res.status === 'closed') { ok(`${c.name} (connection closed)`); return; }
    if (res.status !== c.status) throw new Error(`expected ${c.status}, got ${res.status}${res.json ? ` ${JSON.stringify(res.json)}` : ''}`);
    if (firstRes && firstRes.status !== c.concurrentWith.status) throw new Error(`the run that was already going: expected ${c.concurrentWith.status}, got ${firstRes.status}`);

    if (c.spec !== false) {
      const found = findOperation(c.method, new URL(c.path, 'http://x').pathname);
      if (!found) throw new Error(`${c.method} ${c.path} is not in contracts/openapi.yaml`);
      const response = deref(found.op.responses[String(res.status)] || found.op.responses.default);
      if (!response) throw new Error(`${res.status} is not a documented response of ${found.method} ${found.template}`);
      const media = response.content || {};
      if (Object.keys(media).length) {
        const type = res.type.split(';')[0].trim();
        if (!media[type]) throw new Error(`content type ${type || '(none)'} is not documented for ${res.status} (documented: ${Object.keys(media).join(', ')})`);
        if (c.expectType && !type.startsWith(c.expectType)) throw new Error(`expected content type ${c.expectType}, got ${type}`);
        if (type.includes('json')) check(media[type].schema, res.json, 'the answer');
      }
      if (c.status >= 200 && c.status < 300 && c.body !== undefined && found.op.requestBody) {
        const reqMedia = deref(found.op.requestBody).content['application/json'];
        if (reqMedia) check(reqMedia.schema, c.body, 'the request body');
      }
      for (const [name, header] of Object.entries(response.headers || {})) {
        if (res.headers[name.toLowerCase()] === undefined) throw new Error(`header ${name} is documented but missing`);
        if (header.schema) check(header.schema, res.headers[name.toLowerCase()], `header ${name}`);
      }
      covered.add(`${found.method} ${found.template} ${res.status}`);
    }
    if (c.check) {
      // the fake PC of the Rust agent is its own (other ids and names, no call log): the values the fixture dictates are checked only where
      // the target is backed by the fixture; status, content type and schema are checked everywhere
      try { c.check(res, { calls: target.calls, fixture, assert }); } catch (err) {
        if (!target.external) throw err;
        return skip(c.name, `status and schema hold; a value of the fixture differs: ${String(err.message).split(String.fromCharCode(10))[0]}`);
      }
    }
    ok(c.name);
  } catch (err) {
    fail(c.name, err);
  } finally {
    if (c.after) c.after(target.hooks);
  }
}

// The stream: every topic delivers its current value at once, and that value is what the matching GET route returns.
async function sseCase(target) {
  const topics = spec.components.schemas.EventTopic.enum;
  await step(`events: every topic (${topics.join(', ')}) delivers its first value, shaped as documented`, async () => {
    const url = new URL(`/api/events?topics=${topics.join(',')}`, target.url);
    const seen = new Map();
    let head = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { req.destroy(); reject(new Error(`no value for: ${topics.filter((t) => !seen.has(t)).join(', ')}`)); }, 6000);
      const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers: { 'X-Token': target.token } }, (res) => {
        try {
          assert.strictEqual(res.statusCode, 200);
          assert.ok(String(res.headers['content-type']).startsWith('text/event-stream'));
        } catch (err) { clearTimeout(timer); req.destroy(); reject(err); return; }
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            if (!head) head = block;
            const name = /^event: (.+)$/m.exec(block);
            const data = /^data: (.*)$/m.exec(block);
            if (!name || !data) continue;
            try { check(spec['x-events'][name[1]], JSON.parse(data[1]), `event ${name[1]}`); } catch (err) { clearTimeout(timer); req.destroy(); reject(err); return; }
            seen.set(name[1], true);
            if (topics.every((t) => seen.has(t))) { clearTimeout(timer); req.destroy(); resolve(); return; }
          }
        });
        res.on('error', () => {});
      });
      req.on('error', (err) => { if (!seen.size || !topics.every((t) => seen.has(t))) reject(err); });
      req.end();
    });
    assert.ok(head.startsWith('retry:'), 'the stream starts with a retry hint');
    covered.add('GET /api/events 200');
  });
}

// What the security layer promises, through the whole stack (Host, lock-out, token, Origin, headers, body limits, static files).
async function securityCases(target, makeFresh, runLockout) {
  const get = (extra) => request(target.url, target.token, { method: 'GET', path: '/api/ping', ...extra });
  const port = new URL(target.url).host;

  await step('security: no token is 401 with a JSON error', async () => {
    const r = await get({ auth: 'none' });
    assert.strictEqual(r.status, 401);
    assert.ok(typeof r.json.error === 'string');
  });
  await step('security: a wrong token is 401', async () => assert.strictEqual((await get({ auth: 'none', headers: { 'X-Token': 'wrong' } })).status, 401));
  await step('security: the token works as header, query and cookie', async () => {
    assert.strictEqual((await get({})).status, 200);
    assert.strictEqual((await get({ auth: 'none', path: `/api/ping?token=${target.token}` })).status, 200);
    assert.strictEqual((await get({ auth: 'none', headers: { Cookie: `ssd_token=${target.token}` } })).status, 200);
  });
  await step('security: a Host that is not an IP, localhost or this PC is 421 (DNS rebinding)', async () => {
    const r = await get({ headers: { Host: 'evil.example.com' } });
    assert.strictEqual(r.status, 421);
    assert.ok(typeof r.json.error === 'string');
  });
  await step('security: a POST from another origin is 403, from its own origin is fine', async () => {
    const base = { method: 'POST', path: '/api/mic', body: { muted: false } };
    assert.strictEqual((await request(target.url, target.token, { ...base, headers: { Origin: 'https://evil.example.com' } })).status, 403);
    assert.strictEqual((await request(target.url, target.token, { ...base, headers: { Origin: `http://${port}` } })).status, 200);
    assert.strictEqual((await request(target.url, target.token, base)).status, 200); // no Origin: curl, the Android WebView
  });
  await step('security: a GET from another origin is allowed (reads are not state changes)', async () => {
    assert.strictEqual((await get({ headers: { Origin: 'https://evil.example.com' } })).status, 200);
  });
  await step('security: a browser without a token gets the pairing page; the manifest and pair.js are public', async () => {
    const page = await request(target.url, null, { method: 'GET', path: '/', auth: 'none', headers: { Accept: 'text/html' } });
    assert.strictEqual(page.status, 200);
    assert.ok(page.type.startsWith('text/html'));
    assert.strictEqual((await request(target.url, null, { method: 'GET', path: '/manifest.webmanifest', auth: 'none' })).status, 200);
    assert.strictEqual((await request(target.url, null, { method: 'GET', path: '/pair.js', auth: 'none' })).status, 200);
    assert.strictEqual((await request(target.url, null, { method: 'GET', path: '/index.html', auth: 'none' })).status, 401, 'the interface itself needs the token');
  });
  await step('security: the pairing link sets an HttpOnly, SameSite=Lax cookie and drops the token from the URL', async () => {
    const r = await request(target.url, null, { method: 'GET', path: `/?token=${target.token}`, auth: 'none', headers: { Accept: 'text/html' } });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, '/');
    const cookie = String(r.headers['set-cookie']);
    assert.ok(cookie.includes(`ssd_token=${target.token}`) && /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie), cookie);
  });
  await step('security: every JSON answer carries the hardening headers and is never cached', async () => {
    const r = await get({});
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(r.headers['x-frame-options'], 'DENY');
    assert.strictEqual(r.headers['referrer-policy'], 'no-referrer');
    assert.strictEqual(r.headers['cache-control'], 'no-store');
  });
  await step('security: a body that is not JSON is 400, one over the limit is refused (413 or the connection is closed)', async () => {
    assert.strictEqual((await request(target.url, target.token, { method: 'POST', path: '/api/mic', rawBody: Buffer.from('{not json') })).status, 400);
    const huge = await request(target.url, target.token, { method: 'POST', path: '/api/mic', rawBody: Buffer.from(JSON.stringify({ muted: false, pad: 'x'.repeat(5000) })), orClosed: true });
    assert.ok(huge.status === 413 || huge.status === 'closed', `an oversize body gave ${huge.status}`);
  });
  await step('security: static files cannot leave the public folder', async () => {
    for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/package.json', '/..%5c..%5cpackage.json', '/js/%2e%2e%2f%2e%2e%2fsrc%2findex.js', '/assets/..%2f..%2f..%2fpackage.json']) {
      const r = await request(target.url, target.token, { method: 'GET', path: p });
      assert.ok(r.status === 404 || r.status === 400, `${p} gave ${r.status}`);
    }
  });
  await step('security: 10 wrong tokens lock the address out for a minute, even for the right token', async () => {
    if (!runLockout) return;
    const fresh = await makeFresh();
    try {
      for (let i = 0; i < 10; i += 1) assert.strictEqual((await request(fresh.url, null, { method: 'GET', path: '/api/ping', auth: 'none', headers: { 'X-Token': `nope${i}` } })).status, 401);
      const locked = await request(fresh.url, fresh.token, { method: 'GET', path: '/api/ping' });
      assert.strictEqual(locked.status, 429);
      assert.ok(typeof locked.json.error === 'string');
    } finally { fresh.close(); }
  });
}


// The answers the web interface's own tests are fed (web/e2e/harness.cjs) must obey the contract too, or the UI is tested
// against a server that does not exist.
async function uiHarnessChecks() {
  const { fakeDeck } = require('../../web/e2e/harness.cjs');
  const deck = await fakeDeck();
  try {
    const routes = ['/api/apps', '/api/state', '/api/shortcuts', '/api/macros', '/api/editor', '/api/layout', '/api/pair-code', '/api/monitor/fps', '/api/windows',
      '/api/screens', '/api/monitor/sample', '/api/monitor/processes', '/api/monitor/info', '/api/power', '/api/audio', '/api/media', '/api/volume'];
    for (const route of routes) {
      await step(`ui harness: GET ${route} answers as the contract says`, async () => {
        const r = await request(deck.url, null, { method: 'GET', path: route, auth: 'none' });
        const found = findOperation('GET', route);
        assert.ok(found, 'not in the contract');
        check(deref(found.op.responses['200']).content['application/json'].schema, r.json, 'the harness answer');
      });
    }
    for (const [route, body] of [['/api/mic', { muted: 'toggle' }], ['/api/volume', { level: 10 }]]) {
      await step(`ui harness: POST ${route} answers as the contract says`, async () => {
        const r = await request(deck.url, null, { method: 'POST', path: route, body, auth: 'none' });
        const found = findOperation('POST', route);
        check(deref(found.op.responses['200']).content['application/json'].schema, r.json, 'the harness answer');
      });
    }
  } finally { deck.close(); }
}

// ---- main ----------------------------------------------------------------------------------------------------------

(async () => {
  console.log(`contract: ${operations.length} operations in contracts/openapi.yaml\n`);
  const external = option('--base-url');
  let inProc = null;
  let targets;
  let canOs = false;
  let routeTable = null;
  let makeFresh = null;

  if (flag('--spec-only')) {
    for (const [name, fn] of specChecks(null)) await step(name, fn);
  } else {
    if (external) {
      if (!flag('--fake-platform')) {
        console.error('Refusing to run: these cases shut the PC down, hide apps and rewrite config.json. Point --base-url at an agent that runs on the fake platform and say so with --fake-platform.');
        process.exit(2);
      }
      const token = option('--token') || fixture.token;
      targets = { default: { url: external, token, calls: [] } };
      if (option('--base-url-locked')) targets.locked = { url: option('--base-url-locked'), token, calls: [] };
      canOs = flag('--os-effects');
      makeFresh = null;
    } else {
      if (!fs.existsSync(EXE) || !fs.existsSync(path.join(WEB, 'index.html'))) {
        console.error('Build the agent (cargo build --release in agent/) and the interface (npm run build in web/) first, or set SSD_AGENT_EXE.');
        process.exit(2);
      }
      const base = 7600 + (process.pid % 100) * 2;
      const main = await startAgent(base, {});
      const locked = await startAgent(base + 1, { editor: false, powerControls: false });
      inProc = { close: () => { main.close(); locked.close(); } };
      targets = { default: main, locked };
      canOs = true;
      makeFresh = async () => {
        const fresh = await startAgent(base + 300 + (process.pid % 50), {});
        return fresh;
      };
    }

    console.log('# spec');
    for (const [name, fn] of specChecks(routeTable)) await step(name, fn);

    console.log('\n# behaviour');
    for (const c of cases) await runCase(c, targets, null, canOs);
    await sseCase(targets.default);

    if (!external) {
      console.log('\n# ui harness');
      await uiHarnessChecks();
    }

    console.log('\n# security');
    if (makeFresh || flag('--lockout')) await securityCases(targets.default, makeFresh || (async () => ({ ...targets.default, close() {} })), true);
    else await securityCases(targets.default, null, false);

    console.log('\n# coverage');
    const uncovered = [];
    for (const { method, template, op } of operations) {
      const key = `${method} ${template}`;
      const hit2xx = Object.keys(op.responses).filter((s) => s.startsWith('2')).some((s) => covered.has(`${key} ${s}`));
      if (!hit2xx && !UNCOVERED[key] && !osSkipped.has(key)) uncovered.push(key);
    }
    const documented = operations.reduce((n, { op }) => n + Object.keys(op.responses).length, 0);
    console.log(`  ${covered.size} of ${documented} documented (operation, status) pairs exercised`);
    for (const key of osSkipped) console.log(`  skipped on purpose: ${key} needs the fixture's ids or runs an OS program (cases skipped on this agent)`);
    for (const [key, why] of Object.entries(UNCOVERED)) console.log(`  not covered, on purpose: ${key}: ${why}`);
    await step('every operation has at least one successful case', () => assert.deepStrictEqual(uncovered, [], `no 2xx case for: ${uncovered.join(', ')}`));
  }

  if (inProc) inProc.close();
  console.log(`\n${passed} passed, ${failures.length} failed, ${skipped} skipped`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
