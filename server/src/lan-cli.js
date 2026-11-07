'use strict';

// Turns the Wi-Fi (home network) access on or off and shows how to pair a phone.
//   npm run lan -- on       allow phones on the home network (restart the server afterwards)
//   npm run lan -- off      back to this PC and USB only; removes the firewall rule
//   npm run lan -- status   what is on, the rule, the certificate fingerprint and the pairing links
//   npm run lan -- ios on|off|status   the same for an iPhone (Safari): its own HTTPS port, a certificate authority to install once
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');
const firewall = require('./firewall');
const tls = require('./tls');
const tlsIos = require('./tls-ios');
const ios = require('./ios');
const { homeAddresses } = require('./addresses');

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const read = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
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

  if (command === 'ios') {
    const action = process.argv[3] || 'status';
    if (action === 'on' || action === 'off') {
      config.ios = action === 'on';
      write(config);
      if (action === 'off') await firewall.remove(firewall.RULE_IOS);
      console.log(action === 'on'
        ? 'iPhone access is ON in config.json. Restart the server (end its process: the supervisor starts it again) and run "npm run lan -- ios".'
        : 'iPhone access is OFF and its firewall rule was removed. Restart the server.');
      return;
    }
    if (action !== 'status') {
      console.log('usage: npm run lan -- ios on | off | status');
      process.exit(1);
    }
    const iosConfig = { iosPort: 7880, iosCaPort: 7881, ...config };
    console.log(`iPhone access: ${config.ios ? 'ON' : 'off'} (HTTPS port ${iosConfig.iosPort}, certificate on HTTP port ${iosConfig.iosCaPort})`);
    const rule = await firewall.status(firewall.RULE_IOS);
    console.log(`Firewall rule: ${rule === 'none' ? 'none' : `TCP ${rule}`}`);
    if (!config.ios) return;
    const material = await tlsIos.ensure();
    const { names, ips } = material.covered;
    console.log(`Certificate authority fingerprint (SHA-256): ${material.caFingerprint}\nServer certificate covers: ${[...names, ...ips].join(', ')} (expires ${material.expires.toISOString().slice(0, 10)})`);
    const shown = ios.links(iosConfig);
    console.log('\n1. On the iPhone, open this in Safari and install the certificate (compare the fingerprint on that page with the one above):');
    for (const link of shown.install) console.log(`   ${link}`);
    console.log('   Then: Settings > Profile Downloaded > Install; Settings > General > About > Certificate Trust Settings > turn it on.');
    console.log('\n2. Open the deck in Safari, then Share > Add to Home Screen:');
    for (const link of shown.pair) console.log(`   ${link}`);
    return;
  }

  if (command !== 'status') {
    console.log('usage: npm run lan -- on | off | status | ios [on|off|status]');
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
