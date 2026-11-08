import { describe, expect, it } from 'vitest';
import { END, appsLayout, appsLayoutUpright, arranged, measure, paginate, reorder } from './layout';

const metrics = (width: number, height: number) => ({ width, height, safeLeft: 0, safeRight: 0, safeBottom: 0 });

describe('measure', () => {
  it('fits as many rows as the height allows and as many square-ish columns as the width allows', () => {
    const base = measure(metrics(764, 387)); // 836x387 with the 72 px rail
    expect(base.rows).toBe(3);
    expect(base.cols).toBeGreaterThanOrEqual(5);
    expect(base.tileH).toBeCloseTo((387 - 24 - 20) / 3, 5);
    expect(base.icon).toBeGreaterThanOrEqual(32);
    expect(base.icon).toBeLessThanOrEqual(64);
  });

  it('keeps clear of the camera cut-out and the bottom inset, and never goes under 1 row and 2 columns', () => {
    const plain = measure(metrics(411, 814));
    const cut = measure({ ...metrics(411, 814), safeLeft: 40, safeRight: 40, safeBottom: 30 });
    expect(cut.width).toBe(plain.width - 80);
    expect(cut.height).toBe(plain.height - 30);
    const tiny = measure(metrics(60, 60));
    expect(tiny.rows).toBe(1);
    expect(tiny.cols).toBe(2);
  });
});

describe('appsLayout', () => {
  const portrait = measure(metrics(411, 814));
  const landscape = measure(metrics(764, 387));

  it('portrait: the normal grid while every key (plus the free slot) fits', () => {
    const fit = appsLayoutUpright(4, portrait);
    expect(fit.mode).toBe('normal');
    expect(fit.cols * fit.rows).toBeGreaterThanOrEqual(5);
  });

  it('portrait: with more keys, the column count that gives the biggest keys, in a compact fit that holds them all', () => {
    for (const count of [24, 30]) {
      const fit = appsLayoutUpright(count, portrait);
      expect(fit.mode).toBe('fit');
      expect(fit.cols * fit.rows).toBeGreaterThanOrEqual(count + 1);
      expect(fit.w).toBeGreaterThanOrEqual(44);
      expect(fit.h).toBeGreaterThanOrEqual(60);
    }
  });

  it('too many keys to read: back to the normal grid, scrolling', () => {
    const fit = appsLayoutUpright(150, portrait);
    expect(fit.mode).toBe('scroll');
    expect(fit.rows).toBeGreaterThanOrEqual(Math.ceil(151 / fit.cols));
  });

  it('landscape: a fixed 7 x 3, more rows for more keys', () => {
    expect(appsLayout(10, landscape, true)).toMatchObject({ mode: 'fit', cols: 7, rows: 3 });
    expect(appsLayout(30, landscape, true)).toMatchObject({ cols: 7, rows: 5 });
  });

  it('landscape: the keys of a very short screen scroll instead of shrinking under 60 px', () => {
    expect(appsLayout(30, measure(metrics(700, 300)), true).mode).toBe('scroll');
  });
});

describe('order', () => {
  const items = ['a', 'b', 'c', 'd'].map((key) => ({ key }));

  it('arranged: saved keys first in the saved order, the others after in their natural order', () => {
    expect(arranged(['c', 'a'], items).map((i) => i.key)).toEqual(['c', 'a', 'b', 'd']);
    expect(arranged(['zzz', 'd'], items).map((i) => i.key)).toEqual(['d', 'a', 'b', 'c']);
    expect(arranged(undefined, items).map((i) => i.key)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('paginate', () => {
    expect(paginate([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(paginate([], 4)).toEqual([]);
    expect(paginate([1, 2], 0)).toEqual([[1], [2]]);
  });

  it('reorder: onto another key swaps the two; onto an empty slot goes to the end; onto itself or nothing known changes nothing', () => {
    const keys = ['a', 'b', 'c', 'd'];
    expect(reorder(keys, 'a', 'd')).toEqual(['d', 'b', 'c', 'a']);
    expect(reorder(keys, 'b', END)).toEqual(['a', 'c', 'd', 'b']);
    expect(reorder(keys, 'd', END)).toEqual(['a', 'b', 'c', 'd']);
    expect(reorder(keys, 'a', 'a')).toEqual(keys);
    expect(reorder(keys, 'x', 'a')).toEqual(keys);
    expect(reorder(keys, 'a', 'x')).toEqual(keys);
  });
});
