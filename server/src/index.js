'use strict';

const http = require('node:http');
const https = require('node:https');
const { load } = require('./config');
const { createGuard } = require('./security');
const { createRoutes } = require('./routes');
const { sendJson, serveStatic, isStaticPath, isPublicAsset } = require('./http');
const system = require('./system');
const media = require('./media');
const notifications = require('./notifications');
const monitor = require('./monitor');
const camera = require('./camera');
const vcam = require('./vcam');
const events = require('./events');
const tls = require('./tls');
const tlsIos = require('./tls-ios');
const ios = require('./ios');
const firewall = require('./firewall');
const { homeAddresses } = require('./addresses');

const config = load();
const guard = createGuard(config);
const routes = createRoutes(config);

const requestCounts = { since: new Date().toISOString(), byRoute: new Map() };

// --- request handling -----------------------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const ip = req.socket.remoteAddress;

  if (!guard.isAllowedHost(req.headers.host)) return sendJson(res, 421, { error: 'unexpected host' });
  if (guard.isLockedOut(ip)) return sendJson(res, 429, { error: 'too many attempts, try again in a minute' });

  // the manifest, icons and the pairing page's script hold nothing private (see http.js)
  if (req.method === 'GET' && isPublicAsset(url.pathname)) return serveStatic(req, res, url.pathname);

  if (!guard.isAuthenticated(req, url)) {
    // A browser opening the deck without a (valid) token gets the pairing page instead of a bare 401: a Home Screen app on iPhone
    // keeps its cookies apart from Safari, so it has to be paired once. Only a wrong token counts as a failed attempt.
    if (req.method === 'GET' && url.pathname === '/' && String(req.headers.accept || '').includes('text/html')) {
      if (!url.searchParams.has('token')) return serveStatic(req, res, '/pair.html');
      guard.recordFailure(ip);
      res.writeHead(302, { Location: '/?error=1' });
      return res.end();
    }
    guard.recordFailure(ip);
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  if (req.method !== 'GET' && !guard.isSameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request refused' });

  // how often each route is used (static files count as one): GET /api/requests shows it, for judging what the phone costs
  if (url.pathname === '/api/requests' && req.method === 'GET') {
    return sendJson(res, 200, { since: requestCounts.since, counts: Object.fromEntries([...requestCounts.byRoute].sort((a, b) => b[1] - a[1])) });
  }
  const route = isStaticPath(url.pathname) ? 'static' : url.pathname.replace(/\/[0-9a-f]{8,}$/i, '/:id');
  const key = `${req.method} ${route}`;
  requestCounts.byRoute.set(key, (requestCounts.byRoute.get(key) || 0) + 1);

  if (req.method === 'GET' && isStaticPath(url.pathname)) {
    // Pairing link: /?token=... stores the token in a cookie and drops it from the URL.
    if (url.searchParams.has('token')) {
      res.writeHead(302, { Location: url.pathname, 'Set-Cookie': guard.pairingCookie(Boolean(req.socket.encrypted)) });
      return res.end();
    }
    return serveStatic(req, res, url.pathname);
  }

  if (await routes.dispatch({ req, res, url })) return undefined;
  return sendJson(res, 404, { error: 'not found' });
}

const onRequest = (req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  });
};

// a client that is slow to send its request (or never finishes) must not hold a connection open
function harden(instance) {
  instance.headersTimeout = 10_000;
  instance.requestTimeout = 15_000;
  instance.keepAliveTimeout = 5_000;
  instance.maxHeadersCount = 50;
  return instance;
}

