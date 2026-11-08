'use strict';

const path = require('node:path');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { log, swallow } = require('./log');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

/**
 * A long-lived helper process that answers one JSON request per line.
 *
 * Each kind of work gets its own host that stays alive: a slow call in one (say, reading media info) can't delay another
 * (a volume tap). The process is started on first use and restarted if it dies.
 *
 * The helper is the native exe (src/native.js, mode `native`) when it can be built, and the PowerShell script otherwise:
 * both speak the same protocol. A native helper that dies before it is ready twice in a row is given up on for this run.
 */
class Host {
  /**
   * native: the mode to start in ssd-helper.exe (null: PowerShell only).
   * idleStopMs: stop the process after this long without requests (it starts again on the next one).
   * retryOps: read-only ops that are asked once more when the helper dies while answering (never for an action: a key
   *   press or a volume change must not happen twice because the answer was lost).
   */
  constructor(name, script, { timeoutMs = 8000, idleStopMs = 0, native = null, retryOps = [] } = {}) {
    this.name = name;
    this.retryOps = new Set(retryOps);
    this.script = path.join(SCRIPTS, script);
    this.mode = native;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.starting = null;
    this.command = null;
    this.nativeFailures = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.lastUsed = Date.now();
    this.events = new EventEmitter(); // lines the helper sends on its own: {"event":"windows"} -> events.emit('windows')

    if (idleStopMs > 0) {
      setInterval(() => {
        if (this.child && this.pending.size === 0 && Date.now() - this.lastUsed > idleStopMs) this.child.kill();
      }, 30_000).unref();
    }
  }

  /** Which program runs: the native exe when there is one (and it has not failed), else the PowerShell script. */
  async resolveCommand() {
    if (this.command) return this.command;
    const exe = this.mode && this.nativeFailures < 2 ? await require('./native').ensure() : null;
    this.command = exe
      ? { file: exe, args: [this.mode], native: true }
      : { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script], native: false };
    return this.command;
  }

  async start() {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const command = await this.resolveCommand();
      const proc = spawn(command.file, command.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = proc;
      let ready = false;

      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        let message;
        try {
          message = JSON.parse(line.replace(/^\uFEFF/, ''));
        } catch (err) {
          swallow(`[${this.name}] a line that is not JSON (${line.slice(0, 60)})`, err); // PowerShell may print stray text
          return;
        }
        if (message.id === 0) {
          ready = true;
          this.events.emit('ready', message); // also after a restart: whatever the helper was told to do is gone with the old one
        }
        if (message.event) {
          this.events.emit(message.event, message);
          return;
        }
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message);
        else entry.reject(new Error(message.error || `${this.name} helper error`));
      });

      proc.stderr.on('data', (chunk) => log.error(`[${this.name}] ${String(chunk).trim()}`));
      proc.stdin.on('error', (err) => swallow(`[${this.name}] stdin closed`, err)); // the exit handler below reports the death
      proc.on('exit', (code, signal) => {
        if (this.child !== proc) return;
        this.child = null;
        if (command.native && !ready) {
          this.nativeFailures += 1;
          this.command = null; // after two failures resolveCommand() picks PowerShell
          log.warn(`[${this.name}] the native helper exited before it was ready (${this.nativeFailures}/2)`);
        }
        if (this.pending.size) log.warn(`[${this.name}] the helper exited (${signal || `code ${code}`}) with ${this.pending.size} request(s) waiting`);
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(Object.assign(new Error(`${this.name} helper exited`), { exited: true }));
        }
        this.pending.clear();
      });
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async request(payload, timeoutMs = this.timeoutMs) {
    try {
      return await this.send(payload, timeoutMs);
    } catch (err) {
      if (!err.exited || !this.retryOps.has(payload.op)) throw err;
      log.warn(`[${this.name}] the helper died while answering ${payload.op}: starting it again and asking once more`);
      return this.send(payload, timeoutMs);
    }
  }

  async send(payload, timeoutMs) {
    this.lastUsed = Date.now();
    if (!this.child) await this.start();
    if (!this.child) throw new Error(`${this.name} helper is not running`);
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

  // starts the helper before the first tap needs it
  warmUp() {
    return this.request({ op: 'ping' }, 20000).catch((err) => log.warn(`[${this.name}] helper not ready: ${err.message}`));
  }

  stop() {
    if (this.child) this.child.kill();
  }
}

module.exports = { Host };
