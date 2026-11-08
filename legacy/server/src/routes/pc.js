'use strict';

// The PC itself: the system monitor and the power actions (shutdown, restart, sleep, ...).

const { sendJson, readJson } = require('../http');
const { badRequest, forbidden } = require('../validate');
const { log } = require('../log');

module.exports = function pcRoutes(ctx, on) {
  const { config, monitor, power } = ctx;

  on('GET', '/api/monitor/sample', async ({ res }) => sendJson(res, 200, await monitor.sample()));
  on('GET', '/api/monitor/fps', async ({ res }) => sendJson(res, 200, await monitor.fps())); // the game's frame rate, or null
  on('GET', '/api/monitor/processes', async ({ res }) => sendJson(res, 200, await monitor.processes()));
  on('GET', '/api/monitor/info', async ({ res }) => sendJson(res, 200, await monitor.info()));

  ctx.build.power = async () => {
    const appNames = new Map(ctx.apps().filter((app) => app.proc).map((app) => [app.proc, app.name]));
    return { enabled: config.powerControls !== false, ...(await power.info(appNames)) };
  };
  on('GET', '/api/power', async ({ res }) => sendJson(res, 200, await ctx.build.power()));
  on('POST', '/api/power', async ({ req, res }) => {
    if (config.powerControls === false) throw forbidden('power controls are disabled in config.json');
    const body = await readJson(req);
    if (!power.ACTIONS.includes(body.action)) throw badRequest('unknown action');
    // a destructive action must say so explicitly; the UI asks the person to hold the button
    if (body.action !== 'cancel' && body.confirm !== true) throw badRequest('confirmation required');

    const options = { action: body.action, delaySec: body.delaySec, force: body.force === true, hybrid: body.hybrid === true };
    const result = await power.perform(options);
    log.info(`[power] ${body.action}${options.delaySec ? ` in ${options.delaySec}s` : ''}${options.force ? ' (force)' : ''}`);
    sendJson(res, 200, { ok: true, ...result });
  });
};
