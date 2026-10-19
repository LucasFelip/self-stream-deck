'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ICON_DIR = path.join(DATA_DIR, 'icons');

const DEFAULTS = {
  port: 7878,
  // app ids (see /api/apps) that should not show up on the deck
  hidden: [],
  // false: listen on 127.0.0.1 only (USB through adb reverse, or this PC). true: also reachable over Wi-Fi/LAN.
  lan: false,
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

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let stored = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      // editors and PowerShell's Set-Content may prepend a UTF-8 BOM
      stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      // Never overwrite a file we can't read: that would silently rotate the pairing token.
      throw new Error(`${CONFIG_FILE} is not valid JSON (${err.message}). Fix or delete it.`);
    }
  }

  const config = { ...DEFAULTS, ...stored };
  if (process.env.SSD_PORT) config.port = Number(process.env.SSD_PORT);
  if (!config.token) config.token = crypto.randomBytes(16).toString('hex');

  // SSD_PORT is a per-run override and must not end up in config.json
  const { port: _runtimePort, ...persisted } = config;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ port: stored.port ?? DEFAULTS.port, ...persisted }, null, 2));
  return config;
}

// What the in-app editor may change. Written atomically; the pairing token and every other key stay as they are.
const EDITABLE = ['shortcuts', 'macros', 'hidden', 'tileOrder'];

function update(config, patch) {
  const stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, ''));
  for (const key of EDITABLE) {
    if (patch[key] === undefined) continue;
    stored[key] = patch[key];
    config[key] = patch[key];
  }
  const temporary = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(stored, null, 2));
  fs.renameSync(temporary, CONFIG_FILE);
}

module.exports = { load, update, DATA_DIR, ICON_DIR };
