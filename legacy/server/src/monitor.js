'use strict';

const { Host } = require('./host');

// Starting this helper creates dozens of performance counters, which takes several seconds.
const IDLE_STOP_MS = 3 * 60 * 1000;
const host = new Host('monitor', 'monitor-host.ps1', { timeoutMs: 20000, idleStopMs: IDLE_STOP_MS, native: 'monitor', retryOps: ['sample', 'fps', 'processes', 'info'] });

let infoCache = null;
let infoPending = null;

// Static hardware/OS description: slow to collect (CIM queries), and it doesn't change while the server runs.
function info() {
  if (infoCache) return Promise.resolve(infoCache);
  if (!infoPending) {
    infoPending = host
      .request({ op: 'info' }, 30000)
      .then(({ info: result }) => {
        infoCache = result;
        return result;
      })
      .finally(() => { infoPending = null; });
  }
  return infoPending;
}

// drop the protocol fields (id/ok) so the API returns only the measurements
const strip = ({ id, ok, ...rest }) => rest;

module.exports = {
  stop: () => host.stop(),
  sample: () => host.request({ op: 'sample' }).then(strip),
  fps: () => host.request({ op: 'fps' }).then(({ fps }) => fps ?? null),
  processes: () => host.request({ op: 'processes' }).then(({ top }) => top),
  info,
};
