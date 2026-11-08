'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { DATA_DIR } = require('./config');
const { homeAddresses } = require('./addresses');
const { log } = require('./log');

/**
 * The certificates for an iPhone. Safari checks the names inside the certificate (the Android app pins a fingerprint instead, see
 * tls.js), so this one lists the PC's name and its current IP addresses, and it is signed by a small authority of its own.
 * The authority (ca.cer) is installed on the iPhone once and never changes; the server certificate (leaf) is made again by
 * PowerShell whenever the addresses change or it is close to expiring, without touching the iPhone. Everything is in data/tls/ios/.
 */

const DIR = path.join(DATA_DIR, 'tls', 'ios');
const FILES = ['ca.pfx', 'ca.cer', 'leaf.pfx', 'leaf.cer', 'secret.txt'].reduce((all, name) => ({ ...all, [name]: path.join(DIR, name) }), {});
const SCRIPT = path.join(__dirname, '..', 'scripts', 'tls-ios.ps1');
const RENEW_BEFORE_MS = 30 * 24 * 3600 * 1000;

const sha256 = (der) => crypto.createHash('sha256').update(der).digest('hex');

/** Names and addresses the server certificate must cover right now. */
function wanted() {
  const host = os.hostname().toLowerCase();
  return { names: [host, `${host}.local`, 'localhost'], ips: homeAddresses() };
}

/** What a certificate's subjectAltName covers, as the same two lists. */
function covered(x509) {
  const names = [];
  const ips = [];
  for (const entry of String(x509.subjectAltName || '').split(',')) {
    const [kind, ...rest] = entry.trim().split(':');
    const value = rest.join(':').trim();
    if (kind === 'DNS') names.push(value.toLowerCase());
    else if (kind === 'IP Address') ips.push(value);
  }
  return { names, ips };
}

const hasAll = (have, need) => need.every((item) => have.includes(item));

function read() {
  const leafDer = fs.readFileSync(FILES['leaf.cer']);
  const caDer = fs.readFileSync(FILES['ca.cer']);
  const leaf = new crypto.X509Certificate(leafDer);
  return {
    pfx: fs.readFileSync(FILES['leaf.pfx']),
    passphrase: fs.readFileSync(FILES['secret.txt'], 'utf8').trim(),
    caDer,
    caFingerprint: sha256(caDer),
    expires: new Date(leaf.validTo),
    covered: covered(leaf),
  };
}

const run = (args) => new Promise((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], { windowsHide: true, timeout: 90000 }, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr || stdout || error.message).trim()));
    else resolve();
  });
});

/** True when the files on disk are complete and still right for the current names and addresses. */
function isCurrent(need) {
  if (!Object.values(FILES).every((file) => fs.existsSync(file))) return false;
  try {
    const current = read();
    return current.expires.getTime() - Date.now() > RENEW_BEFORE_MS && hasAll(current.covered.names, need.names) && hasAll(current.covered.ips, need.ips);
  } catch (err) {
    log.warn(`[tls-ios] the certificate could not be read (${err.message}): making a new one`);
    return false;
  }
}

let pending = null;

/**
 * The iPhone side's TLS material: { pfx, passphrase, caDer, caFingerprint, expires, covered }. Makes the authority the first time and
 * a new server certificate when the addresses changed (or it is about to expire). Calls made together share one run.
 */
function ensure() {
  const need = wanted();
  if (isCurrent(need)) return Promise.resolve(read());
  if (pending) return pending;

  pending = (async () => {
    fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(FILES['secret.txt'])) fs.writeFileSync(FILES['secret.txt'], crypto.randomBytes(18).toString('hex'));
    const secret = fs.readFileSync(FILES['secret.txt'], 'utf8').trim();
    const hadAuthority = fs.existsSync(FILES['ca.pfx']) && fs.existsSync(FILES['ca.cer']);
    await run(['-Dir', DIR, '-Password', secret, '-Names', need.names.join(','), '-Ips', need.ips.join(',')]);
    const made = read();
    console.log(`[tls-ios] ${hadAuthority ? 'new server certificate' : 'new certificate authority and server certificate'} for ${[...need.names, ...need.ips].join(', ')}`);
    return made;
  })().finally(() => { pending = null; });
  return pending;
}

module.exports = { ensure, wanted, covered, DIR };
