'use strict';

const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const system = require('./system');

const MAX_DELAY_SEC = 24 * 60 * 60;
const COMMENT = 'Self Stream Deck';

// Which actions are delayed through "shutdown /t", and the flags that select them.
// The rest run immediately: Windows has no scheduled lock/sleep/logoff.
const SHUTDOWN_ACTIONS = {
  shutdown: ['/s'],
  restart: ['/r'],
  firmware: ['/r', '/fw'], // restart into the UEFI/BIOS setup
  advanced: ['/r', '/o'], // restart into the advanced boot menu (safe mode, recovery, startup settings)
};
const IMMEDIATE_ACTIONS = new Set(['lock', 'sleep', 'hibernate', 'logoff']);

// The pending shutdown lives in Windows; this remembers what *we* scheduled so the UI can show a countdown.
let scheduled = null; // { action, at, force }

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, output: `${stdout}${stderr}`.trim() });
    });
  });
}

const registryHas = async (key, value) => (await run('reg.exe', ['query', key, ...(value ? ['/v', value] : [])])).code === 0;

async function registryNumber(key, value) {
  const { code, output } = await run('reg.exe', ['query', key, '/v', value]);
  if (code !== 0) return null;
  const match = new RegExp(`${value}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'i').exec(output);
  return match ? parseInt(match[1], 16) : null;
}

// Windows' own "shutdown /a" fails (1116) when nothing is pending; that's not an error for the user.
async function cancel() {
  const { code, output } = await run('shutdown.exe', ['/a']);
  scheduled = null;
  return { cancelled: code === 0, note: code === 0 ? null : output };
}

// it has already fired (or the PC would be off) once its time passed
function schedule() {
  if (scheduled && scheduled.at < Date.now() - 5000) scheduled = null;
  // clients count down from `inSec`, not from `at`: the phone's clock may differ from this PC's
  return scheduled && { ...scheduled, inSec: Math.round((scheduled.at - Date.now()) / 1000) };
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// `appNames` maps a process name to the label the deck already shows for it ("windowsterminal" -> "Windows Terminal")
async function info(appNames = new Map()) {
  const uptimeSec = Math.round(os.uptime());
  const [hibernate, fastStartup, wuReboot, cbsReboot, windows] = await Promise.all([
    registryNumber('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power', 'HibernateEnabled'),
    registryNumber('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power', 'HiberbootEnabled'),
    registryHas('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'),
    registryHas('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'),
    system.windows().catch(() => ({ windows: [] })),
  ]);

  // windows that could hold unsaved work; UWP apps all run inside ApplicationFrameHost, so show their title instead
  const hosts = new Set(['applicationframehost']);
  const ignored = new Set(['explorer', 'textinputhost', 'searchhost', 'startmenuexperiencehost', 'shellexperiencehost']);
  const open = new Map();
  for (const window of windows.windows || []) {
    if (ignored.has(window.name)) continue;
    const label = hosts.has(window.name) ? window.title : appNames.get(window.name) || capitalize(window.name);
    open.set(label, (open.get(label) || 0) + 1);
  }

  return {
    uptimeSec,
    lastBoot: new Date(Date.now() - uptimeSec * 1000).toISOString(),
    hibernate: hibernate === 1,
    fastStartup: fastStartup === 1 && hibernate === 1,
    rebootPending: wuReboot || cbsReboot,
    openApps: [...open.entries()].map(([name, count]) => ({ name, count })).slice(0, 16),
    scheduled: schedule(),
  };
}

function validDelay(value) {
  const delay = Number(value ?? 0);
  if (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY_SEC) throw Object.assign(new Error('invalid delay'), { status: 400 });
  return delay;
}

async function perform({ action, delaySec, force = false, hybrid = false }) {
  if (action === 'cancel') return { action, ...(await cancel()) };

  if (IMMEDIATE_ACTIONS.has(action)) {
    if (action === 'lock') await run('rundll32.exe', ['user32.dll,LockWorkStation']);
    else if (action === 'logoff') await run('shutdown.exe', ['/l']);
    else if (action === 'hibernate') {
      const { code, output } = await run('shutdown.exe', ['/h']);
      if (code !== 0) throw Object.assign(new Error(output || 'hibernation is not available'), { status: 409 });
    } else {
      // SetSuspendState sleeps when hibernation is off; with "Suspend" it never hibernates behind your back
      spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)",
      ], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    return { action, at: null };
  }

  const flags = SHUTDOWN_ACTIONS[action];
  if (!flags) throw Object.assign(new Error('unknown action'), { status: 400 });

  const delay = validDelay(delaySec);
  await cancel(); // a second schedule is refused by Windows (error 1190) unless the first one is cancelled

  const args = [...flags];
  if (hybrid && action === 'shutdown') args.push('/hybrid');
  if (force) args.push('/f');
  args.push('/t', String(delay), '/c', COMMENT);

  const { code, output } = await run('shutdown.exe', args);
  if (code !== 0) throw Object.assign(new Error(output || `shutdown exited with ${code}`), { status: 500 });

  scheduled = delay > 0 ? { action, at: Date.now() + delay * 1000, force } : null;
  return { action, at: scheduled ? scheduled.at : null };
}

module.exports = { info, perform, schedule, ACTIONS: [...IMMEDIATE_ACTIONS, ...Object.keys(SHUTDOWN_ACTIONS), 'cancel'] };
