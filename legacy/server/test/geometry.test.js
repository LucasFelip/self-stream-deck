'use strict';

// Unit tests for the window geometry the Janelas page uses to show an action's result before the PC answers.
// Numbers match this PC: screen 1 at (0,0), screen 2 at (-1920,0), both 1920x1080, a 32 px taskbar at the bottom.

const assert = require('node:assert/strict');
const path = require('node:path');
const { workArea, restoredRect, predict } = require(path.join(__dirname, '..', 'public', 'js', 'geometry.js'));

const screens = [
  { left: 0, top: 0, width: 1920, height: 1080 },
  { left: -1920, top: 0, width: 1920, height: 1080 },
];
const win = (over) => ({ handle: 1, x: 300, y: 200, w: 960, h: 700, state: 0, monitor: 0, ...over });
const ctx = (windows = [], saved = null) => ({ screens, windows, saved });

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok     ${name}`);
  } catch (err) {
    console.log(`FAILED ${name}\n${err.message}`);
    process.exitCode = 1;
  }
}

test('work area is the screen when nothing is maximized there', () => {
  assert.deepEqual(workArea(screens, [], 1), { x: -1920, y: 0, w: 1920, h: 1080 });
});

test('work area borrows the exact rectangle of a maximized window (screen minus taskbar)', () => {
  const maximized = win({ handle: 9, state: 2, monitor: 0, x: 0, y: 0, w: 1920, h: 1048 });
  assert.deepEqual(workArea(screens, [maximized], 0), { x: 0, y: 0, w: 1920, h: 1048 });
  assert.deepEqual(workArea(screens, [maximized], 1), { x: -1920, y: 0, w: 1920, h: 1080 }); // another screen: unaffected
});

test('minimize only changes the state', () => {
  assert.deepEqual(predict(ctx(), win(), { action: 'minimize' }), { state: 1 });
});

test('maximize fills the work area of the window\'s own screen', () => {
  const other = win({ handle: 9, state: 2, monitor: 1, x: -1920, y: 0, w: 1920, h: 1048 });
  assert.deepEqual(predict(ctx([other]), win({ monitor: 1 }), { action: 'maximize' }), { state: 2, x: -1920, y: 0, w: 1920, h: 1048 });
});

test('restore puts back the remembered rectangle', () => {
  const saved = { x: 300, y: 200, w: 960, h: 700 };
  assert.deepEqual(predict(ctx([], saved), win({ state: 2, x: 0, y: 0, w: 1920, h: 1048 }), { action: 'restore' }), { state: 0, ...saved });
});

test('restore without a memory centers a 60% x 70% block', () => {
  assert.deepEqual(restoredRect(null, { x: 0, y: 0, w: 1000, h: 800 }), { x: 200, y: 120, w: 600, h: 560 });
});

test('focus on a minimized window brings it back, on a normal one changes nothing', () => {
  const saved = { x: 10, y: 20, w: 400, h: 300 };
  assert.deepEqual(predict(ctx([], saved), win({ state: 1 }), { action: 'focus' }), { state: 0, ...saved });
  assert.deepEqual(predict(ctx(), win(), { action: 'focus' }), {});
});

test('snap left / right take the two halves of the work area', () => {
  const taskbar = win({ handle: 9, state: 2, monitor: 0, x: 0, y: 0, w: 1920, h: 1048 });
  assert.deepEqual(predict(ctx([taskbar]), win(), { snap: { monitor: 0, zone: 'left' } }), { state: 0, monitor: 0, x: 0, y: 0, w: 960, h: 1048 });
  assert.deepEqual(predict(ctx([taskbar]), win(), { snap: { monitor: 0, zone: 'right' } }), { state: 0, monitor: 0, x: 960, y: 0, w: 960, h: 1048 });
});

test('snap to the left half of the OTHER screen uses that screen\'s coordinates', () => {
  assert.deepEqual(predict(ctx(), win(), { snap: { monitor: 1, zone: 'left' } }), { state: 0, monitor: 1, x: -1920, y: 0, w: 960, h: 1080 });
});

test('snap full maximizes on the target screen', () => {
  assert.deepEqual(predict(ctx(), win(), { snap: { monitor: 1, zone: 'full' } }), { state: 2, monitor: 1, x: -1920, y: 0, w: 1920, h: 1080 });
});

test('an odd work area width gives the extra pixel to the right half', () => {
  const odd = [{ left: 0, top: 0, width: 1001, height: 500 }];
  assert.deepEqual(predict({ screens: odd, windows: [], saved: null }, win(), { snap: { monitor: 0, zone: 'right' } }), { state: 0, monitor: 0, x: 500, y: 0, w: 501, h: 500 });
});

test('moving a maximized window to the other screen maximizes it there', () => {
  assert.deepEqual(predict(ctx(), win({ state: 2, x: 0, y: 0, w: 1920, h: 1048 }), { move: { monitor: 1 } }), { monitor: 1, x: -1920, y: 0, w: 1920, h: 1080 });
});

test('moving a normal window keeps its relative position', () => {
  // x=300 of 1920 on screen 1 -> the same fraction on screen 2
  const moved = predict(ctx(), win({ x: 480, y: 270, w: 800, h: 400 }), { move: { monitor: 1 } });
  assert.equal(moved.monitor, 1);
  assert.equal(moved.x, -1920 + 480);
  assert.equal(moved.y, 270);
  assert.equal(moved.w, 800);
});

test('moving a window never leaves it off the target screen', () => {
  const moved = predict(ctx(), win({ x: 1800, y: 1000, w: 900, h: 500 }), { move: { monitor: 1 } });
  assert.ok(moved.x + moved.w <= 0, `right edge ${moved.x + moved.w} should be <= 0`);
  assert.ok(moved.y + moved.h <= 1080, `bottom edge ${moved.y + moved.h} should be <= 1080`);
  assert.ok(moved.x >= -1920 && moved.y >= 0);
});

test('a window bigger than the target screen is shrunk to fit', () => {
  const small = [{ left: 0, top: 0, width: 1920, height: 1080 }, { left: -1280, top: 0, width: 1280, height: 720 }];
  const moved = predict({ screens: small, windows: [], saved: null }, win({ w: 1800, h: 1000 }), { move: { monitor: 1 } });
  assert.equal(moved.w, 1280);
  assert.equal(moved.h, 720);
});

test('an unknown action predicts nothing', () => {
  assert.equal(predict(ctx(), win(), { action: 'close' }), null);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
