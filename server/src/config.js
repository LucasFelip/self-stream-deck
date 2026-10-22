'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validate } = require('./config-check');
const { log } = require('./log');

// SSD_DATA_DIR lets the tests (and anyone who wants the data elsewhere) keep their files apart from the real ones
const DATA_DIR = process.env.SSD_DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ICON_DIR = path.join(DATA_DIR, 'icons');

const DEFAULTS = {
  port: 7878,
  // app ids (see /api/apps) that should not show up on the deck
  hidden: [],
  // false: only this PC and the USB tunnel can reach the deck. true: also over the home network, through an HTTPS server on
  // httpsPort (self-signed certificate that the phone app pins, firewall rule for the local subnet only). See `npm run lan`.
  lan: false,
  httpsPort: 7879,
  // false removes the shutdown/restart/sleep/... actions from the API entirely
  powerControls: true,
  // the header's play/pause button for whatever is playing. It keeps the media helper running (~90 MB); false turns it off.
  miniPlayer: true,
  // false turns off the button editor in the app (shortcuts, macros, hidden/ordered apps can then only be changed here)
  editor: true,
  // macros: lists of whitelisted steps (see src/macros.js); the editor in the app writes them
  macros: [],
  // where each key sits on the Apps and Shortcuts pages: lists of "a:<app id>", "s:<shortcut id>", "m:<macro id>", "c:camera".
  // Set by holding and dragging a key on the deck; keys not listed follow in their natural order.
  tileOrder: { apps: [], shortcuts: [] },
  // keyboard shortcuts sent to the PC; "keys" are joined with "+" (see src/keys.js for the names)
  shortcuts: [
    { id: 'desktop', label: 'Área de trabalho', keys: 'win+d' },
    { id: 'task-manager', label: 'Gerenciador de tarefas', keys: 'ctrl+shift+esc' },
    { id: 'switch-window', label: 'Alternar janela', keys: 'alt+tab' },
    { id: 'task-view', label: 'Visão de tarefas', keys: 'win+tab' },
    { id: 'screenshot', label: 'Captura de tela', keys: 'win+shift+s' },
    { id: 'lock', label: 'Bloquear PC', keys: 'win+l' },
    { id: 'copy', label: 'Copiar', keys: 'ctrl+c' },
    { id: 'paste', label: 'Colar', keys: 'ctrl+v' },
    { id: 'undo', label: 'Desfazer', keys: 'ctrl+z' },
  ],
};

const BACKUP_FILE = `${CONFIG_FILE}.bak`;

// editors and PowerShell's Set-Content may prepend a UTF-8 BOM
const parse = (text) => JSON.parse(text.replace(/^\uFEFF/, ''));

// The previous version is kept as config.json.bak, and the new one is written beside the file and moved in, so a crash
// in the middle never leaves a half-written config.json.
function save(text) {
  if (fs.existsSync(CONFIG_FILE)) fs.copyFileSync(CONFIG_FILE, BACKUP_FILE);
  const temporary = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, CONFIG_FILE);
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let stored = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      stored = parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      // Never overwrite a file we can't read: that would silently rotate the pairing token.
      const backup = fs.existsSync(BACKUP_FILE) ? ` The last saved version is kept in ${BACKUP_FILE}.` : '';
      throw new Error(`${CONFIG_FILE} is not valid JSON (${err.message}). Fix or delete it.${backup}`);
    }
  }

  const config = { ...DEFAULTS, ...stored };
  if (process.env.SSD_PORT) config.port = Number(process.env.SSD_PORT);
  if (!config.token) config.token = crypto.randomBytes(16).toString('hex');

  // a wrong value is not worth stopping the deck for: say what it is, so it can be fixed (the editor refuses to save new ones)
  for (const { message } of validate(config)) log.warn(`[config] ${message}`);

  // SSD_PORT is a per-run override and must not end up in config.json
  const { port: _runtimePort, ...persisted } = config;
  const text = JSON.stringify({ port: stored.port ?? DEFAULTS.port, ...persisted }, null, 2);
  if (!fs.existsSync(CONFIG_FILE) || fs.readFileSync(CONFIG_FILE, 'utf8') !== text) save(text);
  return config;
}

// What the in-app editor may change. The pairing token and every other key stay as they are. A change that would leave the
// file invalid (damaged characters, repeated ids, wrong types) is refused with a 400 and nothing is written.
const EDITABLE = ['shortcuts', 'macros', 'hidden', 'tileOrder'];

function update(config, patch) {
  const stored = parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const changed = EDITABLE.filter((key) => patch[key] !== undefined);
  const next = { ...stored, ...Object.fromEntries(changed.map((key) => [key, patch[key]])) };

  const problems = validate(next).filter((problem) => changed.includes(problem.key));
  if (problems.length) throw Object.assign(new Error(problems[0].message), { status: 400 });

  save(JSON.stringify(next, null, 2));
  for (const key of changed) config[key] = patch[key];
}

module.exports = { load, update, DATA_DIR, ICON_DIR };
