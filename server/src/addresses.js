'use strict';

const os = require('node:os');

// Adapters that exist only inside this PC (virtual switches, containers, VPNs): a phone on the home network never reaches them.
const VIRTUAL = /vethernet|wsl|docker|hyper-v|vmware|virtualbox|vbox|loopback|bluetooth|tailscale|zerotier|tap-|npcap|host-only/i;
const HOME_RANGE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** This PC's IPv4 addresses on the home network (private ranges, real adapters only), without duplicates. */
function homeAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal && HOME_RANGE.test(iface.address) && !found.includes(iface.address)) found.push(iface.address);
    }
  }
  return found;
}

module.exports = { homeAddresses };
