'use strict';

// Keeps the deck server running: starts src/index.js and starts it again whenever it exits, whatever the reason (a crash,
// being killed, the port still held by an old copy). Waits a little longer after each quick failure so a broken start
// does not spin. The autostart task runs this file; `npm start` still runs src/index.js directly, without a supervisor.
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, 'index.js');
const HEALTHY_MS = 30_000; // running this long counts as a good start: the wait goes back to the minimum
const MIN_WAIT_MS = 2_000;
const MAX_WAIT_MS = 30_000;

let wait = MIN_WAIT_MS;
let child = null;
let stopping = false;

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [SERVER, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) process.exit(0);
    wait = Date.now() - startedAt > HEALTHY_MS ? MIN_WAIT_MS : Math.min(MAX_WAIT_MS, wait * 2);
    console.log(`[supervisor] server exited (code ${code}, signal ${signal}); starting it again in ${wait / 1000}s`);
    setTimeout(start, wait);
  });
}

// stopping the supervisor stops the server with it
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(signal, () => {
    stopping = true;
    console.log(`[supervisor] stopping (${signal})`);
    if (child) child.kill('SIGTERM');
    else process.exit(0);
  });
}

console.log('[supervisor] started');
start();
