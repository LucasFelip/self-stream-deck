import { describe, expect, it } from 'vitest';
import pages from './pages.css?raw';
import style from './style.css?raw';

const css = style + pages;

/** The `--name: #rrggbb` colors of the `:root` block. */
function tokens(): Record<string, string> {
  // every `:root { ... }` block of both files
  const roots = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]!).join(' ');
  return Object.fromEntries([...roots.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]));
}

/** WCAG relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('the colors of the readings', () => {
  const t = tokens();
  const readings = ['c-cpu', 'c-mem', 'c-gpu', 'c-disk', 'c-net', 'c-net-up'];

  it('are all defined and different from each other', () => {
    for (const name of readings) expect(t[name], name).toBeDefined();
    expect(new Set(readings.map((name) => t[name])).size).toBe(readings.length);
  });

  it('read on the page and on a card at 4.5:1 or better (they color titles and numbers)', () => {
    for (const name of readings) {
      expect(contrast(t[name]!, t.bg!), `${name} on the page`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t[name]!, t.surface!), `${name} on a card`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the alert colors still stand out from the colors of the readings', () => {
    // a reading's own color must not be mistaken for an alert: the warning and the error are never one of them
    for (const name of readings) {
      expect(t[name]).not.toBe(t.err);
      expect(t[name]).not.toBe(t.warn);
    }
  });
});
