import { describe, expect, it } from 'vitest';
import type { Win } from './geometry';
import { BRIGHT_H, bare, computeLayout, metaText, monitorAt, normalRect, onMap, signatureOf, toMap, updateSeen, zoneAt } from './model';

const win = (over: Partial<Win> = {}): Win => ({ handle: 1, title: 't', app: 'App', appId: null, iconVersion: '', state: 0, monitor: 0, x: 0, y: 0, w: 100, h: 100, ...over });
const screens = [{ left: 0, top: 0, width: 1920, height: 1080 }, { left: -1920, top: 0, width: 1920, height: 1080 }];

describe('computeLayout', () => {
  it('fits the bounding box of every screen, to scale, leaving room for the brightness sliders', () => {
    const layout = computeLayout(screens, { width: 1200, height: 300 + BRIGHT_H + 6 });
    expect(layout).not.toBeNull();
    expect(layout?.minX).toBe(-1920);
    expect(layout?.scale).toBeCloseTo(300 / 1080, 5); // limited by the height: 3840x1080 into 760x300
    expect(layout?.width).toBeCloseTo(3840 * (300 / 1080), 3);
    expect(layout?.height).toBeCloseTo(300, 3);
  });

  it('is null without screens or without room (the pane is hidden: drawing at size 0 would empty the map)', () => {
    expect(computeLayout([], { width: 500, height: 500 })).toBeNull();
    expect(computeLayout(screens, { width: 0, height: 500 })).toBeNull();
    expect(computeLayout(screens, { width: 500, height: BRIGHT_H })).toBeNull();
  });
});

describe('screen and zone under a point', () => {
  const layout = computeLayout(screens, { width: 384, height: 108 + BRIGHT_H + 6 }); // scale 0.1
  if (!layout) throw new Error('layout');

  it('maps real pixels to the map', () => {
    expect(toMap(layout, 0, 0)).toEqual({ left: 192, top: 0 });
    expect(toMap(layout, -1920, 540)).toEqual({ left: 0, top: 54 });
  });

  it('finds the screen, or -1 outside', () => {
    expect(monitorAt(screens, layout, 250, 50)).toBe(0);
    expect(monitorAt(screens, layout, 50, 50)).toBe(1);
    expect(monitorAt(screens, layout, 250, 120)).toBe(-1);
  });

  it('top strip maximizes, side strips take a half, the middle is a plain move', () => {
    expect(zoneAt(screens, layout, 0, 290, 5)).toBe('full'); // 14% of the height
    expect(zoneAt(screens, layout, 0, 195, 60)).toBe('left'); // 18% of the width
    expect(zoneAt(screens, layout, 0, 380, 60)).toBe('right');
    expect(zoneAt(screens, layout, 0, 290, 60)).toBeNull();
    expect(zoneAt(screens, layout, -1, 290, 60)).toBeNull();
  });
});

describe('the windows on the map and their order', () => {
  it('draws the ones that are not minimized and have a size, bottom of the stack first', () => {
    const list = [win({ handle: 3 }), win({ handle: 2, state: 1 }), win({ handle: 1, w: 0 }), win({ handle: 0 })];
    expect(onMap(list).map((w) => w.handle)).toEqual([0, 3]);
  });

  it('updateSeen: windows that were there keep their place, new ones come first in stack order, gone ones leave', () => {
    const first = updateSeen([], [win({ handle: 1 }), win({ handle: 2 })]);
    expect(first).toEqual([1, 2]);
    // 5 is on top of the stack now, 3 just appeared below it, 2 is gone, 1 was raised
    const next = updateSeen(first, [win({ handle: 5 }), win({ handle: 1 }), win({ handle: 3 })]);
    expect(next).toEqual([5, 3, 1]);
  });
});

describe('signatures, remembered rectangle and meta', () => {
  it('a title that only changes its leading spinner glyph is not a change', () => {
    expect(bare('⠋ Terminal')).toBe('Terminal');
    expect(signatureOf([win({ title: '⠋ build' })])).toBe(signatureOf([win({ title: '⠙ build' })]));
    expect(signatureOf([win({ title: 'a' })])).not.toBe(signatureOf([win({ title: 'b' })]));
    expect(signatureOf([win({ x: 1 })])).not.toBe(signatureOf([win({ x: 2 })]));
  });

  it('normalRect only remembers a normal window with a size', () => {
    expect(normalRect(win({ x: 5, y: 6, w: 7, h: 8 }))).toEqual({ x: 5, y: 6, w: 7, h: 8 });
    expect(normalRect(win({ state: 2 }))).toBeNull();
    expect(normalRect(win({ w: 0 }))).toBeNull();
  });

  it('metaText: the app, the state and, with several screens, which one', () => {
    expect(metaText(win({ app: 'Editor' }), 1)).toBe('Editor');
    expect(metaText(win({ app: 'Editor', state: 2, monitor: 1 }), 2)).toBe('Editor · maximizada · Tela 2');
    expect(metaText(win({ app: '', state: 1 }), 2)).toBe('minimizada · Tela 1');
  });
});
