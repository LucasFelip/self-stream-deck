'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vcam = require('./vcam');

/**
 * The phone's camera, as a webcam for the PC. The deck page on the phone sends JPEG frames (POST /api/camera/frame)
 * and this module hands the newest one to whoever watches the MJPEG stream (GET /api/camera/stream). OBS shows that
 * stream in a Browser Source and publishes it as its Virtual Camera, which is what Discord, Meet or Zoom then pick.
 * Nothing is stored: only the latest frame is kept, in memory.
 */

const BOUNDARY = 'ssdframe';
const MAX_FRAME = 1.5 * 1024 * 1024;
const LIVE_MS = 2000; // no frame for this long = the phone stopped sending
const NO_SIGNAL = fs.readFileSync(path.join(__dirname, '..', 'assets', 'nosignal.jpg'));

let latest = null; // { buffer, at }
let recent = []; // arrival time (ms) of the last frames, for the frame rate
let bytesRecent = []; // [time, size] pairs, for the data rate
const viewers = new Set();
let idleTimer = null;

function write(res, buffer) {
  if (res.writableNeedDrain) return; // a slow viewer drops frames instead of making the server buffer them
  res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`);
  res.write(buffer);
  res.write('\r\n');
}

const isLive = () => Boolean(latest) && Date.now() - latest.at < LIVE_MS;

function push(buffer) {
  if (buffer.length < 4 || buffer.length > MAX_FRAME || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw Object.assign(new Error('not a JPEG frame'), { status: 400 });
  }
  const now = Date.now();
  latest = { buffer, at: now };
  recent.push(now);
  bytesRecent.push([now, buffer.length]);
  const cutoff = now - 2000;
  while (recent.length && recent[0] < cutoff) recent.shift();
  while (bytesRecent.length && bytesRecent[0][0] < cutoff) bytesRecent.shift();
  for (const res of viewers) write(res, buffer);
  vcam.feed(buffer); // the direct virtual camera, when it is installed
}

// While somebody watches and the phone is silent, repeat a "no signal" picture so the stream never looks frozen.
function keepAlive() {
  if (idleTimer || !viewers.size) return;
  idleTimer = setInterval(() => {
    if (!viewers.size) {
      clearInterval(idleTimer);
      idleTimer = null;
      return;
    }
    if (!isLive()) for (const res of viewers) write(res, NO_SIGNAL);
  }, 1000);
  idleTimer.unref();
}

function attach(req, res) {
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });
  viewers.add(res);
  write(res, isLive() ? latest.buffer : NO_SIGNAL);
  keepAlive();
  req.on('close', () => viewers.delete(res));
}

// Does anybody use the picture right now? An OBS source watching the stream, or an app that has the direct virtual camera open.
// The phone sends full speed only then; otherwise it drops to one frame a second.
const wanted = () => viewers.size > 0 || vcam.inUse();

function status() {
  const now = Date.now();
  const span = recent.length > 1 ? (recent[recent.length - 1] - recent[0]) / 1000 : 0;
  const kb = bytesRecent.reduce((sum, [, size]) => sum + size, 0) / 1024;
  const live = isLive();
  return {
    live,
    fps: live && span > 0 ? Math.round((recent.length - 1) / span) : 0,
    kbps: live ? Math.round(kb / 2) : 0,
    viewers: viewers.size,
    wanted: wanted(),
    ageMs: latest ? now - latest.at : null,
  };
}

const stop = () => {
  for (const res of viewers) res.end();
  viewers.clear();
};

module.exports = { push, attach, status, wanted, stop, MAX_FRAME };
