'use strict';

// The request handler of the server, apart from sockets and startup (index.js): Host check, lockout, token, origin, static
// files, then the route table. Split out so the contract tests can run the whole stack (security included) with fake PC modules.

const { sendJson, serveStatic, isStaticPath, isPublicAsset } = require('./http');

function createApp({ config, guard, routes }) {
  const requestCounts = { since: new Date().toISOString(), byRoute: new Map() };

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

  return { onRequest, config };
}

module.exports = { createApp };
