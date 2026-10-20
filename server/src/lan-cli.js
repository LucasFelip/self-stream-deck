'use strict';

// Turns the Wi-Fi (home network) access on or off and shows how to pair a phone.
//   npm run lan -- on       allow phones on the home network (restart the server afterwards)
//   npm run lan -- off      back to this PC and USB only; removes the firewall rule
//   npm run lan -- status   what is on, the rule, the certificate fingerprint and the pairing links
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');
const firewall = require('./firewall');
const tls = require('./tls');
const { homeAddresses } = require('./addresses');

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const read = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, ''));
const write = (config) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

async function main() {
  const command = process.argv[2] || 'status';
  const config = read();

  if (command === 'on' || command === 'off') {
    config.lan = command === 'on';
    write(config);
    if (command === 'off') await firewall.remove();
    console.log(command === 'on'
      ? 'Wi-Fi access is ON in config.json. Restart the server (end its process: the supervisor starts it again) and run "npm run lan -- status".'
      : 'Wi-Fi access is OFF and the firewall rule was removed. Restart the server.');
    return;
  }

  if (command !== 'status') {
    console.log('usage: npm run lan -- on | off | status');
    process.exit(1);
  }

  const port = config.httpsPort || 7879;
  console.log(`Wi-Fi access: ${config.lan ? 'ON' : 'off'} (HTTPS port ${port})`);
  console.log(`Firewall rule: ${await firewall.status() === 'none' ? 'none' : `TCP ${await firewall.status()}`}`);
  if (!config.lan) return;
  const material = await tls.ensure();
  console.log(`Certificate fingerprint (SHA-256): ${material.fingerprint}\nExpires: ${material.expires.toISOString().slice(0, 10)}`);
  console.log('\nPairing links (the app pins the certificate through "fp"):');
  for (const ip of homeAddresses()) console.log(`  https://${ip}:${port}/?token=${config.token}&fp=${material.fingerprint}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
