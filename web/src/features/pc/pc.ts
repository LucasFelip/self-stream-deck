import type { components } from '../../api/schema';

export type MonitorSample = components['schemas']['MonitorSample'];
export type Processes = components['schemas']['Processes'];
export type SystemInfo = components['schemas']['SystemInfo'];
export type GameFps = components['schemas']['GameFps'];

export type Level = 'ok' | 'warn' | 'crit';

/** How worried to be about a percentage: ok under `warn`, crit from `crit` (colours the big number and the bar). */
export const level = (value: number | null | undefined, warn: number, crit: number): Level => {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'ok';
  return value >= crit ? 'crit' : value >= warn ? 'warn' : 'ok';
};

/** "–" for a sensor that gave nothing, else the value formatted. */
export function orDash(value: number | null | undefined, format: (v: number) => string = String): string {
  return value === null || value === undefined || Number.isNaN(value) ? '–' : format(value);
}

/** "GeForce RTX 4070" for "NVIDIA GeForce RTX 4070": the card header is small. */
export const gpuShortName = (name: string): string => name.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '');

export const HISTORY = 60;

/** Appends a reading to a chart's history; the first reading fills the whole history, so the chart starts as a flat line instead of a stub. */
export function pushHistory(values: readonly number[], value: number): number[] {
  const next = values.length ? [...values] : Array<number>(HISTORY).fill(Number.isFinite(value) ? value : 0);
  next.push(Number.isFinite(value) ? value : 0);
  if (next.length > HISTORY) next.shift();
  return next;
}

/** The two paths of a scrolling line chart in a 100x30 box: values scaled to `max` (or to the largest seen, with a floor), newest at the right edge. */
export function sparkPaths(values: readonly number[], max: number | null, floor: number): { line: string; fill: string } {
  if (!values.length) return { line: '', fill: '' };
  const top = max ?? Math.max(floor, ...values);
  const offset = HISTORY - values.length;
  const xs = values.map((_, i) => (((i + offset) / (HISTORY - 1)) * 100).toFixed(1));
  const points = values.map((v, i) => `${xs[i]},${(29 - (Math.min(v, top) / top) * 27).toFixed(1)}`);
  return { line: `M${points.join(' L')}`, fill: `M${xs[0]},30 L${points.join(' L')} L100,30 Z` };
}

export const usedPercent = (totalGB: number, freeGB: number): number => ((totalGB - freeGB) / totalGB) * 100;

export const sizeText = (gb: number): string => (gb >= 1000 ? `${Math.round(gb / 100) / 10} TB` : `${gb} GB`);

type Disk = SystemInfo['storage'][number];
type Drive = SystemInfo['drives'][number];

export interface StorageBlock {
  /** the physical disk, or null for the block of partitions whose disk is unknown */
  disk: Disk | null;
  /** "SSD · NVMe · 1 TB" */
  kind: string;
  drives: Drive[];
}

/** Physical disks (model, then kind) with their partitions; partitions with no known disk go in one extra block. */
export function storageBlocks(disks: readonly Disk[], drives: readonly Drive[]): StorageBlock[] {
  const known = new Set(disks.map((disk) => disk.id));
  const blocks: StorageBlock[] = disks.map((disk) => ({
    disk,
    kind: [disk.type && disk.type !== 'Unspecified' ? disk.type : '', disk.bus, sizeText(disk.sizeGB)].filter(Boolean).join(' · '),
    drives: drives.filter((drive) => drive.disk !== null && drive.disk !== undefined && drive.disk === disk.id),
  }));
  const loose = drives.filter((drive) => drive.disk === null || drive.disk === undefined || !known.has(drive.disk));
  if (loose.length) blocks.push({ disk: null, kind: '', drives: loose });
  return blocks;
}
