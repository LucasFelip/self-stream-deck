import { describe, expect, it } from 'vitest';
import { contrast } from '../../lib/contrast';
import { ACCENTS, DEFAULT_LOOK, SIZES, applyLook, parseLook, rgbTriple } from './appearance';

describe('the choices', () => {
  it('every accent reads on the page and on a card at 4.5:1 or better, and no two are the same', () => {
    for (const accent of ACCENTS) {
      expect(contrast(accent.hex, '#0b0c10'), accent.id).toBeGreaterThanOrEqual(4.5);
      expect(contrast(accent.hex, '#12141a'), accent.id).toBeGreaterThanOrEqual(4.5);
    }
    expect(new Set(ACCENTS.map((a) => a.hex)).size).toBe(ACCENTS.length);
  });

  it('the text sizes stay within what the layout tests hold (about 10 % either way) and Normal is exactly 1', () => {
    expect(SIZES.find((s) => s.id === 'm')!.scale).toBe(1);
    for (const size of SIZES) {
      expect(size.scale).toBeGreaterThanOrEqual(0.9);
      expect(size.scale).toBeLessThanOrEqual(1.15);
    }
  });

  it('the default accent is the panel\'s own blue', () => {
    expect(ACCENTS.find((a) => a.id === DEFAULT_LOOK.accent)!.hex).toBe('#7c9cff');
  });
});

describe('parseLook', () => {
  it('reads what was stored and falls back to the default for each part that is not a known choice', () => {
    expect(parseLook('{"accent":"verde","size":"g"}')).toEqual({ accent: 'verde', size: 'g' });
    expect(parseLook('{"accent":"verde"}')).toEqual({ accent: 'verde', size: 'm' });
    expect(parseLook('{"accent":"#ff0000","size":"huge"}')).toEqual(DEFAULT_LOOK);
    expect(parseLook('not json')).toEqual(DEFAULT_LOOK);
    expect(parseLook(null)).toEqual(DEFAULT_LOOK);
  });
});

describe('applyLook', () => {
  it('sets the accent, its r, g, b form and the text size on the root', () => {
    const root = document.createElement('html');
    applyLook({ accent: 'verde', size: 'g' }, root);
    expect(root.style.getPropertyValue('--accent')).toBe('#4cc38a');
    expect(root.style.getPropertyValue('--accent-rgb')).toBe('76, 195, 138');
    expect(root.style.fontSize).toBe('112%');
    applyLook(DEFAULT_LOOK, root);
    expect(root.style.fontSize).toBe('100%');
    expect(rgbTriple('#7c9cff')).toBe('124, 156, 255');
  });
});
