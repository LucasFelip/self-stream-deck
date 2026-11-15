import { describe, expect, it } from 'vitest';
import { contrast } from '../lib/contrast';
import pages from './pages.css?raw';
import style from './style.css?raw';

const css = style + pages;

/** The `--name: #rrggbb` colors of the `:root` block. */
function tokens(): Record<string, string> {
  // every `:root { ... }` block of both files
  const roots = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]!).join(' ');
  return Object.fromEntries([...roots.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]));
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
