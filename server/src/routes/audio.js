'use strict';

// Master volume, the devices and the per-application mixer.

const { sendJson, readJson } = require('../http');
const { badRequest, notFound, number, percent } = require('../validate');
const { log } = require('../log');

module.exports = function audioRoutes(ctx, on) {
  const { system } = ctx;

  on('GET', '/api/volume', async ({ res }) => sendJson(res, 200, await system.getVolume()));
  on('POST', '/api/volume', async ({ req, res }) => {
    const body = await readJson(req);
    let result;
    if (body.level !== undefined) result = await system.setVolume(percent(body.level));
    if (body.muted === 'toggle') result = await system.toggleMute();
    else if (typeof body.muted === 'boolean') result = await system.setMute(body.muted);
    sendJson(res, 200, result ?? (await system.getVolume()));
  });

  ctx.build.audio = async () => {
    const [devices, sessions] = await Promise.all([system.devices(), system.sessions().catch(() => [])]);
    return { ...devices, sessions };
  };
  on('GET', '/api/audio', async ({ res }) => sendJson(res, 200, await ctx.build.audio()));

  on('POST', '/api/audio/default', async ({ req, res }) => {
    const { id } = await readJson(req);
    if (!(await ctx.knownDeviceIds()).has(id)) throw notFound('unknown device');
    await system.setDefaultDevice(id);
    log.info(`[audio] default device -> ${id}`);
    sendJson(res, 200, { ok: true });
  });

  on('POST', '/api/audio/device', async ({ req, res }) => {
    const body = await readJson(req);
    if (!(await ctx.knownDeviceIds()).has(body.id)) throw notFound('unknown device');
    if (body.level !== undefined) await system.setDeviceVolume(body.id, percent(body.level));
    if (typeof body.muted === 'boolean') await system.setDeviceMute(body.id, body.muted);
    sendJson(res, 200, { ok: true });
  });

  on('POST', '/api/audio/session', async ({ req, res }) => {
    const body = await readJson(req);
    const isSystemSounds = body.system === true;
    const pid = isSystemSounds ? 0 : number(body.pid, 'pid');
    if (!Number.isInteger(pid) || pid < 0) throw badRequest('invalid pid');
    if (body.level !== undefined) await system.setSessionVolume(pid, isSystemSounds, percent(body.level));
    if (typeof body.muted === 'boolean') await system.setSessionMute(pid, isSystemSounds, body.muted);
    sendJson(res, 200, { ok: true });
  });
};
