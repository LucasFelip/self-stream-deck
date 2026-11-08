import type { PagerMetrics } from '../../shell/PagerContext';

// Fitting the keys to the real screen: the same numbers the old interface pager.js measured, moved as they were.
const PAGE_PADDING_X = 16;
const PAGE_PADDING_Y = 12;
const GAP = 10;
const MIN_TILE_H = 96;
const TILE_ASPECT = 1.1; // keys are roughly square, like a real deck
const TILE_CHROME = 50; // vertical space a key spends on padding, gap and the two-line label

/** The normal grid: as many rows as the height allows, then as many roughly square columns as the width allows. */
export interface Base {
  cols: number;
  rows: number;
  /** how big the icons can be inside those keys */
  icon: number;
  tileH: number;
  /** the room for the grid, without the page padding and the camera cut-out / system bars */
  width: number;
  height: number;
}

export function measure(metrics: Pick<PagerMetrics, 'width' | 'height' | 'safeLeft' | 'safeRight' | 'safeBottom'>): Base {
  const width = metrics.width - 2 * PAGE_PADDING_X - metrics.safeLeft - metrics.safeRight;
  const height = metrics.height - 2 * PAGE_PADDING_Y - metrics.safeBottom;
  const rows = Math.max(1, Math.floor((height + GAP) / (MIN_TILE_H + GAP)));
  const tileH = (height - (rows - 1) * GAP) / rows;
  const cols = Math.max(2, Math.round((width + GAP) / (tileH * TILE_ASPECT + GAP)));
  const tileW = (width - (cols - 1) * GAP) / cols;
  const icon = Math.max(32, Math.min(64, tileW - 24, tileH - TILE_CHROME));
  return { cols, rows, icon, tileH, width, height };
}

// Apps shows EVERY key at once. Few keys: the normal grid. More than it holds: try every column count and keep the one that gives the
// biggest keys (the smaller side of a key is what counts), in a compact look (one-line label, tighter gap). Only if even that is
// too small to read (key under 44 x 60 px) does the page fall back to the normal grid and scrolls vertically.
const FIT_GAP = 8;
const FIT_MIN_W = 44;
const FIT_MIN_H = 60;
const APPS_COLS = 7;
const APPS_ROWS = 3;

export interface AppsFit {
  mode: 'normal' | 'fit' | 'scroll';
  cols: number;
  rows: number;
  icon: number;
  /** the size of a key in `fit` mode */
  w?: number;
  h?: number;
}

/**
 * Upright (portrait) a fixed 7 x 3 grid would make tall slivers (47 x 258 px on a 411 x 914 screen), so there the grid follows the
 * screen: the normal grid when every key fits, otherwise the column count that gives the biggest keys.
 */
export function appsLayoutUpright(count: number, base: Base): AppsFit {
  const need = count + 1; // the free slot after the last key is the "+" of edit mode
  if (need <= base.cols * base.rows) return { mode: 'normal', cols: base.cols, rows: base.rows, icon: base.icon };
  let best: { cols: number; rows: number; w: number; h: number; side: number } | null = null;
  for (let cols = 1; cols <= need; cols += 1) {
    const rows = Math.ceil(need / cols);
    const w = (base.width - (cols - 1) * FIT_GAP) / cols;
    const h = (base.height - (rows - 1) * FIT_GAP) / rows;
    const side = Math.min(w, h);
    if (!best || side > best.side + 0.5) best = { cols, rows, w, h, side };
  }
  if (best && best.w >= FIT_MIN_W && best.h >= FIT_MIN_H) {
    return { mode: 'fit', cols: best.cols, rows: best.rows, icon: Math.max(32, Math.min(64, best.w - 12, best.h - 28)), w: Math.floor(best.w), h: Math.floor(best.h) };
  }
  return { mode: 'scroll', cols: base.cols, rows: Math.max(base.rows, Math.ceil(need / base.cols)), icon: base.icon };
}

/** Landscape: a fixed 7 columns x 3 rows; more keys than that add rows. Portrait: see appsLayoutUpright. */
export function appsLayout(count: number, base: Base, landscape: boolean): AppsFit {
  if (!landscape) return appsLayoutUpright(count, base);
  const cols = APPS_COLS;
  const rows = Math.max(APPS_ROWS, Math.ceil(count / cols));
  const w = (base.width - (cols - 1) * FIT_GAP) / cols;
  const h = (base.height - (rows - 1) * FIT_GAP) / rows;
  if (w >= FIT_MIN_W && h >= FIT_MIN_H) {
    return { mode: 'fit', cols, rows, icon: Math.max(24, Math.min(64, w - 12, h - 28)), w: Math.floor(w), h: Math.floor(h) };
  }
  return { mode: 'scroll', cols, rows, icon: Math.max(24, Math.min(base.icon, w - 12)) };
}

/** Where each key sits (saved by holding and dragging it). Keys not in the saved order keep their natural place, after the ones that are. */
export function arranged<T extends { key: string }>(order: readonly string[] | undefined, items: readonly T[]): T[] {
  const rank = new Map((order ?? []).map((key, index) => [key, index]));
  const place = (item: T, index: number): number => rank.get(item.key) ?? 1e6 + index;
  return items.map((item, index) => ({ item, at: place(item, index) })).sort((a, b) => a.at - b.at).map(({ item }) => item);
}

/** Cuts a list into pages of `perPage` (Atalhos stays paginated). */
export function paginate<T>(items: readonly T[], perPage: number): T[][] {
  const size = Math.max(1, perPage);
  const pages: T[][] = [];
  for (let at = 0; at < items.length; at += size) pages.push(items.slice(at, at + size));
  return pages;
}

/** Letting go of a lifted key on another key swaps the two; on an empty slot it goes to the end. Returns the new order. */
export function reorder(keys: readonly string[], lifted: string, target: string): string[] {
  const from = keys.indexOf(lifted);
  if (from === -1) return [...keys];
  const next = [...keys];
  if (target === END) {
    next.splice(from, 1);
    next.push(lifted);
    return next;
  }
  const to = keys.indexOf(target);
  if (to === -1 || to === from) return next;
  next[from] = target;
  next[to] = lifted;
  return next;
}

/** the "target" of reorder() for an empty slot */
export const END = '\u0000end';
