import type { Rect, Screen, Win, Zone } from './geometry';

export const POLL_MS = 600; // the PC answers in ~12 ms, so reading often is cheap; actions also refresh right away
export const BRIGHT_H = 30; // room under the screens for the brightness sliders
export const DRAG_THRESHOLD = 6; // px before a touch counts as a drag instead of a tap
export const SIDE_ZONE = 0.18; // fraction of a screen's width that snaps left/right
export const TOP_ZONE = 0.14; // fraction of its height that maximizes
export const CLOSE_ARM_MS = 3000;

export const STATE_LABEL: Record<number, string> = { 1: 'minimizada', 2: 'maximizada' };

/** The map: where the screens' bounding box starts and how many map pixels a real pixel is. */
export interface Layout {
  minX: number;
  minY: number;
  scale: number;
  width: number;
  height: number;
}

type ScreenBox = Pick<Screen, 'left' | 'top' | 'width' | 'height'>;

/** Fits every screen, to scale, in the room the map has (leaving BRIGHT_H for the sliders under it). Null without screens or room. */
export function computeLayout(screens: readonly ScreenBox[], room: { width: number; height: number }): Layout | null {
  if (!screens.length) return null;
  const minX = Math.min(...screens.map((s) => s.left));
  const minY = Math.min(...screens.map((s) => s.top));
  const maxX = Math.max(...screens.map((s) => s.left + s.width));
  const maxY = Math.max(...screens.map((s) => s.top + s.height));
  const width = room.width;
  const height = room.height - BRIGHT_H - 6;
  if (width <= 0 || height <= 0) return null;
  const scale = Math.min(width / (maxX - minX), height / (maxY - minY));
  return { minX, minY, scale, width: (maxX - minX) * scale, height: (maxY - minY) * scale };
}

export const toMap = (layout: Layout, x: number, y: number): { left: number; top: number } => ({ left: (x - layout.minX) * layout.scale, top: (y - layout.minY) * layout.scale });

/** The screen under a point of the map (px, py in map pixels), or -1. */
export function monitorAt(screens: readonly ScreenBox[], layout: Layout, px: number, py: number): number {
  return screens.findIndex((screen) => {
    const { left, top } = toMap(layout, screen.left, screen.top);
    return px >= left && px < left + screen.width * layout.scale && py >= top && py < top + screen.height * layout.scale;
  });
}

/** Which snap zone the point is in on that screen (null = a plain move): the top strip maximizes, the side strips take a half. */
export function zoneAt(screens: readonly ScreenBox[], layout: Layout, index: number, px: number, py: number): Zone | null {
  const screen = screens[index];
  if (index < 0 || !screen) return null;
  const { left, top } = toMap(layout, screen.left, screen.top);
  const fx = (px - left) / (screen.width * layout.scale);
  const fy = (py - top) / (screen.height * layout.scale);
  if (fy < TOP_ZONE) return 'full';
  if (fx < SIDE_ZONE) return 'left';
  if (fx > 1 - SIDE_ZONE) return 'right';
  return null;
}

/** A window that is on the map: not minimized and with a size. Bottom-to-top, so the stacking matches the real desktop. */
export const onMap = (windows: readonly Win[]): Win[] => windows.filter((win) => win.state !== 1 && win.w > 0).reverse();

/**
 * The order the chips and the list show windows in: windows that were there keep their place and new ones come first,
 * so a title that changes (or a window that is raised) never makes the row you are about to tap jump.
 */
export function updateSeen(seen: readonly number[], windows: readonly Win[]): number[] {
  const alive = new Set(windows.map((win) => win.handle));
  const kept = seen.filter((handle) => alive.has(handle));
  const known = new Set(kept);
  // the new ones in stack order (topmost first), in front of the ones that were already there
  const fresh = windows.filter((win) => !known.has(win.handle)).map((win) => win.handle);
  return [...fresh, ...kept];
}

/** A title that only changes its leading spinner glyph (a terminal at work) is not a change. */
export const bare = (title: string): string => String(title).replace(/^[^\p{L}\p{N}]+/u, '');

export const signatureOf = (windows: readonly Win[]): string => JSON.stringify(windows.map((w) => [w.handle, w.state, w.monitor, w.x, w.y, w.w, w.h, bare(w.title)]));

/** The rectangle a window had while it was normal: what Restore brings back. */
export const normalRect = (win: Win): Rect | null => (win.state === 0 && win.w > 0 ? { x: win.x, y: win.y, w: win.w, h: win.h } : null);

/** The line under the selected window's title. */
export function metaText(win: Win, screenCount: number): string {
  return [win.app, STATE_LABEL[win.state], screenCount > 1 ? `Tela ${win.monitor + 1}` : ''].filter(Boolean).join(' · ');
}
