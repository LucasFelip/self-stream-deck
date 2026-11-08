import { describe, expect, it } from 'vitest';
import { bytes, clock, duration, gb, pct, rate } from './format';

describe('format', () => {
  it('clock: minutes and seconds, hours when needed, a dash when it is not a number', () => {
    expect(clock(65)).toBe('1:05');
    expect(clock(3725)).toBe('1:02:05');
    expect(clock(-5)).toBe('0:00');
    expect(clock(Number.NaN)).toBe('–:––');
  });

  it('duration: the two biggest units', () => {
    expect(duration(150)).toBe('2min');
    expect(duration(3725)).toBe('1h 02min');
    expect(duration(93784)).toBe('1d 2h 3min');
  });

  it('bytes, rate, gb, pct', () => {
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1536)).toBe('1.5 KB');
    expect(bytes(250 * 1024 * 1024)).toBe('250 MB');
    expect(rate(2048)).toBe('2.0 KB/s');
    expect(gb(1536)).toBe('1.5 GB');
    expect(pct(47.6)).toBe('48%');
    expect([bytes(Number.NaN), rate(Number.NaN), gb(Number.NaN), pct(Number.NaN)]).toEqual(['–', '–', '–', '–']);
  });
});
