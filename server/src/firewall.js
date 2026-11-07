'use strict';

const { execFile } = require('node:child_process');

/**
 * The Windows Firewall rules that let phones on the home network reach the deck. Each rule allows only its ports, only TCP, and only
 * from the local subnet (not from the internet), on every network profile (home networks are often marked "Public").
 * Needs administrator rights, which the autostart task has; without them the server says so and keeps running.
 *   RULE      the Wi-Fi HTTPS port of the Android app
 *   RULE_IOS  the iPhone's HTTPS port and the plain-HTTP port that hands out the certificate authority
 */

const RULE = 'Self Stream Deck (rede local)';
const RULE_IOS = 'Self Stream Deck (iPhone)';

const run = (command) => new Promise((resolve) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
    resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr || (error && error.message) || '').trim() });
  });
});

/** Makes sure the rule exists for `ports` (a number or a list; replaces one made for other ports). Resolves to a short status word. */
async function ensure(ports, rule = RULE) {
  const list = [].concat(ports).map(Number).sort((a, b) => a - b).join(',');
  const result = await run(`
    $ErrorActionPreference = 'Stop'
    $rule = Get-NetFirewallRule -DisplayName '${rule}' -ErrorAction SilentlyContinue
    if ($rule) {
      $current = (@(($rule | Get-NetFirewallPortFilter).LocalPort) | Sort-Object { [int]$_ }) -join ','
      if ($current -eq '${list}' -and $rule.Enabled -eq 'True') { 'present'; return }
      $rule | Remove-NetFirewallRule
    }
    New-NetFirewallRule -DisplayName '${rule}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${list} -Profile Any -RemoteAddress LocalSubnet | Out-Null
    'created'
  `);
  if (!result.ok) {
    console.warn(`[firewall] could not set the rule (administrator rights needed): ${result.err.split('\n')[0]}`);
    return 'failed';
  }
  if (result.out === 'created') console.log(`[firewall] allowed TCP ${list} from the local network`);
  return result.out;
}

async function remove(rule = RULE) {
  const result = await run(`Get-NetFirewallRule -DisplayName '${rule}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`);
  return result.ok;
}

async function status(rule = RULE) {
  const result = await run(`$r = Get-NetFirewallRule -DisplayName '${rule}' -ErrorAction SilentlyContinue; if ($r) { (@(($r | Get-NetFirewallPortFilter).LocalPort) | Sort-Object { [int]$_ }) -join ',' } else { 'none' }`);
  return result.ok ? result.out : 'unknown';
}

module.exports = { ensure, remove, status, RULE, RULE_IOS };
