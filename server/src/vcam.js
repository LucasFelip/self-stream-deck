'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { DATA_DIR } = require('./config');

/**
 * The direct virtual camera: a "Stream Deck Camera" device that every Windows app lists next to real webcams, with no
 * OBS in between. It is the open-source UnityCapture DirectShow filter (zlib-style license, github.com/schellingb/UnityCapture),
 * installed on demand: the DLL is downloaded from a pinned commit, checked against a pinned SHA-256 and registered with
 * regsvr32 (that needs administrator rights, which the autostart task has). Frames reach it through scripts/vcam-host.ps1.
 */

const NAME = 'Stream Deck Camera';
const DLL_URL = 'https://raw.githubusercontent.com/schellingb/UnityCapture/3ed54c325e0ad71afcf4f246c07e5e17b3d7f2d2/Install/UnityCaptureFilter64.dll';
const DLL_SHA256 = '72812f5363d8ecb45632253f8c8c888844b1b62e27616f3c8cc21064ccde25e5';
const DLL_SIZE = 157696;
const CLSID = '{5C2CD55C-92AD-4999-8666-912BD3E70010}';
const DIR = path.join(DATA_DIR, 'vcam');
const DLL = path.join(DIR, 'UnityCaptureFilter64.dll');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'vcam-host.ps1');
const IDLE_STOP_MS = 5000;

let installedCache = { at: 0, value: false };
let child = null;
let childReady = false; // some app has the camera open and takes the frames
let lastFeed = 0;
let idleTimer = null;
let busy = false;

const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout), stderr: String(stderr) }));
});

/** Is the filter registered, and pointing at our DLL? */
async function isInstalled(force = false) {
  if (!force && Date.now() - installedCache.at < 5000) return installedCache.value;
  const { error, stdout } = await run('reg.exe', ['query', `HKLM\\SOFTWARE\\Classes\\CLSID\\${CLSID}\\InprocServer32`, '/ve']);
  const value = !error && stdout.toLowerCase().includes(DLL.toLowerCase()) && fs.existsSync(DLL);
  installedCache = { at: Date.now(), value };
  return value;
}

function download(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(res.headers.location, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed (HTTP ${res.statusCode})`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) { res.destroy(new Error('download too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject).on('timeout', function onTimeout() { this.destroy(new Error('download timed out')); });
  });
}

const fail = (message, status = 500) => Object.assign(new Error(message), { status });

async function install() {
  if (busy) throw fail('another install is running', 409);
  busy = true;
  try {
    const bytes = await download(DLL_URL);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== DLL_SIZE || sha !== DLL_SHA256) throw fail('the downloaded file is not the expected one: not installed');

    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(DLL, bytes);
    const { error, stdout, stderr } = await run('regsvr32.exe', ['/s', `/i:UnityCaptureName=${NAME}`, DLL]);
    installedCache.at = 0;
    if (error || !(await isInstalled(true))) {
      throw fail(`registration failed${error ? ` (code ${error.code})` : ''}: the server needs administrator rights to register a camera. ${stderr || stdout}`.trim());
    }
    console.log(`[vcam] installed "${NAME}"`);
  } finally {
    busy = false;
  }
}

async function uninstall() {
  stopHelper();
  if (fs.existsSync(DLL)) await run('regsvr32.exe', ['/s', '/u', DLL]);
  installedCache.at = 0;
  if (await isInstalled(true)) throw fail('could not unregister the camera (administrator rights needed)');
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* a process may still hold the file: harmless, it is unregistered */ }
  console.log('[vcam] removed');
}

// --- feeding frames ------------------------------------------------------------------------------

function startHelper() {
  if (child) return;
  child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const current = child;
  let buffered = '';
  current.stdout.on('data', (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, at).trim();
      buffered = buffered.slice(at + 1);
      try { childReady = Boolean(JSON.parse(line).ready); } catch { /* not a status line */ }
    }
  });
  current.stdin.on('error', () => {}); // the helper exiting must not crash the server
  current.on('exit', () => {
    if (child === current) { child = null; childReady = false; }
  });
  idleTimer = setInterval(() => {
    if (Date.now() - lastFeed > IDLE_STOP_MS) stopHelper();
  }, 1000);
  idleTimer.unref();
}

function stopHelper() {
  clearInterval(idleTimer);
  idleTimer = null;
  if (!child) return;
  try { child.stdin.end(Buffer.alloc(4)); } catch { /* already gone */ }
  const old = child;
  child = null;
  childReady = false;
  setTimeout(() => old.kill(), 1500).unref();
}

/** Hands a JPEG to the device, if it is installed. Cheap when it is not; drops the frame when the helper is busy. */
function feed(jpeg) {
  if (!installedCache.value) {
    if (Date.now() - installedCache.at > 5000) isInstalled(); // refresh in the background, the next frame sees it
    return;
  }
  lastFeed = Date.now();
  startHelper();
  if (!child || child.stdin.writableNeedDrain || !child.stdin.writable) return;
  const header = Buffer.alloc(4);
  header.writeInt32LE(jpeg.length);
  child.stdin.write(Buffer.concat([header, jpeg]));
}

async function status() {
  return { name: NAME, installed: await isInstalled(), inUse: childReady, busy };
}

const stop = () => stopHelper();

module.exports = { NAME, status, install, uninstall, feed, stop, DLL_SHA256 };
