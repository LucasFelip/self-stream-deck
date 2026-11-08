'use strict';

// The fake PC for the Node server: every module that talks to Windows is replaced by a function that answers from
// contracts/fixtures/fake-pc.json. State changes (volume, mute) stick, so a read after a write shows the write.

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = path.join(__dirname, '..', '..', 'contracts', 'fixtures', 'fake-pc.json');
const clone = (value) => JSON.parse(JSON.stringify(value));
const loadFixture = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

function createFakes(pc) {
  const calls = []; // what reached the "PC": [name, ...args]
  const note = (name, ...args) => { calls.push([name, ...args]); };
  const state = { volume: clone(pc.volume), mic: clone(pc.mic), audio: clone(pc.audio), screens: clone(pc.screens) };
  const art = Buffer.from(pc.artPngBase64, 'base64');
  let scheduled = null;

  const windowFor = (handle) => {
    const found = pc.windows.find((w) => w.handle === handle);
    if (!found) throw new Error('window not found'); // what the real helper says; the route turns it into a 404
    return found;
  };

  const system = {
    windows: async () => ({ running: [...new Set(pc.windows.map((w) => w.name))], windows: clone(pc.windows) }),
    focus: async (proc) => { note('focus', proc); return true; },
    mic: async () => clone(state.mic),
    setMic: async (muted) => { note('setMic', muted); state.mic.muted = muted === 'toggle' ? !state.mic.muted : muted; return clone(state.mic); },
    getVolume: async () => clone(state.volume),
    setVolume: async (level) => { note('setVolume', level); state.volume = { level, muted: false }; return clone(state.volume); },
    setMute: async (muted) => { note('setMute', muted); state.volume.muted = muted; return clone(state.volume); },
    toggleMute: async () => { note('toggleMute'); state.volume.muted = !state.volume.muted; return clone(state.volume); },
    pressKeys: async (vks) => { note('pressKeys', vks); return true; },
    devices: async () => ({ playback: clone(state.audio.playback), capture: clone(state.audio.capture) }),
    sessions: async () => clone(state.audio.sessions),
    setDefaultDevice: async (id) => { note('setDefaultDevice', id); return true; },
    setDeviceVolume: async (id, level) => { note('setDeviceVolume', id, level); return true; },
    setDeviceMute: async (id, muted) => { note('setDeviceMute', id, muted); return true; },
    setSessionVolume: async (pid, isSystem, level) => { note('setSessionVolume', pid, isSystem, level); return true; },
    setSessionMute: async (pid, isSystem, muted) => { note('setSessionMute', pid, isSystem, muted); return true; },
    monitors: async () => clone(state.screens),
    setBrightness: async (device, level) => { note('setBrightness', device, level); return true; },
    windowAction: async (handle, action) => { windowFor(handle); note('windowAction', handle, action); },
    moveWindow: async (handle, monitor) => { windowFor(handle); note('moveWindow', handle, monitor); },
    placeWindow: async (handle, x, y) => { windowFor(handle); note('placeWindow', handle, x, y); },
    snapWindow: async (handle, monitor, zone) => { windowFor(handle); note('snapWindow', handle, monitor, zone); },
    screensOff: async () => { note('screensOff'); },
    onWindowsChanged: () => () => {},
    watchWindows: async () => {},
    stop() {},
    warmUp() {},
  };

  const media = {
    state: async () => clone(pc.media),
    control: async (session, action, position) => { note('mediaControl', session, action, position); return true; },
    art: async (session, key) => (key === pc.media.sessions[0].artKey ? { mime: 'image/png', data: art } : null),
    stop() {},
  };

  const power = {
    ACTIONS: ['lock', 'sleep', 'hibernate', 'logoff', 'shutdown', 'restart', 'firmware', 'advanced', 'cancel'],
    schedule: () => scheduled,
    info: async () => ({ ...clone(pc.power), scheduled }),
    // the real module would shut the PC down: the fake only remembers a delayed action
    perform: async ({ action, delaySec }) => {
      note('power', action, delaySec);
      if (delaySec !== undefined && (!Number.isInteger(delaySec) || delaySec < 0 || delaySec > 86400)) throw Object.assign(new Error('invalid delay'), { status: 400 }); // as the real module
      if (action === 'cancel') { scheduled = null; return { action, cancelled: true, note: null }; }
      if (delaySec > 0 && ['shutdown', 'restart', 'firmware', 'advanced'].includes(action)) {
        scheduled = { action, at: 1_800_000_000_000, force: false, inSec: delaySec };
        return { action, at: scheduled.at };
      }
      return { action, at: null };
    },
  };

  const monitor = {
    sample: async () => clone(pc.monitor.sample),
    fps: async () => clone(pc.monitor.fps),
    processes: async () => clone(pc.monitor.processes),
    info: async () => clone(pc.monitor.info),
    stop() {},
  };

  const taskbar = {
    cachedApps: () => clone(pc.apps),
    refreshApps: async () => ({ apps: clone(pc.apps), changed: false }),
    launch: (app) => note('launch', app.id),
  };

  const camera = {
    MAX_FRAME: 64 * 1024,
    push: (buffer) => note('cameraFrame', buffer.length),
    wanted: () => false,
    attach: (req, res) => { res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' }); res.end(); },
    status: () => clone(pc.camera),
    stop() {},
  };

  const vcam = {
    installed: pc.vcam.installed,
    status: async () => ({ ...clone(pc.vcam), installed: vcam.installed }),
    install: async () => { note('vcamInstall'); vcam.installed = true; },
    uninstall: async () => { note('vcamUninstall'); vcam.installed = false; },
    stop() {},
  };

  const notifications = { list: async () => [], stop() {} };

  return {
    calls,
    fakes: {
      system, media, monitor, power, taskbar, camera, vcam, notifications,
      events: require('../../server/src/events'), // the real SSE hub: it is the thing under test
      update: (config, patch) => { note('update', Object.keys(patch)); Object.assign(config, patch); }, // never writes config.json
      uiVersion: () => 1,
    },
  };
}

module.exports = { createFakes, loadFixture, clone };
