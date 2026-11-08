import type { Win } from './geometry';

/** The app's icon (from the taskbar list) or, for a window that is not a taskbar app, the first letter of its name. */
export function WindowIcon({ win }: { win: Pick<Win, 'appId' | 'iconVersion' | 'app' | 'title'> }) {
  if (win.appId) return <img src={`/api/icon/${win.appId}?v=${win.iconVersion || ''}`} alt="" draggable={false} />;
  return <b>{(win.app || win.title || '?').charAt(0).toUpperCase()}</b>;
}
