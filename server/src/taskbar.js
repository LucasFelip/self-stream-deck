'use strict';

const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { ICON_DIR } = require('./config');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'taskbar.ps1');

function runScript() {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-IconDir', ICON_DIR],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr.trim() || err.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('taskbar.ps1 returned invalid JSON'));
        }
      },
    );
  });
}

// "03 Discord.lnk" -> "Discord"
function displayName(file) {
  return file.replace(/\.lnk$/i, '').replace(/^\d+\s+/, '');
}

// Shortcuts without a file target (File Explorer, shell: items) can't be compared by path, so
// the same-looking icon stands in for "same app" (e.g. "Explorador de Arquivos" vs "File Explorer").
function dedupeKey(item) {
  if (item.target) return `${item.target}|${item.args}`.toLowerCase();
  return item.iconHash ? `icon:${item.iconHash}` : `name:${displayName(item.file).toLowerCase()}`;
}

// The TaskBar folder can hold both numbered ("02 Brave.lnk") and plain ("Brave.lnk")
// shortcuts to the same app. Keep one per target, preferring the numbered one so the
// order follows the numbering.
function dedupe(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = dedupeKey(item);
    const current = byKey.get(key);
    if (!current || (/^\d+\s/.test(item.file) && !/^\d+\s/.test(current.file))) byKey.set(key, item);
  }
  return [...byKey.values()].sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
}

// The running process this shortcut starts ("brave.exe" -> "brave"), used to tell whether the app is
// open. The Windows Terminal shortcut points at an alias that runs as WindowsTerminal.
function processName(item) {
  if (!item.target) return null;
  const name = path.win32.basename(item.target).replace(/\.exe$/i, '').toLowerCase();
  return name === 'wt' ? 'windowsterminal' : name;
}

async function listApps(hidden = []) {
  const items = dedupe(await runScript());
  return items
    .filter((item) => !hidden.includes(item.id))
    .map((item) => ({
      id: item.id,
      name: displayName(item.file),
      lnk: item.lnk,
      proc: processName(item),
      hasIcon: item.hasIcon,
      // part of the icon URL, so clients refetch when the icon changes
      iconVersion: item.iconHash ? item.iconHash.slice(0, 8) : '',
    }));
}

// Launching goes through explorer.exe so the shortcut behaves exactly like a click on
// the taskbar (arguments, "start in", elevated flags and shell: targets included).
function launch(app) {
  const child = spawn('explorer.exe', [app.lnk], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

module.exports = { listApps, launch };
