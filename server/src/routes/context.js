'use strict';

// What the route modules share: the PC-facing modules (injectable, so tests can pass fakes), the list of apps and shortcuts
// the deck shows, and a few lookups several routes need. It holds no routes itself.

const keys = require('../keys');
const { forbidden } = require('../validate');
const { log } = require('../log');

const realDeps = () => ({
  system: require('../system'),
  media: require('../media'),
  monitor: require('../monitor'),
  power: require('../power'),
  camera: require('../camera'),
  vcam: require('../vcam'),
  taskbar: require('../taskbar'),
  events: require('../events'),
  update: require('../config').update,
  uiVersion: require('../http').uiVersion,
});

function createContext(config, overrides = {}) {
  const ctx = { config, ...realDeps(), ...overrides, keys, build: {} };
  const { system, taskbar } = ctx;

  // `apps` is what the deck shows: the taskbar apps without the hidden ones (the order on screen is the deck's tileOrder)
  let allApps = taskbar.cachedApps([]); // every taskbar app, hidden ones included (the editor lists them all)
  let apps = [];
  let appsRev = 0; // goes up whenever the list does, so a phone that is already open reloads its keys by itself

  ctx.apps = () => apps;
  ctx.allApps = () => allApps;
  ctx.appsRev = () => appsRev;

  ctx.applyAppConfig = () => {
    const hidden = new Set(config.hidden || []);
    apps = allApps.filter((app) => !hidden.has(app.id));
  };
  ctx.applyAppConfig();

  ctx.refreshApps = async ({ force = false } = {}) => {
    const { apps: fresh, changed } = await taskbar.refreshApps({ force });
    if (changed) {
      allApps = fresh;
      ctx.applyAppConfig();
      appsRev += 1;
    }
    return apps;
  };

  // Shortcuts come only from config.json (or the editor, which validates them) and are sent by id.
  let shortcuts = [];
  ctx.shortcuts = () => shortcuts;
  ctx.loadShortcuts = () => {
    shortcuts = [];
    for (const [index, entry] of (config.shortcuts || []).entries()) {
      try {
        shortcuts.push({
          id: String(entry.id ?? `shortcut-${index}`),
          label: String(entry.label ?? entry.keys),
          keys: String(entry.keys),
          display: keys.display(entry.keys),
          vks: keys.parse(entry.keys),
        });
      } catch (err) {
        log.warn(`[shortcuts] ignoring "${entry.label ?? entry.id}": ${err.message}`);
      }
    }
  };
  ctx.loadShortcuts();

  // Macros: lists of whitelisted steps, validated when saved (src/macros.js)
  ctx.macroList = () => (Array.isArray(config.macros) ? config.macros.filter((macro) => macro && macro.id && Array.isArray(macro.steps)) : []);

  ctx.MEDIA_KEYS = { prev: keys.vkOf('prevtrack'), playpause: keys.vkOf('playpause'), next: keys.vkOf('nexttrack') };

  // Which apps are running / have a window. Several panels ask in the same second, so share one lookup.
  let snapshot = { at: 0, promise: null };
  ctx.windowSnapshot = () => {
    if (!snapshot.promise || Date.now() - snapshot.at > 1500) {
      snapshot = { at: Date.now(), promise: system.windows() };
      snapshot.promise.catch(() => { snapshot.at = 0; });
    }
    return snapshot.promise;
  };

  ctx.knownDeviceIds = async () => {
    const { playback, capture } = await system.devices();
    return new Set([...playback, ...capture].map((device) => device.id));
  };

  // Only ids from the taskbar list can be launched, never arbitrary paths. An app that already has a window is
  // brought to the front instead of being started again.
  ctx.launchApp = async (app) => {
    if (app.proc) {
      try {
        const { windows } = await ctx.windowSnapshot();
        if (windows.some((window) => window.name === app.proc) && (await system.focus(app.proc))) {
          log.info(`[focus] ${app.name}`);
          return 'focused';
        }
      } catch (err) {
        log.warn(`[focus] ${app.name}: ${err.message}`);
      }
    }
    taskbar.launch(app);
    log.info(`[launch] ${app.name}`);
    return 'launched';
  };

  // the button editor and the layout can be turned off with "editor": false
  ctx.editorOn = () => {
    if (config.editor === false) throw forbidden('the editor is turned off in config.json');
  };

  return ctx;
}

module.exports = { createContext };
