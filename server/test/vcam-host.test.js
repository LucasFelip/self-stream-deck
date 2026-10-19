'use strict';

// scripts/vcam-host.ps1 against a stand-in for the UnityCapture filter (test/fake-vcam-filter.ps1): a JPEG goes in, the
// right pixels (RGBA, not BGRA) come out in the shared memory. Needs Windows PowerShell; skipped elsewhere.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

if (process.platform !== 'win32') { console.log('skipped (not Windows)'); process.exit(0); }

const { execFileSync } = require('node:child_process');
const os = require('node:os');

// a picture whose top half is red and bottom half blue: tells right side up from upside down
const flipFile = path.join(os.tmpdir(), 'ssd-flip-test.jpg');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap 64,64; $g = [System.Drawing.Graphics]::FromImage($b); " +
  "$g.FillRectangle([System.Drawing.Brushes]::Red,0,0,64,32); $g.FillRectangle([System.Drawing.Brushes]::Blue,0,32,64,32); " +
  "$b.Save('" + flipFile + "', [System.Drawing.Imaging.ImageFormat]::Jpeg)"], { windowsHide: true });
const jpeg = fs.readFileSync(flipFile);
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

(async () => {
  const filter = ps(path.join(__dirname, 'fake-vcam-filter.ps1'));
  const filterLine = lines(filter);
  const first = await filterLine();
  if (first === 'BUSY') { console.log('skipped (a real app is using the camera right now)'); fs.rmSync(flipFile, { force: true }); process.exit(0); }
  assert.strictEqual(first, 'READY');

  const helper = ps(path.join(__dirname, '..', 'scripts', 'vcam-host.ps1'));
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
  assert.ok(r < 40 && g < 40 && b > 200, `first row is not the picture's bottom (blue) in RGBA order: ${got.pixel}`);
  assert.strictEqual(a, 255);
  console.log('ok     a JPEG frame arrives in the shared memory bottom-up, as RGBA, with the right size');
  fs.rmSync(flipFile, { force: true });

  // length 0 asks the helper to quit
  helper.stdin.end(Buffer.alloc(4));
  await new Promise((resolve) => helper.on('exit', resolve));
  clearTimeout(timer);
  console.log('ok     the helper exits when asked');
  console.log('\n2 passed');
  process.exit(0);
})().catch((err) => { console.log(err); process.exit(1); });
