import { describe, expect, it } from 'vitest';
import { ambientOf } from './ambient';

const at = (h: number, m: number): Date => new Date(2026, 10, 15, h, m, 0);

describe('ambientOf', () => {
  it('the time is 24-hour with leading zeros and the date is day/month', () => {
    const ambient = ambientOf(at(7, 5), undefined, undefined);
    expect(ambient.time).toBe('07:05');
    expect(ambient.date).toContain('15/11');
    expect(ambient.track).toBeNull();
    expect(ambient.values).toEqual([]);
  });

  it('shows the track only while it plays, with the artist when there is one', () => {
    const playing = (status: string, artist?: string) => ({ playing: { title: 'Faixa', artist, status } });
    expect(ambientOf(at(12, 0), playing('playing', 'Banda'), undefined).track).toBe('♪ Faixa · Banda');
    expect(ambientOf(at(12, 0), playing('playing'), undefined).track).toBe('♪ Faixa');
    expect(ambientOf(at(12, 0), playing('paused', 'Banda'), undefined).track).toBeNull();
    expect(ambientOf(at(12, 0), { playing: null }, undefined).track).toBeNull();
  });

  it('shows at most three pushed values, by key, with their time left', () => {
    const now = at(12, 0);
    const values = Object.fromEntries(['d', 'a', 'c', 'b'].map((k) => [k, { data: k.toUpperCase(), at: 0, expiresAt: null }]));
    const ambient = ambientOf(now, undefined, { values });
    expect(ambient.values.map((v) => v.key)).toEqual(['a', 'b', 'c']);
  });

  it('shifts a few pixels with the minute, inside a small box, and does not stand still for five minutes', () => {
    const seen = new Set<string>();
    for (let minute = 0; minute < 60; minute += 1) {
      const { x, y } = ambientOf(at(10, minute), undefined, undefined).shift;
      expect(Math.abs(x)).toBeLessThanOrEqual(6);
      expect(Math.abs(y)).toBeLessThanOrEqual(6);
      seen.add(`${x},${y}`);
    }
    expect(seen.size).toBeGreaterThanOrEqual(20);
    expect(ambientOf(at(10, 1), undefined, undefined).shift).not.toEqual(ambientOf(at(10, 2), undefined, undefined).shift);
  });
});
