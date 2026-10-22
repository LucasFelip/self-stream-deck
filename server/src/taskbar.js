'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { ICON_DIR, DATA_DIR } = require('./config');
const { log, swallow } = require('./log');

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

const toApps = (items, hidden = []) => dedupe(items)
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

// --- cache ------------------------------------------------------------------------------------------
// Reading the taskbar costs ~2.5 s of PowerShell (shortcuts, icons). The result is kept on disk together with a signature of the
// pinned-shortcuts folder (names, sizes, modification times): the server starts with the last list at once and runs the script
// again only when that signature changed (or when asked to, with the Refresh button).

const CACHE_FILE = path.join(DATA_DIR, 'taskbar-cache.json');
const TASKBAR_DIR = path.join(process.env.APPDATA || '', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');

function signature() {
  try {
    const parts = fs.readdirSync(TASKBAR_DIR)
      .filter((name) => /\.lnk$/i.test(name))
      .sort()
      .map((name) => {
        const stat = fs.statSync(path.join(TASKBAR_DIR, name));
        return `${name}|${stat.size}|${Math.round(stat.mtimeMs)}`;
      });
    return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
  } catch (err) {
    swallow('[taskbar] could not sign the taskbar folder', err); // no signature: the list is simply read again
    return 'none';
  }
}

function readCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return Array.isArray(cached.items) ? cached : null;
  } catch (err) {
    swallow('[taskbar] no usable cache', err); // missing on the first run, damaged otherwise: the list is read again
    return null;
  }
}

/** The apps from the last run, instantly (empty on the very first start). */
function cachedApps(hidden = []) {
  const cached = readCache();
  return cached ? toApps(cached.items, hidden) : [];
}

/**
 * Brings the list up to date. Resolves to { apps, changed }: without `force` and with an unchanged folder it is a no-op
 * (changed: false). Icons already extracted stay in ICON_DIR, so only a changed signature pays for PowerShell.
 */
async function refreshApps({ force = false, hidden = [] } = {}) {
  const now = signature();
  const cached = readCache();
  if (!force && cached && cached.signature === now) return { apps: toApps(cached.items, hidden), changed: false };

  const items = await runScript();
  const changed = !cached || JSON.stringify(cached.items) !== JSON.stringify(items);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ signature: now, items }));
  } catch (err) {
    log.warn(`[taskbar] could not save the cache (the next start reads the taskbar again): ${err.message}`);
  }
  return { apps: toApps(items, hidden), changed };
}

// the full read, every time (kept for callers that want it)
async function listApps(hidden = []) {
  return toApps(await runScript(), hidden);
}

// Launching goes through explorer.exe so the shortcut behaves exactly like a click on
// the taskbar (arguments, "start in", elevated flags and shell: targets included).
function launch(app) {
  const child = spawn('explorer.exe', [app.lnk], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

module.exports = { listApps, cachedApps, refreshApps, signature, launch };
