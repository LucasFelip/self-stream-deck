'use strict';

// Wi-Fi side: which addresses count as "the home network", and that the certificate really is what the server presents.
const assert = require('node:assert');
const crypto = require('node:crypto');
const https = require('node:https');
const os = require('node:os');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };

(async () => {
  await test('only real home-network addresses are offered (no WSL/Docker/Tailscale/link-local)', () => {
    const original = os.networkInterfaces;
    const iface = (address, internal = false) => [{ family: 'IPv4', address, internal }];
    os.networkInterfaces = () => ({
      Ethernet: iface('192.168.4.19'),
      'Wi-Fi': iface('10.0.0.5'),
      'vEthernet (WSL)': iface('172.28.0.1'),
      'vEthernet (Default Switch)': iface('172.17.96.1'),
      Tailscale: iface('100.119.106.56'),
      'Ethernet 2': iface('169.254.10.2'),
      Loopback: iface('127.0.0.1', true),
      'Public': iface('203.0.113.9'),
    });
    delete require.cache[require.resolve('../src/addresses')];
    try {
      assert.deepStrictEqual(require('../src/addresses').homeAddresses(), ['192.168.4.19', '10.0.0.5']);
    } finally {
      os.networkInterfaces = original;
      delete require.cache[require.resolve('../src/addresses')];
    }
  });

  if (process.platform === 'win32') {
    await test('the certificate is served over HTTPS and its fingerprint is the one reported', async () => {
      const material = await require('../src/tls').ensure();
      assert.match(material.fingerprint, /^[0-9a-f]{64}$/);
      assert.ok(material.expires.getTime() > Date.now() + 29 * 24 * 3600 * 1000, 'valid for more than a month');

      const server = https.createServer({ pfx: material.pfx, passphrase: material.passphrase, minVersion: 'TLSv1.2' }, (req, res) => res.end('ok'));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const seen = await new Promise((resolve, reject) => {
        https.get({ host: '127.0.0.1', port: server.address().port, rejectUnauthorized: false }, (res) => {
          resolve(crypto.createHash('sha256').update(res.socket.getPeerCertificate().raw).digest('hex'));
          res.resume();
        }).on('error', reject);
      });
      server.close();
      assert.strictEqual(seen, material.fingerprint);
    });
  }

  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((err) => { console.log(err); process.exit(1); });
