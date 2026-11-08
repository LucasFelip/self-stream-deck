'use strict';

// Keyboard shortcuts (sent by id) and the global media keys.

const { sendJson } = require('../http');
const { notFound } = require('../validate');
const { log } = require('../log');

module.exports = function shortcutsRoutes(ctx, on) {
  const { system } = ctx;

  on('GET', '/api/shortcuts', async ({ res }) =>
    sendJson(res, 200, { shortcuts: ctx.shortcuts().map(({ id, label, display }) => ({ id, label, display })) }));

  on('POST', '/api/shortcut/:id', async ({ res, params }) => {
    const shortcut = ctx.shortcuts().find((candidate) => candidate.id === params.id);
    if (!shortcut) throw notFound('unknown shortcut');
    await system.pressKeys(shortcut.vks);
    log.info(`[shortcut] ${shortcut.label} (${shortcut.display})`);
    sendJson(res, 200, { ok: true, label: shortcut.label });
  });

  // global media keys (what the strip buttons send); the Media page talks to a specific player instead
  on('POST', '/api/mediakey/:key', async ({ res, params }) => {
    const vk = ctx.MEDIA_KEYS[params.key];
    if (!vk) throw notFound('unknown media key');
    await system.pressKeys([vk]);
    sendJson(res, 200, { ok: true });
  });
};
