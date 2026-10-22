'use strict';

// Running macros: lists of whitelisted steps (validated when saved, see src/macros.js), one run of each at a time.

const macros = require('../macros');
const { sendJson } = require('../http');
const { httpError, notFound } = require('../validate');
const { log } = require('../log');

module.exports = function macrosRoutes(ctx, on) {
  const { system, keys } = ctx;
  const running = new Set(); // macros being run

  on('GET', '/api/macros', async ({ res }) =>
    sendJson(res, 200, { macros: ctx.macroList().map(({ id, label, page, steps }) => ({ id, label, page: page || 'shortcuts', steps: steps.length })) }));

  // One handler per step type; each throws when its step cannot be done. Apps and devices are looked up by id here, at run time.
  const handlers = {
    async launch(step) {
      const app = ctx.allApps().find((candidate) => candidate.id === step.app);
      if (!app) throw new Error('app not on the taskbar anymore');
      await ctx.launchApp(app);
    },
    async keys(step) { await system.pressKeys(keys.parse(step.keys)); },
    async media(step) { await system.pressKeys([ctx.MEDIA_KEYS[step.key]]); },
    async volume(step) { await system.setVolume(step.level); },
    async mute(step) {
      if (step.muted === 'toggle') await system.toggleMute();
      else await system.setMute(step.muted);
    },
    async mic(step) { await system.setMic(step.muted); },
    async output(step) {
      if (!(await ctx.knownDeviceIds()).has(step.device)) throw new Error(`device not found${step.name ? `: ${step.name}` : ''}`);
      await system.setDefaultDevice(step.device);
    },
    // brings an app's window to a screen's half or full size, waiting a few seconds for the window to exist (it may just have been launched)
    async place(step) {
      const app = ctx.allApps().find((candidate) => candidate.id === step.app);
      if (!app || !app.proc) throw new Error('app not found');
      const until = Date.now() + 8000;
      for (;;) {
        const { windows } = await system.windows();
        const window = windows.find((item) => item.name === app.proc && item.title);
        if (window) {
          await system.snapWindow(window.handle, step.monitor, step.zone);
          return;
        }
        if (Date.now() > until) throw new Error(`${app.name} has no window`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    },
  };

  on('POST', '/api/macro/:id', async ({ res, params }) => {
    const macro = ctx.macroList().find((candidate) => candidate.id === params.id);
    if (!macro) throw notFound('unknown macro');
    if (running.has(macro.id)) throw httpError(409, 'this macro is already running');
    running.add(macro.id);
    try {
      const outcome = await macros.run(macro, handlers);
      log.info(`[macro] ${macro.label}: ${outcome.results.length - outcome.failed}/${outcome.results.length} steps`);
      sendJson(res, 200, { ok: outcome.failed === 0, label: macro.label, steps: outcome.results, client: outcome.client });
    } finally {
      running.delete(macro.id);
    }
  });
};
