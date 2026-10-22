'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { swallow } = require('./log');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Sent with every response: the page only ever loads its own files, cannot be framed, and nothing is sniffed or leaked.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

function sendBuffer(res, buffer, type, headers = {}) {
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': buffer.length, ...headers });
  res.end(buffer);
}

function sendFile(res, file, type, headers = {}) {
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    sendBuffer(res, data, type, { 'Cache-Control': 'no-cache', ...headers });
  });
}

/** Serves files from public/ only: no traversal outside it, and only known web file types. */
function serveStatic(req, res, pathname) {
  let relative;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^[/\\]+/, '');
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
  const file = path.resolve(PUBLIC_DIR, relative);
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type || !file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'not found' });

  // Revalidate instead of resending: an unchanged file costs a 304 with no body (less radio on the phone).
  return fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: 'not found' });
    const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ...SECURITY_HEADERS, ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    return sendFile(res, file, type, { ETag: etag });
  });
}

/** The raw request body, up to `limit` bytes (camera frames). */
function readBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// A number that changes whenever any file of the interface changes (the newest modification time). The page asks for it
// and reloads itself when it differs, so an updated interface appears without closing and reopening the app.
let versionCache = { at: 0, value: 0 };
function uiVersion() {
  if (Date.now() - versionCache.at < 1500) return versionCache.value;
  let newest = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  try {
    walk(PUBLIC_DIR);
  } catch (err) {
    swallow('[http] could not read public/ for the version', err); // keep the last known value if the folder is being rewritten
    return versionCache.value;
  }
  versionCache = { at: Date.now(), value: Math.round(newest) };
  return versionCache.value;
}

function isStaticPath(pathname) {
  return pathname === '/' || Boolean(TYPES[path.extname(pathname).toLowerCase()]);
}

module.exports = { sendJson, sendBuffer, sendFile, serveStatic, readJson, readBuffer, isStaticPath, uiVersion };