// This one only listens on this PC (and the USB tunnel). Phones on the network use the HTTPS server below.
const server = harden(http.createServer(onRequest));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use: is self-stream-deck already running? (set SSD_PORT or "port" in config.json to use another)`);
    process.exit(1);
  }
  throw err;
});

// --- startup --------------------------------------------------------------------------------------

// Wi-Fi: an HTTPS server on the local network, with a self-signed certificate the phone app pins, and a firewall rule
// limited to this one port and the local subnet. Resolves to the pairing links (empty when Wi-Fi is off or failed).
async function startLan() {
  if (!config.lan) {
    console.log('\nWi-Fi access is off. Turn it on with: npm run lan -- on');
    return [];
  }
  try {
    const material = await tls.ensure();
    const secure = harden(https.createServer({ pfx: material.pfx, passphrase: material.passphrase, minVersion: 'TLSv1.2' }, onRequest));
    secure.on('clientError', () => {}); // a phone that does not trust the certificate yet just drops the connection
    await new Promise((resolve, reject) => {
      secure.once('error', reject);
      secure.listen(config.httpsPort, '0.0.0.0', resolve);
    });
    firewall.ensure(config.httpsPort);
    const links = homeAddresses().map((ip) => `https://${ip}:${config.httpsPort}/?token=${config.token}&fp=${material.fingerprint}`);
    console.log(`\nOver the home network (Wi-Fi, HTTPS on port ${config.httpsPort}):`);
    for (const link of links) console.log(`  ${link}`);
    if (!links.length) console.log('  (no home-network address found: is this PC connected?)');
    return links;
  } catch (err) {
    console.error(`[lan] could not start the Wi-Fi server: ${err.message}`);
    return [];
  }
}

// iPhone (Safari): HTTPS on iosPort with this PC's names and addresses in the certificate (Safari checks them; the authority that
// signed it is installed on the iPhone once), and a plain-HTTP port that only hands out that authority's PUBLIC certificate.
// The addresses are looked at again every few minutes: when they change the certificate is made again and swapped in live.
async function startIos() {
  if (!config.ios) return;
  try {
    let material = await tlsIos.ensure();
    const secure = harden(https.createServer({ pfx: material.pfx, passphrase: material.passphrase, minVersion: 'TLSv1.2' }, onRequest));
    secure.on('clientError', () => {});
    const caServer = ios.createCaServer(() => material);
    for (const [instance, port] of [[secure, config.iosPort], [caServer, config.iosCaPort]]) {
      await new Promise((resolve, reject) => {
        instance.once('error', reject);
        instance.listen(port, '0.0.0.0', resolve);
      });
    }
    firewall.ensure([config.iosPort, config.iosCaPort], firewall.RULE_IOS);

    setInterval(async () => {
      try {
        const next = await tlsIos.ensure();
        if (JSON.stringify(next.covered) === JSON.stringify(material.covered)) return;
        secure.setSecureContext({ pfx: next.pfx, passphrase: next.passphrase });
        material = next;
        console.log('[tls-ios] the PC addresses changed: new certificate in use');
      } catch (err) {
        console.error(`[tls-ios] could not refresh the certificate: ${err.message}`);
      }
    }, 5 * 60_000).unref();

    const shown = ios.links(config);
    console.log(`
For an iPhone (Safari):
  1. install the certificate once (fingerprint ${material.caFingerprint}):`);
    for (const link of shown.install) console.log(`       ${link}`);
    console.log('  2. open the deck:');
    for (const link of shown.pair) console.log(`       ${link}`);
  } catch (err) {
    console.error(`[ios] could not start the iPhone server: ${err.message}`);
  }
}

// Says why the server stopped: a silent exit is what made "the phone shows no connection" hard to explain.
function shutdown(signal) {
  console.log(`[server] stopping (${signal})`);
  system.stop();
  media.stop();
  notifications.stop();
  monitor.stop();
  camera.stop();
  vcam.stop();
  events.stopAll();
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
require('./native').ensure(); // builds the native helper on the very first run (about a second), then it is only looked up
system.warmUp();

// Listening comes first: the apps are known from the last run (disk cache) and are checked in the background, so a phone
// reconnecting after a restart is answered in milliseconds instead of waiting for the taskbar to be read again.
const startedAt = Date.now();
server.listen(config.port, '127.0.0.1', async () => {
  console.log(`self-stream-deck: listening after ${Date.now() - startedAt} ms, ${routes.appCount()} apps from the last run`);
  console.log(`\nOpen on this PC or over USB (adb reverse tcp:${config.port} tcp:${config.port}):`);
  console.log(`  http://127.0.0.1:${config.port}/?token=${config.token}`);

  routes
    .refreshApps()
    .then(() => console.log(`[apps] ${routes.appCount()} apps from the taskbar`))
    .catch((err) => console.error(`Could not read the taskbar: ${err.message}`));

  const links = await startLan();
  await startIos();

  if (process.argv.includes('--phone') || config.autoOpenPhone) {
    console.log('');
    require('./phone').watch({ port: config.port, token: config.token, wifi: links[0] || null });
  }
});
