'use strict';

// Virtual-key codes for the shortcut specs used in config.json ("ctrl+shift+esc").
const NAMED = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b,
  esc: 0x1b, escape: 0x1b, tab: 0x09, enter: 0x0d, space: 0x20, backspace: 0x08,
  delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, printscreen: 0x2c, prtsc: 0x2c,
  playpause: 0xb3, nexttrack: 0xb0, prevtrack: 0xb1, stop: 0xb2,
  volumeup: 0xaf, volumedown: 0xae, mute: 0xad,
};

const LABELS = { ctrl: 'Ctrl', control: 'Ctrl', win: 'Win', printscreen: 'PrtSc', prtsc: 'PrtSc', pageup: 'PgUp', pagedown: 'PgDn' };

const MAX_KEYS = 5;

function vkOf(name) {
  if (name in NAMED) return NAMED[name];
  if (/^[a-z]$/.test(name)) return name.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(name)) return name.charCodeAt(0);
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(name);
  if (fn) return 0x70 + Number(fn[1]) - 1;
  throw new Error(`unknown key "${name}"`);
}

function tokens(spec) {
  const parts = String(spec).toLowerCase().split('+').map((part) => part.trim());
  if (!parts.length || parts.some((part) => !part)) throw new Error(`invalid shortcut "${spec}"`);
  if (parts.length > MAX_KEYS) throw new Error(`too many keys in "${spec}"`);
  return parts;
}

/** "ctrl+shift+esc" -> [0x11, 0x10, 0x1b] */
function parse(spec) {
  return tokens(spec).map(vkOf);
}

/** "ctrl+shift+esc" -> "Ctrl+Shift+Esc" */
function display(spec) {
  return tokens(spec)
    .map((name) => LABELS[name] || (name.length === 1 || /^f\d+$/.test(name) ? name.toUpperCase() : name[0].toUpperCase() + name.slice(1)))
    .join('+');
}

module.exports = { parse, display, vkOf };
