'use strict';

const http = require('node:http');
const os = require('node:os');
const { load } = require('./config');
const { createGuard } = require('./security');
const { createRoutes } = require('./routes');
const { sendJson, serveStatic, isStaticPath } = require('./http');
const system = require('./system');
const media = require('./media');
const monitor = require('./monitor');
const camera = require('./camera');
const vcam = require('./vcam');

const config = load();
const guard = createGuard(config);
const routes = createRoutes(config);

// --- request handling -----------------------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const ip = req.socket.remoteAddress;

  if (!guard.isAllowedHost(req.headers.host)) return sendJson(res, 421, { error: 'unexpected host' });
  if (guard.isLockedOut(ip)) return sendJson(res, 429, { error: 'too many attempts, try again in a minute' });

  if (!guard.isAuthenticated(req, url)) {
    guard.recordFailure(ip);
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  if (req.method !== 'GET' && !guard.isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request refused' });

  if (req.method === 'GET' && isStaticPath(url.pathname)) {
    // Pairing link: /?token=... stores the token in a cookie and drops it from the URL.
    if (url.searchParams.has('token')) {
      res.writeHead(302, { Location: url.pathname, 'Set-Cookie': guard.pairingCookie() });
      return res.end();
    }
    return serveStatic(req, res, url.pathname);
  }

  if (await routes.dispatch({ req, res, url })) return undefined;
  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  });
});

// a client that is slow to send its request (or never finishes) must not hold a connection open
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 50;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use: is self-stream-deck already running? (set SSD_PORT or "port" in config.json to use another)`);
    process.exit(1);
  }
  throw err;
});

// --- startup --------------------------------------------------------------------------------------

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);
}

// Says why the server stopped: a silent exit is what made "the phone shows no connection" hard to explain.
function shutdown(signal) {
  console.log(`[server] stopping (${signal})`);
  system.stop();
  media.stop();
  monitor.stop();
  camera.stop();
  vcam.stop();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(signal, () => shutdown(signal));
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  // a rejected promise nobody awaited: log it and keep serving instead of taking the deck down
  console.error('[server] unhandled rejection:', reason);
});
process.on('exit', (code) => console.log(`[server] exit (code ${code})`));

// The keys/audio helper compiles native code: start it now so the first tap isn't slow. The media and
// monitor helpers are heavier and rarely used, so they start on demand and stop again when idle.
system.warmUp();

routes
  .refreshApps()
  .catch((err) => console.error(`Could not read the taskbar: ${err.message}`))
  .finally(() => {
    server.listen(config.port, config.lan ? '0.0.0.0' : '127.0.0.1', () => {
      console.log(`self-stream-deck: ${routes.appCount()} apps from the taskbar`);
      console.log(`\nOpen on this PC or over USB (adb reverse tcp:${config.port} tcp:${config.port}):`);
      console.log(`  http://127.0.0.1:${config.port}/?token=${config.token}`);
      if (config.lan) {
        console.log('\nOver the local network ("lan": true in config.json):');
        for (const ip of lanAddresses()) console.log(`  http://${ip}:${config.port}/?token=${config.token}`);
      } else {
        console.log('\nWi-Fi access is off. Set "lan": true in config.json to allow it.');
      }

      if (process.argv.includes('--phone') || config.autoOpenPhone) {
        console.log('');
        require('./phone').watch({ port: config.port, token: config.token });
      }
    });
  });
