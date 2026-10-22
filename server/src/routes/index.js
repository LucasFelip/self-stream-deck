'use strict';

// The route table: every module under routes/ adds its routes with on(method, pattern, handler), and dispatch finds the
// one that matches. `overrides` replaces the PC-facing modules (system, media, ...) so tests can run without Windows.

const { sendJson } = require('../http');
const { createContext } = require('./context');
const { log } = require('../log');

const MODULES = ['apps', 'shortcuts', 'macros', 'editor', 'audio', 'media', 'pc', 'windows', 'camera', 'events'];

function createRoutes(config, overrides = {}) {
  const ctx = createContext(config, overrides);

  const table = [];
  const on = (method, pattern, handler) => table.push({ method, pattern, handler });
  for (const name of MODULES) require(`./${name}`)(ctx, on); // events last: its producers use the builders the others define

  const compiled = table.map((entry) => {
    const names = [];
    const source = entry.pattern.replace(/:(\w+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
    return { ...entry, regex: new RegExp(`^${source}$`), names };
  });

  async function dispatch(request) {
    const { req, res, url } = request;
    for (const route of compiled) {
      if (route.method !== req.method) continue;
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
      try {
        await route.handler({ ...request, params });
      } catch (err) {
        if (res.headersSent) return true;
        if (!err.status) log.error(`[${req.method} ${url.pathname}]`, err.message);
        sendJson(res, err.status || 500, { error: err.message });
      }
      return true;
    }
    return false;
  }

  return { dispatch, refreshApps: ctx.refreshApps, appCount: () => ctx.apps().length };
}

module.exports = { createRoutes };
