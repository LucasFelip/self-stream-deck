'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const LOCAL_ADB = path.join(__dirname, '..', '..', '.tools', 'platform-tools', 'adb.exe');
const POLL_MS = 4000;
const APP_PACKAGE = 'dev.selfstreamdeck';

function adbPath() {
  return fs.existsSync(LOCAL_ADB) ? LOCAL_ADB : 'adb';
}

function adb(args) {
  return new Promise((resolve, reject) => {
    execFile(adbPath(), args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
  });
}

// "serial\tdevice" lines -> [{ serial, state }]
async function listDevices() {
  const out = await adb(['devices']);
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state)
    .map(([serial, state]) => ({ serial, state }));
}

async function openOnDevice(serial, port, token) {
  // 127.0.0.1 on the phone reaches the PC through the USB tunnel; it also counts as a secure
  // context for the browser, which lets the page keep the screen awake.
  await adb(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
  const url = `http://127.0.0.1:${port}/?token=${token}`;

  // Prefer the dedicated app when it is installed (full screen, no browser chrome).
  const packages = await adb(['-s', serial, 'shell', 'pm', 'list', 'packages', APP_PACKAGE]);
  if (packages.includes(`package:${APP_PACKAGE}`)) {
    await adb(['-s', serial, 'shell', 'am', 'start', '-n', `${APP_PACKAGE}/.MainActivity`, '--es', 'url', `'${url}'`]);
    return 'app';
  }
  await adb(['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${url}'`]);
  return 'browser';
}

/**
 * Watches for a USB-debugging phone and opens the deck in its browser each time it is plugged in.
 */
function watch({ port, token }) {
  const opened = new Set();
  const warned = new Set();
  let adbMissing = false;

  async function tick() {
    let devices;
    try {
      devices = await listDevices();
    } catch (err) {
      if (!adbMissing) console.warn(`[phone] adb unavailable: ${err.message}`);
      adbMissing = true;
      return;
    }
    adbMissing = false;

    const present = new Set(devices.map((d) => d.serial));
    for (const serial of opened) if (!present.has(serial)) opened.delete(serial);

    for (const { serial, state } of devices) {
      if (state === 'unauthorized') {
        if (!warned.has(serial)) console.warn(`[phone] ${serial}: accept the "Allow USB debugging" prompt on the phone`);
        warned.add(serial);
        continue;
      }
      warned.delete(serial);
      if (state !== 'device' || opened.has(serial)) continue;

      opened.add(serial);
      try {
        const target = await openOnDevice(serial, port, token);
        console.log(`[phone] deck opened on ${serial} (${target})`);
      } catch (err) {
        opened.delete(serial);
        console.warn(`[phone] could not open on ${serial}: ${err.message}`);
      }
    }
  }

  console.log('[phone] waiting for a phone with USB debugging enabled...');
  tick();
  return setInterval(tick, POLL_MS);
}

module.exports = { watch };
