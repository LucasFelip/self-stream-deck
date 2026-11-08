'use strict';

// Draws the app icons (public/icons/*.png) with no dependencies: a dark square with a 3x3 grid of keys, one of them lit.
// Run by hand when the design changes: node scripts/make-icons.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');
const SIZES = { 'apple-touch-icon.png': 180, 'icon-192.png': 192, 'icon-512.png': 512 };

const BG = [11, 12, 16];
const KEY = [38, 42, 56];
const LIT = [59, 130, 246];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

/** How much of the pixel centred at (x, y) lies inside a rounded rectangle (0..1, soft edge one pixel wide). */
function coverage(x, y, rect) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const qx = Math.abs(x - cx) - (rect.w / 2 - rect.r);
  const qy = Math.abs(y - cy) - (rect.h / 2 - rect.r);
  const distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rect.r;
  return Math.min(1, Math.max(0, 0.5 - distance));
}

function render(size) {
  const margin = size * 0.17;
  const gap = size * 0.05;
  const cell = (size - 2 * margin - 2 * gap) / 3;
  const keys = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      keys.push({ x: margin + col * (cell + gap), y: margin + row * (cell + gap), w: cell, h: cell, r: cell * 0.22, color: row === 1 && col === 1 ? LIT : KEY });
    }
  }
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      let pixel = BG;
      for (const key of keys) {
        const a = coverage(x + 0.5, y + 0.5, key);
        if (a > 0) pixel = pixel.map((value, i) => Math.round(value * (1 - a) + key.color[i] * a));
      }
      raw.set(pixel, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bit, RGB, no interlace
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size] of Object.entries(SIZES)) {
  fs.writeFileSync(path.join(OUT, name), render(size));
  console.log(`${name} ${size}x${size}`);
}
