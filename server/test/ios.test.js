'use strict';

// The iPhone side: a certificate authority made once, a server certificate that Safari would accept (names and addresses in the
// SAN, signed by that authority, serverAuth, under a year), made again when the addresses change but never the authority, and the
// plain-HTTP port that hands out only the authority's public certificate.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const tlsLib = require('node:tls');
const crypto = require('node:crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssd-ios-'));
process.env.SSD_DATA_DIR = dir;

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };

const fakeNetwork = (address) => {
  os.networkInterfaces = () => ({ Ethernet: [{ family: 'IPv4', address, internal: false }] });
  for (const id of ['../src/addresses', '../src/tls-ios']) delete require.cache[require.resolve(id)];
  return require('../src/tls-ios');
};

(async () => {
  const realNetworkInterfaces = os.networkInterfaces;
  const host = os.hostname().toLowerCase();

  if (process.platform === 'win32') {
    let first;
    await test('the authority and a server certificate Safari would accept are made', async () => {
      first = await fakeNetwork('192.168.0.10').ensure();
      const leaf = new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'tls', 'ios', 'leaf.cer')));
      const ca = new crypto.X509Certificate(first.caDer);

      assert.ok(ca.ca, 'the authority is a CA');
      assert.ok(!leaf.ca, 'the server certificate is not');
      assert.ok(leaf.checkIssued(ca) && leaf.verify(ca.publicKey), 'signed by the authority');
      assert.deepStrictEqual(first.covered.names.sort(), [host, `${host}.local`, 'localhost'].sort());
      assert.deepStrictEqual(first.covered.ips, ['192.168.0.10']);
      assert.ok(new Date(leaf.validTo).getTime() - Date.now() < 400 * 24 * 3600 * 1000, 'under a year, as iOS prefers');
      assert.match(first.caFingerprint, /^[0-9a-f]{64}$/);
    });

    await test('a client that trusts only the authority connects, and the names and IP match', async () => {
      const server = https.createServer({ pfx: first.pfx, passphrase: first.passphrase, minVersion: 'TLSv1.2' }, (req, res) => res.end('ok'));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const certificate = await new Promise((resolve, reject) => {
        https.get({ host: '127.0.0.1', servername: 'localhost', port: server.address().port, ca: new crypto.X509Certificate(first.caDer).toString(), checkServerIdentity: () => undefined }, (res) => {
          resolve(res.socket.getPeerCertificate());
          res.resume();
        }).on('error', reject);
      });
      server.close();
      assert.strictEqual(tlsLib.checkServerIdentity('localhost', certificate), undefined);
      assert.strictEqual(tlsLib.checkServerIdentity(`${host}.local`, certificate), undefined);
      assert.strictEqual(tlsLib.checkServerIdentity('192.168.0.10', certificate), undefined);
      assert.ok(tlsLib.checkServerIdentity('192.168.0.99', certificate), 'another address is not covered');
    });

    await test('nothing is redone while the addresses stay the same', async () => {
      const leafFile = path.join(dir, 'tls', 'ios', 'leaf.pfx');
      const before = fs.statSync(leafFile).mtimeMs;
      const again = await fakeNetwork('192.168.0.10').ensure();
      assert.strictEqual(fs.statSync(leafFile).mtimeMs, before);
      assert.strictEqual(again.caFingerprint, first.caFingerprint);
    });

    await test('a new address makes a new server certificate under the SAME authority', async () => {
      const changed = await fakeNetwork('10.1.2.3').ensure();
      assert.deepStrictEqual(changed.covered.ips, ['10.1.2.3']);
      assert.strictEqual(changed.caFingerprint, first.caFingerprint, 'the iPhone keeps trusting it');
      const leaf = new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'tls', 'ios', 'leaf.cer')));
      assert.ok(leaf.verify(new crypto.X509Certificate(first.caDer).publicKey));
    });

    await test('nothing from the run stays in the user certificate stores (Node would trust the intermediate one)', async () => {
      const { execFileSync } = require('node:child_process');
      const left = execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-ChildItem Cert:\\CurrentUser\\My, Cert:\\CurrentUser\\CA | Where-Object { $_.Subject -like '*Self Stream Deck CA*' -or ($_.Issuer -like '*Self Stream Deck CA*') }).Count"], { windowsHide: true }).toString().trim();
      assert.strictEqual(left, '0');
    });
  }

  os.networkInterfaces = realNetworkInterfaces;

  await test('the plain-HTTP port gives out the public certificate and nothing else', async () => {
    const { createCaServer } = require('../src/ios');
    const material = { caDer: Buffer.from('fake-der'), caFingerprint: 'ab'.repeat(32) };
    const server = createCaServer(() => material);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const get = (pathname, method = 'GET') => new Promise((resolve, reject) => {
      http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
      }).on('error', reject).end();
    });

    const cer = await get('/ca.cer');
    assert.strictEqual(cer.status, 200);
    assert.strictEqual(cer.type, 'application/x-x509-ca-cert');
    assert.deepStrictEqual(cer.body, material.caDer);

    const landing = await get('/');
    assert.strictEqual(landing.status, 200);
    assert.ok(landing.body.toString().includes(material.caFingerprint));

    assert.strictEqual((await get('/api/apps')).status, 404);
    assert.strictEqual((await get('/leaf.pfx')).status, 404);
    assert.strictEqual((await get('/ca.pfx')).status, 404);
    assert.strictEqual((await get('/ca.cer', 'POST')).status, 405);
    server.close();
  });

  await test('the pairing links list the addresses and the .local name', () => {
    os.networkInterfaces = () => ({ Ethernet: [{ family: 'IPv4', address: '192.168.0.10', internal: false }] });
    for (const id of ['../src/addresses', '../src/ios']) delete require.cache[require.resolve(id)];
    const shown = require('../src/ios').links({ iosPort: 7880, iosCaPort: 7881, token: 'tok' });
    os.networkInterfaces = realNetworkInterfaces;
    assert.deepStrictEqual(shown.install, ['http://192.168.0.10:7881/', `http://${host}.local:7881/`]);
    assert.deepStrictEqual(shown.pair, ['https://192.168.0.10:7880/?token=tok', `https://${host}.local:7880/?token=tok`]);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((err) => { console.log(err); process.exit(1); });
