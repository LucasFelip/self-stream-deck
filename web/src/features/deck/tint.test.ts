import { describe, expect, it } from 'vitest';
import { colorOf, dominant, triple } from './tint';

const pixel = (r: number, g: number, b: number, a = 255): number[] => [r, g, b, a];

describe('dominant', () => {
  it('is the color the pixels are made of', () => {
    expect(dominant([...pixel(200, 40, 40), ...pixel(200, 40, 40)])).toEqual([200, 40, 40]);
  });

  it('ignores transparent, black, white and gray pixels', () => {
    const ignored = [...pixel(255, 0, 0, 0), ...pixel(10, 10, 10), ...pixel(250, 250, 250), ...pixel(120, 120, 120)];
    expect(dominant(ignored)).toBeNull();
    expect(dominant([...ignored, ...pixel(0, 120, 220)])).toEqual([0, 120, 220]);
  });

  it('lets a small vivid part beat a large dull one', () => {
    const dull = Array.from({ length: 9 }, () => pixel(150, 130, 120)).flat();
    const vivid = pixel(20, 80, 250);
    const [r, , b] = dominant([...dull, ...vivid])!;
    expect(b).toBeGreaterThan(r);
  });

  it('is null for no pixels', () => {
    expect(dominant([])).toBeNull();
  });
});

describe('colorOf', () => {
  it('gives the same color for the same text and different ones for different texts', () => {
    expect(colorOf('Copiar')).toEqual(colorOf('Copiar'));
    expect(colorOf('Copiar')).not.toEqual(colorOf('Colar'));
  });

  it('stays inside 0 to 255, muted (never white or black)', () => {
    for (const text of ['a', 'Ctrl+C', 'Gerenciador de tarefas', 'x'.repeat(40), '']) {
      const rgb = colorOf(text);
      for (const channel of rgb) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
      expect(Math.max(...rgb)).toBeLessThan(250);
      expect(Math.min(...rgb)).toBeGreaterThan(30);
    }
  });

  it('is written as r, g, b for rgba(var(--tint), …)', () => {
    expect(triple([1, 2, 3])).toBe('1, 2, 3');
  });
});
