'use strict';

// The pairing code, for an authenticated browser: the iPhone's Home Screen app has its own cookies, so the code is copied in Safari
// (menu > Código de pareamento) and pasted on the pairing page there. The Android app and the cookie flow do not use it.

const { sendJson } = require('../http');

module.exports = function pairingRoutes(ctx, on) {
  const { config } = ctx;
  on('GET', '/api/pair-code', ({ res }) => sendJson(res, 200, { code: config.token }));
};
