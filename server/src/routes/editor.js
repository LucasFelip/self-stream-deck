'use strict';

// The button editor and the layout (where each key sits). Everything saved is validated against a whitelist (src/macros.js).
// The editor can be turned off with "editor": false.

const macros = require('../macros');
const { sendJson, readJson } = require('../http');
const { badRequest } = require('../validate');
const { log } = require('../log');

const TILE_KEY = /^[asmc]:[A-Za-z0-9-]{1,48}$/;

module.exports = function editorRoutes(ctx, on) {
  const { config, system, update } = ctx;
  const shortcutList = () => ctx.shortcuts().map(({ id, label, keys: spec, display }) => ({ id, label, keys: spec, display }));

  on('GET', '/api/editor', async ({ res }) => {
    ctx.editorOn();
    const hidden = new Set(config.hidden || []);
    const [devices, monitors] = await Promise.all([system.devices().catch(() => ({ playback: [], capture: [] })), system.monitors(false).catch(() => [])]);
    sendJson(res, 200, {
      shortcuts: shortcutList(),
      macros: ctx.macroList(),
      apps: ctx.allApps().map(({ id, name, hasIcon, iconVersion, proc }) => ({ id, name, hasIcon, iconVersion, hidden: hidden.has(id), canPlace: Boolean(proc) })),
      devices: { playback: devices.playback.map(({ id, name }) => ({ id, name })), capture: devices.capture.map(({ id, name }) => ({ id, name })) },
      screens: monitors.length || 1,
    });
  });

  on('POST', '/api/editor/shortcuts', async ({ req, res }) => {
    ctx.editorOn();
    const { items } = await readJson(req, 64 * 1024);
    update(config, { shortcuts: macros.normalizeShortcuts(items) });
    ctx.loadShortcuts();
    log.info(`[editor] ${config.shortcuts.length} shortcuts saved`);
    sendJson(res, 200, { shortcuts: shortcutList() });
  });

  on('POST', '/api/editor/macros', async ({ req, res }) => {
    ctx.editorOn();
    const { items } = await readJson(req, 128 * 1024);
    update(config, { macros: macros.normalizeMacros(items, new Set(ctx.allApps().map((app) => app.id))) });
    log.info(`[editor] ${config.macros.length} macros saved`);
    sendJson(res, 200, { macros: ctx.macroList() });
  });

  on('POST', '/api/editor/apps', async ({ req, res }) => {
    ctx.editorOn();
    const { hidden } = await readJson(req, 64 * 1024);
    const known = new Set(ctx.allApps().map((app) => app.id));
    if (!Array.isArray(hidden) || hidden.length > 200 || hidden.some((id) => typeof id !== 'string' || !known.has(id))) throw badRequest('invalid hidden');
    update(config, { hidden: [...new Set(hidden)] });
    ctx.applyAppConfig();
    log.info(`[editor] apps: ${config.hidden.length} hidden`);
    sendJson(res, 200, { ok: true });
  });

  // Where each key sits on the Apps and Shortcuts pages. Holding and dragging a key on the deck saves it here.
  const tileOrder = () => ({ apps: [], shortcuts: [], ...(config.tileOrder || {}) });
  on('GET', '/api/layout', async ({ res }) => sendJson(res, 200, tileOrder()));
  on('POST', '/api/layout', async ({ req, res }) => {
    ctx.editorOn();
    const { page, order } = await readJson(req, 64 * 1024);
    if (page !== 'apps' && page !== 'shortcuts') throw badRequest('invalid page');
    if (!Array.isArray(order) || order.length > 200 || order.some((key) => typeof key !== 'string' || !TILE_KEY.test(key))) throw badRequest('invalid order');
    update(config, { tileOrder: { ...tileOrder(), [page]: [...new Set(order)] } });
    sendJson(res, 200, tileOrder());
  });
};
