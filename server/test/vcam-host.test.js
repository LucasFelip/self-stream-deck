'use strict';

// The virtual camera feeders (scripts/vcam-host.ps1 and the native "vcam" mode) against a stand-in for the UnityCapture
// filter (test/fake-vcam-filter.ps1): a JPEG goes in, the right pixels (RGBA, bottom-up) come out in the shared memory.
// Needs Windows; skipped elsewhere or while a real app has the camera open.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

if (process.platform !== 'win32') { console.log('skipped (not Windows)'); process.exit(0); }

// a picture whose top half is red and bottom half blue: tells right side up from upside down
const flipFile = path.join(os.tmpdir(), 'ssd-flip-test.jpg');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap 64,64; $g = [System.Drawing.Graphics]::FromImage($b); " +
  "$g.FillRectangle([System.Drawing.Brushes]::Red,0,0,64,32); $g.FillRectangle([System.Drawing.Brushes]::Blue,0,32,64,32); " +
  "$b.Save('" + flipFile + "', [System.Drawing.Imaging.ImageFormat]::Jpeg)"], { windowsHide: true });
const jpeg = fs.readFileSync(flipFile);
fs.rmSync(flipFile, { force: true });

const ps = (file) => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });

const lines = (child) => {
  const queue = [];
  const waiting = [];
  let buffered = '';
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, at).trim();
      buffered = buffered.slice(at + 1);
      if (waiting.length) waiting.shift()(line); else queue.push(line);
    }
  });
  return () => new Promise((resolve) => (queue.length ? resolve(queue.shift()) : waiting.push(resolve)));
};

let passed = 0;

async function check(label, startHelper) {
  const filter = ps(path.join(__dirname, 'fake-vcam-filter.ps1'));
  const filterLine = lines(filter);
  const first = await filterLine();
  if (first === 'BUSY') { console.log('skipped (a real app is using the camera right now)'); process.exit(0); }
  assert.strictEqual(first, 'READY');

  const helper = startHelper();
  const timer = setTimeout(() => { helper.kill(); filter.kill(); console.log('TIMEOUT'); process.exit(1); }, 60000);
  const header = Buffer.alloc(4);
  header.writeInt32LE(jpeg.length);
  helper.stdin.write(Buffer.concat([header, jpeg]));

  const got = JSON.parse(await filterLine());
  assert.strictEqual(got.width, 64);
  assert.strictEqual(got.height, 64);
  assert.strictEqual(got.stride, 64, 'stride is in pixels');
  assert.strictEqual(got.format, 0);
  assert.strictEqual(got.resize, 1);
  // memory starts with the BOTTOM row of the picture (blue), and as RGBA: R first, A opaque
  const [r, g, b, a] = got.pixel;
  assert.ok(r < 40 && g < 40 && b > 200, `${label}: first row is not the picture's bottom (blue) in RGBA order: ${got.pixel}`);
  assert.strictEqual(a, 255);
  passed += 1;
  console.log(`ok     ${label}: a JPEG frame arrives in the shared memory bottom-up, as RGBA, with the right size`);

  // length 0 asks the helper to quit
  helper.stdin.end(Buffer.alloc(4));
  await new Promise((resolve) => helper.on('exit', resolve));
  clearTimeout(timer);
  if (filter.exitCode === null) {
    filter.kill();
    await new Promise((resolve) => filter.on('exit', resolve));
  }
  passed += 1;
  console.log(`ok     ${label}: the helper exits when asked`);
}

(async () => {
  await check('PowerShell helper', () => ps(path.join(__dirname, '..', 'scripts', 'vcam-host.ps1')));
  const exe = await require('../src/native').ensure();
  if (exe) await check('native helper', () => spawn(exe, ['vcam'], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] }));
  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((err) => { console.log(err); process.exit(1); });
