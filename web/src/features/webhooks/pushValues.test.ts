import { describe, expect, it } from 'vitest';
import { entries, leftText, valueText } from './pushValues';

describe('push values', () => {
  it('text stays text, other values become compact JSON, long ones are cut', () => {
    expect(valueText('verde')).toBe('verde');
    expect(valueText(21.5)).toBe('21.5');
    expect(valueText({ a: [1, 2] })).toBe('{"a":[1,2]}');
    expect(valueText(null)).toBe('null');
    expect(valueText('x'.repeat(300))).toHaveLength(120);
  });

  it('lists by key with the time left, never negative', () => {
    const data = { values: { b: { data: 2, at: 0, expiresAt: null }, a: { data: 'x', at: 0, expiresAt: 10_500 } } };
    expect(entries(data, 10_000)).toEqual([{ key: 'a', text: 'x', leftSec: 1 }, { key: 'b', text: '2', leftSec: null }]);
    expect(entries(data, 99_000)[0]!.leftSec).toBe(0);
    expect(entries(undefined, 0)).toEqual([]);
  });

  it('says what is left in the largest fitting unit', () => {
    expect(leftText(null)).toBe('');
    expect(leftText(5)).toBe('5 s');
    expect(leftText(180)).toBe('3 min');
    expect(leftText(7200)).toBe('2 h');
  });
});
