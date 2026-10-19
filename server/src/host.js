'use strict';

const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

/**
 * A long-lived PowerShell process that answers one JSON request per line.
 *
 * Starting PowerShell (and compiling its native helpers) costs a second or two, so each kind of work gets
 * its own host that stays alive: a slow call in one (say, reading media info) can't delay another (a volume tap).
 * The process is started on first use and restarted if it dies.
 */
class Host {
  /**
   * idleStopMs: stop the process after this long without requests (it starts again on the next one).
   * A PowerShell helper costs 90-260 MB, so rarely used ones shouldn't stay resident.
   */
  constructor(name, script, { timeoutMs = 8000, idleStopMs = 0 } = {}) {
    this.name = name;
    this.script = path.join(SCRIPTS, script);
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.lastUsed = Date.now();

    if (idleStopMs > 0) {
      setInterval(() => {
        if (this.child && this.pending.size === 0 && Date.now() - this.lastUsed > idleStopMs) this.child.kill();
      }, 30_000).unref();
    }
  }

  start() {
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = proc;

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message);
      else entry.reject(new Error(message.error || `${this.name} helper error`));
    });

    proc.stderr.on('data', (chunk) => console.error(`[${this.name}] ${String(chunk).trim()}`));
    proc.stdin.on('error', () => {});
    proc.on('exit', () => {
      if (this.child !== proc) return;
      this.child = null;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`${this.name} helper exited`));
      }
      this.pending.clear();
    });
  }

  request(payload, timeoutMs = this.timeoutMs) {
    this.lastUsed = Date.now();
    if (!this.child) this.start();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} helper timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // the request id goes last so a payload field can never overwrite it
      this.child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
    });
  }

  // starts the helper (and compiles its native code) before the first tap needs it
  warmUp() {
    return this.request({ op: 'ping' }, 20000).catch((err) => console.warn(`[${this.name}] helper not ready: ${err.message}`));
  }

  stop() {
    if (this.child) this.child.kill();
  }
}

module.exports = { Host };
