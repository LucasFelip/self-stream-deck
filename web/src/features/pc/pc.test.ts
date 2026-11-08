import { describe, expect, it } from 'vitest';
import { HISTORY, gpuShortName, level, orDash, pushHistory, sizeText, sparkPaths, storageBlocks, usedPercent } from './pc';

describe('level and orDash', () => {
  it('level: ok under warn, warn from warn, crit from crit, ok when unknown', () => {
    expect(level(50, 80, 95)).toBe('ok');
    expect(level(80, 80, 95)).toBe('warn');
    expect(level(95, 80, 95)).toBe('crit');
    expect(level(undefined, 80, 95)).toBe('ok');
    expect(level(Number.NaN, 80, 95)).toBe('ok');
  });

  it('orDash: a dash for a sensor that gave nothing', () => {
    expect(orDash(null)).toBe('–');
    expect(orDash(undefined)).toBe('–');
    expect(orDash(Number.NaN)).toBe('–');
    expect(orDash(51.4, (v) => `${Math.round(v)} °C`)).toBe('51 °C');
    expect(orDash(0)).toBe('0');
  });
});

describe('charts', () => {
  it('the first reading fills the history, the next ones scroll it', () => {
    const first = pushHistory([], 40);
    expect(first).toHaveLength(HISTORY);
    expect(first.every((v) => v === 40)).toBe(true);
    const second = pushHistory(first, 70);
    expect(second).toHaveLength(HISTORY);
    expect(second[HISTORY - 1]).toBe(70);
    expect(second[0]).toBe(40);
  });

  it('a reading that is not a number counts as zero', () => {
    expect(pushHistory([1, 2], Number.NaN).at(-1)).toBe(0);
  });

  it('paths: newest at the right edge, scaled to max, a full-height value touches the top margin', () => {
    const { line, fill } = sparkPaths([0, 100], 100, 1);
    expect(line).toBe('M98.3,29.0 L100.0,2.0');
    expect(fill.startsWith('M98.3,30 L')).toBe(true);
    expect(fill.endsWith('L100,30 Z')).toBe(true);
  });

  it('paths: without max the largest value seen (at least the floor) is the top', () => {
    expect(sparkPaths([50], null, 100).line).toBe('M100.0,15.5');
    expect(sparkPaths([200], null, 100).line).toBe('M100.0,2.0');
    expect(sparkPaths([], null, 1)).toEqual({ line: '', fill: '' });
  });
});

describe('names and sizes', () => {
  it('gpuShortName drops the maker', () => {
    expect(gpuShortName('NVIDIA GeForce RTX 4070')).toBe('RTX 4070');
    expect(gpuShortName('AMD Radeon RX 7800 XT')).toBe('AMD Radeon RX 7800 XT');
  });

  it('sizeText and usedPercent', () => {
    expect(sizeText(500)).toBe('500 GB');
    expect(sizeText(1000)).toBe('1 TB');
    expect(sizeText(1862)).toBe('1.9 TB');
    expect(usedPercent(500, 200)).toBe(60);
  });
});

describe('storageBlocks', () => {
  const disks = [
    { id: 0, model: 'NVMe A', sizeGB: 1000, type: 'SSD', bus: 'NVMe' },
    { id: 1, model: 'Disco B', sizeGB: 500, type: 'Unspecified', bus: 'SATA' },
  ];
  const drive = (name: string, disk: number | null | undefined) => ({ name, totalGB: 100, freeGB: 50, disk });

  it('puts each partition under its disk and the rest in one extra block', () => {
    const blocks = storageBlocks(disks, [drive('C:', 0), drive('D:', 1), drive('E:', 0), drive('F:', null), drive('G:', 9), drive('H:', undefined)]);
    expect(blocks.map((b) => [b.disk?.model ?? null, b.drives.map((d) => d.name)])).toEqual([
      ['NVMe A', ['C:', 'E:']],
      ['Disco B', ['D:']],
      [null, ['F:', 'G:', 'H:']],
    ]);
  });

  it('describes the kind of disk without "Unspecified" and has no extra block when nothing is loose', () => {
    const blocks = storageBlocks(disks, [drive('C:', 0)]);
    expect(blocks.map((b) => b.kind)).toEqual(['SSD · NVMe · 1 TB', 'SATA · 500 GB']);
    expect(blocks).toHaveLength(2);
  });
});
