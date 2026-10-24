'use strict';

// Loads the browser scripts in the same order as index.html against a do-nothing DOM, to catch errors that only
// show up at run time (ReferenceError, TypeError) and that `node --check` cannot see.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = process.argv[2] || path.join(__dirname, '..', 'public');

// A stand-in for "any DOM thing": every property is another stand-in, calling it returns one too.
function dummy() {
  const target = function () {};
  return new Proxy(target, {
    get(_, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'length') return 0;
      if (prop === 'then') return undefined; // not a promise
      if (prop === Symbol.iterator) return function* () {};
      return dummy();
    },
    apply: () => dummy(),
    construct: () => dummy(),
    set: () => true,
  });
}

const sandbox = {
  console,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  ResizeObserver: class { observe() {} disconnect() {} },
  MutationObserver: class { observe() {} disconnect() {} },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  performance: { now: () => Date.now() },
  getComputedStyle: () => dummy(),
  innerWidth: 360, innerHeight: 640,
  localStorage: dummy(),
  navigator: dummy(),
  document: dummy(),
  Date, Math, Number, String, Array, Object, Map, Set, JSON, Promise, Error, Symbol, Boolean, parseInt, parseFloat, isFinite, Intl,
  encodeURIComponent, decodeURIComponent,
};
sandbox.window = sandbox;
vm.createContext(sandbox);

const scripts = ['deck.js', 'js/live.js', 'js/geometry.js', 'js/windows.js', 'js/media.js', 'js/audio.js', 'js/sound.js', 'js/monitor.js', 'js/game.js', 'js/power.js', 'js/idle.js', 'js/camera.js', 'js/editor.js', 'js/tiles.js', 'js/arrange.js', 'js/pager.js', 'js/edit.js', 'js/pc.js', 'js/header.js', 'js/volume.js', 'js/reload.js', 'js/connection.js', 'app.js'];
let failed = false;
for (const file of scripts) {
  try {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), sandbox, { filename: file });
    console.log(`ok     ${file}`);
  } catch (err) {
    failed = true;
    console.log(`FAILED ${file}: ${err.name}: ${err.message}`);
    console.log(String(err.stack).split('\n').slice(0, 4).join('\n'));
  }
}

const pages = (sandbox.Deck ? sandbox.Deck.pages : []).map((page) => `${page.id}(${page.section})`);
console.log(`registered pages: ${pages.join(', ')}`);
const expected = ['windows', 'sound', 'pc', 'power'];
const missing = expected.filter((id) => !pages.some((p) => p.startsWith(`${id}(`)));
if (missing.length) { failed = true; console.log(`MISSING pages: ${missing.join(', ')}`); }
process.exit(failed ? 1 : 0);
