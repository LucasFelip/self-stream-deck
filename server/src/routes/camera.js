'use strict';

// The phone's camera as a webcam: frames in, an MJPEG stream out (see src/camera.js), and the direct virtual camera (src/vcam.js).

const { spawn } = require('node:child_process');
const { sendJson, readJson, readBuffer } = require('../http');
const { badRequest } = require('../validate');

module.exports = function cameraRoutes(ctx, on) {
  const { config, camera, vcam } = ctx;

  const cameraLink = () => `http://127.0.0.1:${config.port}/camera.html?token=${config.token}`;

  on('POST', '/api/camera/frame', async ({ req, res }) => {
    camera.push(await readBuffer(req, camera.MAX_FRAME));
    // tells the phone whether anyone uses the picture: if not, it only needs to send a frame now and then
    res.writeHead(204, { 'X-Camera-Wanted': camera.wanted() ? '1' : '0' });
    res.end();
  });
  on('GET', '/api/camera/stream', async ({ req, res }) => camera.attach(req, res));
  on('GET', '/api/camera/status', async ({ res }) => sendJson(res, 200, { ...camera.status(), link: cameraLink(), direct: await vcam.status() }));

  // the direct virtual camera (no OBS): installing registers a system-wide camera device, so it needs an explicit confirm
  const confirmed = async (req) => {
    const { confirm } = await readJson(req);
    if (confirm !== true) throw badRequest('confirm must be true');
  };
  on('POST', '/api/camera/direct/install', async ({ req, res }) => {
    await confirmed(req);
    await vcam.install();
    sendJson(res, 200, await vcam.status());
  });
  on('POST', '/api/camera/direct/uninstall', async ({ req, res }) => {
    await confirmed(req);
    await vcam.uninstall();
    sendJson(res, 200, await vcam.status());
  });

  // puts the link for OBS's Browser Source on this PC's clipboard, so nobody has to type a token
  on('POST', '/api/camera/copy-link', async ({ res }) => {
    await new Promise((resolve, reject) => {
      const child = spawn('clip.exe', [], { windowsHide: true });
      child.on('error', reject);
      child.on('close', resolve);
      child.stdin.end(cameraLink());
    });
    sendJson(res, 200, { ok: true });
  });
};
