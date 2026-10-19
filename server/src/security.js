'use strict';

const os = require('node:os');
const crypto = require('node:crypto');

const COOKIE = 'ssd_token';
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key]) => key)
      .map(([key, ...value]) => {
        const raw = value.join('=');
        try {
          return [key, decodeURIComponent(raw)];
        } catch {
          return [key, '']; // a malformed cookie is just "no token", not a server error
        }
      }),
  );
}

function createGuard(config) {
  const failures = new Map(); // ip -> { count, since }

  const isLockedOut = (ip) => {
    const entry = failures.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.since > FAILURE_WINDOW_MS) {
      failures.delete(ip);
      return false;
    }
    return entry.count >= MAX_FAILURES;
  };

  const recordFailure = (ip) => {
    if (failures.size > 100) {
      // the table never grows without bound, whatever the network throws at it
      for (const [key, value] of failures) if (Date.now() - value.since > FAILURE_WINDOW_MS) failures.delete(key);
      if (failures.size > 100) failures.clear();
    }
    const entry = failures.get(ip);
    if (!entry || Date.now() - entry.since > FAILURE_WINDOW_MS) failures.set(ip, { count: 1, since: Date.now() });
    else entry.count += 1;
  };

  const machineName = os.hostname().toLowerCase();

  // DNS rebinding makes a hostile web page reach us under *its own* domain name. Real clients use an IP or
  // this machine's name, so any other Host header is refused.
  const isAllowedHost = (hostHeader = '') => {
    const host = hostHeader.toLowerCase().replace(/:\d+$/, '');
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost' || host === '[::1]' || host === machineName;
  };

  // Browsers attach Origin to cross-site requests; a page on another site must not drive the deck.
  const isSameOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true; // not a browser cross-site request (e.g. curl, the Android WebView navigation)
    try {
      return new URL(origin).host.toLowerCase() === String(req.headers.host).toLowerCase();
    } catch {
      return false;
    }
  };

  const isAuthenticated = (req, url) => {
    const candidates = [url.searchParams.get('token'), req.headers['x-token'], parseCookies(req.headers.cookie)[COOKIE]];
    return candidates.some((candidate) => candidate && safeEqual(candidate, config.token));
  };

  const pairingCookie = () => `${COOKIE}=${config.token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;

  return { isLockedOut, recordFailure, isAllowedHost, isSameOrigin, isAuthenticated, pairingCookie };
}

module.exports = { createGuard };
