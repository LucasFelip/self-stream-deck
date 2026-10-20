'use strict';

const { execFile } = require('node:child_process');

/**
 * The Windows Firewall rule that lets phones on the home network reach the deck's HTTPS port. It allows only that one port,
 * only TCP, and only from the local subnet (not from the internet), on every network profile (home networks are often marked
 * "Public"). Needs administrator rights, which the autostart task has; without them the server says so and keeps running.
 */

const RULE = 'Self Stream Deck (rede local)';

const run = (command) => new Promise((resolve) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
    resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr || (error && error.message) || '').trim() });
  });
});

/** Makes sure the rule exists for `port` (replaces one made for another port). Resolves to a short status word. */
async function ensure(port) {
  const result = await run(`
    $ErrorActionPreference = 'Stop'
    $rule = Get-NetFirewallRule -DisplayName '${RULE}' -ErrorAction SilentlyContinue
    if ($rule) {
      $current = ($rule | Get-NetFirewallPortFilter).LocalPort
      if ($current -eq '${port}' -and $rule.Enabled -eq 'True') { 'present'; return }
      $rule | Remove-NetFirewallRule
    }
    New-NetFirewallRule -DisplayName '${RULE}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Any -RemoteAddress LocalSubnet | Out-Null
    'created'
  `);
  if (!result.ok) {
    console.warn(`[firewall] could not set the rule (administrator rights needed): ${result.err.split('\n')[0]}`);
    return 'failed';
  }
  if (result.out === 'created') console.log(`[firewall] allowed TCP ${port} from the local network`);
  return result.out;
}

async function remove() {
  const result = await run(`Get-NetFirewallRule -DisplayName '${RULE}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`);
  return result.ok;
}

async function status() {
  const result = await run(`$r = Get-NetFirewallRule -DisplayName '${RULE}' -ErrorAction SilentlyContinue; if ($r) { ($r | Get-NetFirewallPortFilter).LocalPort } else { 'none' }`);
  return result.ok ? result.out : 'unknown';
}

module.exports = { ensure, remove, status, RULE };
