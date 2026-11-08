'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { DATA_DIR } = require('./config');
const { log } = require('./log');

/**
 * The certificate for the Wi-Fi (HTTPS) side. It is created once with PowerShell and kept in data/tls/: a PFX for the server
 * and its SHA-256 fingerprint, which the phone app pins. Nothing about the network (IPs, names) goes into it, so it stays
 * valid when the PC's address changes; it is replaced only when missing or close to expiring.
 */

const DIR = path.join(DATA_DIR, 'tls');
const PFX = path.join(DIR, 'server.pfx');
const CER = path.join(DIR, 'server.cer');
const SECRET = path.join(DIR, 'secret.txt');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'tls-cert.ps1');
const RENEW_BEFORE_MS = 30 * 24 * 3600 * 1000;

const run = (script, args) => new Promise((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr || stdout || error.message).trim()));
    else resolve();
  });
});

function fingerprintOf(der) {
  return crypto.createHash('sha256').update(der).digest('hex');
}

function read() {
  const der = fs.readFileSync(CER);
  const x509 = new crypto.X509Certificate(der);
  return {
    pfx: fs.readFileSync(PFX),
    passphrase: fs.readFileSync(SECRET, 'utf8').trim(),
    fingerprint: fingerprintOf(der),
    expires: new Date(x509.validTo),
  };
}

/** The server's TLS options and the certificate's fingerprint; creates the certificate when there is none. */
async function ensure() {
  if ([PFX, CER, SECRET].every((file) => fs.existsSync(file))) {
    try {
      const current = read();
      if (current.expires.getTime() - Date.now() > RENEW_BEFORE_MS) return current;
    } catch (err) {
      // a new certificate has a new fingerprint: phones paired over Wi-Fi must be paired again, so this is worth saying
      log.warn(`[tls] the certificate could not be read (${err.message}): making a new one`);
    }
  }

  fs.mkdirSync(DIR, { recursive: true });
  const secret = crypto.randomBytes(18).toString('hex');
  fs.writeFileSync(SECRET, secret);
  await run(SCRIPT, ['-PfxPath', PFX, '-CerPath', CER, '-Password', secret]);
  const made = read();
  console.log(`[tls] new certificate, fingerprint ${made.fingerprint}`);
  return made;
}

module.exports = { ensure, fingerprintOf };
