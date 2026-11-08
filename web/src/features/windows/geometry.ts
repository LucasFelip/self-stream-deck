import type { components } from '../../api/schema';

/**
 * Pure window geometry for the Janelas page: where a window ends up after an action. The page uses it to show the result
 * instantly, before the PC has answered. Moved from the old interface's geometry.js, with the same numbers and the same tests.
 */

export type Win = components['schemas']['Window'];
export type Screen = components['schemas']['Screen'];

/** state: 0 normal, 1 minimized, 2 maximized */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ScreenBox = Pick<Screen, 'left' | 'top' | 'width' | 'height'>;
export type WindowLike = Pick<Win, 'handle' | 'x' | 'y' | 'w' | 'h' | 'state' | 'monitor'>;
export type Zone = 'left' | 'right' | 'full';

export interface Request {
  action?: 'minimize' | 'maximize' | 'restore' | 'focus' | 'close' | '';
  snap?: { monitor: number; zone: Zone };
  move?: { monitor: number };
}

export interface Context {
  screens: readonly ScreenBox[];
  windows: readonly WindowLike[];
  /** the rectangle the window had before it was maximized or snapped (for Restore) */
  saved?: Rect | null;
}

/** What changes in the window: the fields to assign. */
export type Change = Partial<Pick<Win, 'state' | 'monitor' | 'x' | 'y' | 'w' | 'h'>>;

/** A maximized window fills exactly the work area (screen minus taskbar), so use one if there is one. */
export function workArea(screens: readonly ScreenBox[], windows: readonly WindowLike[], index: number): Rect {
  const screen = screens[index] ?? screens[0];
  if (!screen) throw new Error('no screens');
  const filler = windows.find((win) => win.state === 2 && win.monitor === index);
  if (filler) return { x: filler.x, y: filler.y, w: filler.w, h: filler.h };
  return { x: screen.left, y: screen.top, w: screen.width, h: screen.height };
}

/** The rectangle a window gets when restored: the one it had before, or a centered 60% x 70% block. */
export function restoredRect(saved: Rect | null | undefined, area: Rect): Rect {
  if (saved) return { x: saved.x, y: saved.y, w: saved.w, h: saved.h };
  const w = Math.round(area.w * 0.6);
  const h = Math.round(area.h * 0.7);
  return { x: area.x + Math.round((area.w - w) / 2), y: area.y + Math.round((area.h - h) / 2), w, h };
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, high));

/** What changes in `win` after the request, or null when there is nothing to predict (close). */
export function predict({ screens, windows, saved }: Context, win: WindowLike, { action, snap, move }: Request): Change | null {
  if (snap) {
    const area = workArea(screens, windows, snap.monitor);
    if (snap.zone === 'full') return { state: 2, monitor: snap.monitor, ...area };
    const half = Math.floor(area.w / 2);
    const left = snap.zone === 'left';
    return { state: 0, monitor: snap.monitor, x: left ? area.x : area.x + half, y: area.y, w: left ? half : area.w - half, h: area.h };
  }

  if (move) {
    const to = workArea(screens, windows, move.monitor);
    if (win.state === 2) return { monitor: move.monitor, ...to };
    const from = workArea(screens, windows, Math.max(0, win.monitor));
    const w = Math.min(win.w, to.w);
    const h = Math.min(win.h, to.h);
    // keep the same relative place on the other screen
    const x = to.x + ((win.x - from.x) / from.w) * to.w;
    const y = to.y + ((win.y - from.y) / from.h) * to.h;
    return { monitor: move.monitor, w, h, x: Math.round(clamp(x, to.x, to.x + to.w - w)), y: Math.round(clamp(y, to.y, to.y + to.h - h)) };
  }

  const index = Math.max(0, win.monitor);
  switch (action) {
    case 'minimize': return { state: 1 };
    case 'maximize': return { state: 2, ...workArea(screens, windows, index) };
    case 'restore': return { state: 0, ...restoredRect(saved, workArea(screens, windows, index)) };
    case 'focus': return win.state === 1 ? { state: 0, ...restoredRect(saved, workArea(screens, windows, index)) } : {};
    default: return null;
  }
}
