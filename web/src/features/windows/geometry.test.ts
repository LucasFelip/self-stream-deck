import { describe, expect, it } from 'vitest';
import { predict, restoredRect, workArea, type ScreenBox, type WindowLike } from './geometry';

// Numbers match the old interface's tests (this PC): screen 1 at (0,0), screen 2 at (-1920,0), both 1920x1080, a 32 px taskbar at the bottom.
const screens: ScreenBox[] = [
  { left: 0, top: 0, width: 1920, height: 1080 },
  { left: -1920, top: 0, width: 1920, height: 1080 },
];
const win = (over: Partial<WindowLike> = {}): WindowLike => ({ handle: 1, x: 300, y: 200, w: 960, h: 700, state: 0, monitor: 0, ...over });
const ctx = (windows: WindowLike[] = [], saved: { x: number; y: number; w: number; h: number } | null = null) => ({ screens, windows, saved });

describe('workArea', () => {
  it('is the screen when nothing is maximized there', () => {
    expect(workArea(screens, [], 1)).toEqual({ x: -1920, y: 0, w: 1920, h: 1080 });
  });

  it('borrows the exact rectangle of a maximized window (screen minus taskbar)', () => {
    const maximized = win({ handle: 9, state: 2, monitor: 0, x: 0, y: 0, w: 1920, h: 1048 });
    expect(workArea(screens, [maximized], 0)).toEqual({ x: 0, y: 0, w: 1920, h: 1048 });
    expect(workArea(screens, [maximized], 1)).toEqual({ x: -1920, y: 0, w: 1920, h: 1080 }); // another screen: unaffected
  });
});

describe('predict: actions', () => {
  it('minimize only changes the state', () => {
    expect(predict(ctx(), win(), { action: 'minimize' })).toEqual({ state: 1 });
  });

  it("maximize fills the work area of the window's own screen", () => {
    const other = win({ handle: 9, state: 2, monitor: 1, x: -1920, y: 0, w: 1920, h: 1048 });
    expect(predict(ctx([other]), win({ monitor: 1 }), { action: 'maximize' })).toEqual({ state: 2, x: -1920, y: 0, w: 1920, h: 1048 });
  });

  it('restore puts back the remembered rectangle', () => {
    const saved = { x: 300, y: 200, w: 960, h: 700 };
    expect(predict(ctx([], saved), win({ state: 2, x: 0, y: 0, w: 1920, h: 1048 }), { action: 'restore' })).toEqual({ state: 0, ...saved });
  });

  it('restore without a memory centers a 60% x 70% block', () => {
    expect(restoredRect(null, { x: 0, y: 0, w: 1000, h: 800 })).toEqual({ x: 200, y: 120, w: 600, h: 560 });
  });

  it('focus on a minimized window brings it back, on a normal one changes nothing', () => {
    const saved = { x: 10, y: 20, w: 400, h: 300 };
    expect(predict(ctx([], saved), win({ state: 1 }), { action: 'focus' })).toEqual({ state: 0, ...saved });
    expect(predict(ctx(), win(), { action: 'focus' })).toEqual({});
  });

  it('an unknown action predicts nothing', () => {
    expect(predict(ctx(), win(), { action: 'close' })).toBeNull();
  });
});

describe('predict: snap', () => {
  it('left / right take the two halves of the work area', () => {
    const taskbar = win({ handle: 9, state: 2, monitor: 0, x: 0, y: 0, w: 1920, h: 1048 });
    expect(predict(ctx([taskbar]), win(), { snap: { monitor: 0, zone: 'left' } })).toEqual({ state: 0, monitor: 0, x: 0, y: 0, w: 960, h: 1048 });
    expect(predict(ctx([taskbar]), win(), { snap: { monitor: 0, zone: 'right' } })).toEqual({ state: 0, monitor: 0, x: 960, y: 0, w: 960, h: 1048 });
  });

  it("to the left half of the OTHER screen uses that screen's coordinates", () => {
    expect(predict(ctx(), win(), { snap: { monitor: 1, zone: 'left' } })).toEqual({ state: 0, monitor: 1, x: -1920, y: 0, w: 960, h: 1080 });
  });

  it('full maximizes on the target screen', () => {
    expect(predict(ctx(), win(), { snap: { monitor: 1, zone: 'full' } })).toEqual({ state: 2, monitor: 1, x: -1920, y: 0, w: 1920, h: 1080 });
  });

  it('an odd work area width gives the extra pixel to the right half', () => {
    const odd: ScreenBox[] = [{ left: 0, top: 0, width: 1001, height: 500 }];
    expect(predict({ screens: odd, windows: [], saved: null }, win(), { snap: { monitor: 0, zone: 'right' } })).toEqual({ state: 0, monitor: 0, x: 500, y: 0, w: 501, h: 500 });
  });
});

describe('predict: move to another screen', () => {
  it('a maximized window is maximized there', () => {
    expect(predict(ctx(), win({ state: 2, x: 0, y: 0, w: 1920, h: 1048 }), { move: { monitor: 1 } })).toEqual({ monitor: 1, x: -1920, y: 0, w: 1920, h: 1080 });
  });

  it('a normal window keeps its relative position', () => {
    const moved = predict(ctx(), win({ x: 480, y: 270, w: 800, h: 400 }), { move: { monitor: 1 } });
    expect(moved).toMatchObject({ monitor: 1, x: -1920 + 480, y: 270, w: 800 });
  });

  it('never leaves the window off the target screen', () => {
    const moved = predict(ctx(), win({ x: 1800, y: 1000, w: 900, h: 500 }), { move: { monitor: 1 } });
    expect(moved).not.toBeNull();
    const { x = 0, y = 0, w = 0, h = 0 } = moved ?? {};
    expect(x + w).toBeLessThanOrEqual(0);
    expect(y + h).toBeLessThanOrEqual(1080);
    expect(x).toBeGreaterThanOrEqual(-1920);
    expect(y).toBeGreaterThanOrEqual(0);
  });

  it('shrinks a window bigger than the target screen to fit', () => {
    const small: ScreenBox[] = [{ left: 0, top: 0, width: 1920, height: 1080 }, { left: -1280, top: 0, width: 1280, height: 720 }];
    const moved = predict({ screens: small, windows: [], saved: null }, win({ w: 1800, h: 1000 }), { move: { monitor: 1 } });
    expect(moved).toMatchObject({ w: 1280, h: 720 });
  });
});
