'use strict';

// Now playing (Windows media session: Spotify, YouTube in a browser, ...).

const { sendJson, sendBuffer, readJson } = require('../http');
const { badRequest, notFound, number } = require('../validate');

const MEDIA_ACTIONS = new Set(['toggle', 'play', 'pause', 'next', 'previous', 'seek']);

module.exports = function mediaRoutes(ctx, on) {
  const { media } = ctx;

  on('GET', '/api/media', async ({ res }) => sendJson(res, 200, await media.state()));

  on('POST', '/api/media/control', async ({ req, res }) => {
    const body = await readJson(req);
    if (typeof body.session !== 'string' || !body.session || body.session.length > 300) throw badRequest('invalid session');
    if (!MEDIA_ACTIONS.has(body.action)) throw badRequest('invalid action');
    const position = body.action === 'seek' ? number(body.position, 'position') : undefined;
    if (position !== undefined && (position < 0 || position > 7 * 24 * 3600)) throw badRequest('invalid position');
    sendJson(res, 200, { ok: true, accepted: await media.control(body.session, body.action, position) });
  });

  on('GET', '/api/media/art', async ({ res, url }) => {
    const session = url.searchParams.get('session') || '';
    const key = url.searchParams.get('key') || '';
    if (!session || !/^[0-9a-f]{12}$/.test(key)) throw badRequest('invalid art request');
    const art = await media.art(session, key);
    if (!art) throw notFound('no artwork');
    sendBuffer(res, art.data, art.mime, { 'Cache-Control': 'max-age=31536000, immutable' }); // the key changes per track
  });
};
