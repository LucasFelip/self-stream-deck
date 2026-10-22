'use strict';

const { Host } = require('./host');
const { swallow } = require('./log');

// Keys, windows and audio share one helper: these calls are quick and benefit from running in order.
const input = new Host('system', 'input-host.ps1', { native: 'input', retryOps: ['getVolume', 'getMic', 'devices', 'sessions', 'windows', 'monitors'] });

// The native helper pushes window changes only while it was told to; a helper that was restarted forgot, so tell it again.
let watching = false;
input.events.on('ready', () => {
  if (watching) input.request({ op: 'watchWindows', on: true }).catch((err) => swallow('[system] could not resume the window watch', err));
});

const state = ({ level, muted }) => ({ level, muted });

module.exports = {
  warmUp: () => input.warmUp(),
  stop: () => input.stop(),

  pressKeys: (vks) => input.request({ op: 'keys', vks }),

  // default playback device (the volume strip)
  getVolume: () => input.request({ op: 'getVolume' }).then(state),
  setVolume: (level) => input.request({ op: 'setVolume', level }).then(state),
  setMute: (muted) => input.request({ op: 'setMute', muted }).then(state),
  toggleMute: () => input.request({ op: 'toggleMute' }).then(state),

  // the default microphone (header button)
  mic: () => input.request({ op: 'getMic' }).then(({ available, muted }) => ({ available, muted })),
  setMic: (muted) => input.request({ op: 'setMic', toggle: muted === 'toggle', muted: muted === true }).then(({ available, muted: now }) => ({ available, muted: now })),

  // devices and per-application mixer
  devices: () => input.request({ op: 'devices' }).then(({ playback, capture }) => ({ playback, capture })),
  setDefaultDevice: (deviceId) => input.request({ op: 'setDefaultDevice', deviceId }),
  setDeviceVolume: (deviceId, level) => input.request({ op: 'setDeviceVolume', deviceId, level }),
  setDeviceMute: (deviceId, muted) => input.request({ op: 'setDeviceMute', deviceId, muted }),
  sessions: () => input.request({ op: 'sessions' }).then(({ sessions }) => sessions),
  setSessionVolume: (pid, system, level) => input.request({ op: 'setSessionVolume', pid, system, level }),
  setSessionMute: (pid, system, muted) => input.request({ op: 'setSessionMute', pid, system, muted }),

  // which apps are running / have a window, and bringing one to the front
  windows: () => input.request({ op: 'windows' }).then(({ running, windows }) => ({ running, windows })),
  focus: (name) => input.request({ op: 'focus', name }).then(({ focused }) => focused),

  // window management (by handle, validated against the live window list by the helper)
  // push: with the native helper, changes to the windows arrive as events (no polling); rejects with the PowerShell helper
  watchWindows: (on) => input.request({ op: 'watchWindows', on }).then((reply) => { watching = Boolean(on); return reply; }),
  onWindowsChanged: (callback) => { input.events.on('windows', callback); return () => input.events.off('windows', callback); },

  windowAction: (handle, action) => input.request({ op: 'windowAction', handle, action }),
  moveWindow: (handle, monitor) => input.request({ op: 'moveWindow', handle, monitor }),
  placeWindow: (handle, x, y) => input.request({ op: 'placeWindow', handle, x, y }),
  snapWindow: (handle, monitor, zone) => input.request({ op: 'snapWindow', handle, monitor, zone }),

  // screens: geometry, DDC/CI brightness, power
  monitors: (brightness = false) => input.request({ op: 'monitors', brightness }, 15000).then(({ monitors }) => monitors),
  setBrightness: (device, level) => input.request({ op: 'setBrightness', device, level }, 15000),
  screensOff: () => input.request({ op: 'screensOff' }),
};
