import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { call, client } from '../../api/client';
import { useLiveQuery } from '../../api/events';
import { useToast } from '../../ui/Toast';
import { predict, type Change, type Rect, type Request, type Screen, type Win, type Zone } from './geometry';
import { POLL_MS, normalRect, updateSeen } from './model';
import { errorText } from '../../lib/errors';

const REFRESH_AT = [60, 220, 520, 1100];
const NO_SCREENS: Screen[] = [];

interface Model {
  windows: Win[];
  /** handles in the order the chips and the list show them */
  order: number[];
}

export interface WindowsController {
  windows: Win[];
  order: number[];
  screens: Screen[];
  selected: number | null;
  select: (handle: number | null) => void;
  /** a drag is on: nothing the PC says is drawn until it ends (a picture taken before the PC finished would show the old state) */
  setDragging: (on: boolean) => void;
  /** runs an action on a window: the picture changes at once, the PC confirms (or corrects) it with the next answers */
  windowAction: (win: Win, action: 'focus' | 'minimize' | 'maximize' | 'restore' | 'close') => Promise<void>;
  snap: (win: Win, monitor: number, zone: Zone) => Promise<void>;
  move: (win: Win, monitor: number) => Promise<void>;
  place: (win: Win, x: number, y: number, monitor?: number) => Promise<void>;
  /** asks the PC again a few times over the next second (after anything that changes a window) */
  refreshSoon: () => void;
  reloadScreens: () => void;
}

/**
 * Everything the Janelas page knows: the windows (pushed by the PC, or asked for while the stream is closed), the screens, the
 * selection and the actions. The list shown is the last picture the PC gave with the person's own actions applied on top at once
 * (an action first changes the picture we have; the answers that follow confirm or correct it).
 */
export function useWindowsController(active: boolean): WindowsController {
  const queryClient = useQueryClient();
  const toast = useToast();

  const windowsQuery = useLiveQuery('windows', ['windows'], () => call(client.GET('/api/windows')), { enabled: active, pollMs: POLL_MS });
  const screensQuery = useQuery({ queryKey: ['screens'], queryFn: () => call(client.GET('/api/screens')), enabled: active, staleTime: Infinity, retry: false });
  const screens = screensQuery.data?.monitors ?? NO_SCREENS;

  const [model, setModel] = useState<Model>({ windows: [], order: [] });
  const [selected, setSelected] = useState<number | null>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  const screensRef = useRef(screens);
  screensRef.current = screens;
  const lock = useRef({ dragging: false, pending: 0 });
  const lastNormal = useRef(new Map<number, Rect>()); // handle -> the rectangle a window had before it was maximized/snapped (for Restore)
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // a new list of windows: drawn unless the person is in the middle of something
  const data = windowsQuery.data;
  const stamp = windowsQuery.dataUpdatedAt;
  useEffect(() => {
    if (!data) return;
    if (lock.current.dragging || lock.current.pending > 0 || document.hidden) return;
    data.windows.forEach((win) => {
      const rect = normalRect(win);
      if (rect) lastNormal.current.set(win.handle, rect);
    });
    setModel((previous) => ({ windows: data.windows, order: updateSeen(previous.order, data.windows) }));
    setSelected((current) => (current !== null && !data.windows.some((win) => win.handle === current) ? null : current));
  }, [data, stamp]);

  const refreshSoon = useCallback(() => {
    for (const ms of REFRESH_AT) timers.current.push(setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['windows'] }), ms));
  }, [queryClient]);

  const reloadScreens = useCallback(() => { void queryClient.invalidateQueries({ queryKey: ['screens'] }); }, [queryClient]);

  const setDragging = useCallback((on: boolean) => { lock.current.dragging = on; }, []);

  // changes the picture we already have, right away
  function applyLocal(handle: number, change: Change, toFront = false) {
    setModel((previous) => {
      const list = previous.windows.map((win) => (win.handle === handle ? { ...win, ...change } : win));
      if (toFront) {
        const at = list.findIndex((win) => win.handle === handle);
        const [moved] = at >= 0 ? list.splice(at, 1) : [];
        if (moved) list.unshift(moved);
      }
      return { ...previous, windows: list };
    });
  }

  function predictFor(win: Win, request: Request): void {
    const known = screensRef.current;
    if (!known.length) return; // geometry not loaded yet: the next answer shows the real result
    const saved = normalRect(win) ?? lastNormal.current.get(win.handle); // before it changes: this is what Restore will bring back
    if (normalRect(win)) lastNormal.current.set(win.handle, normalRect(win) as Rect);
    const change = predict({ screens: known, windows: modelRef.current.windows, saved }, win, request);
    if (change || request.action === 'focus') applyLocal(win.handle, change ?? {}, request.action === 'focus');
  }

  async function send(task: () => Promise<unknown>): Promise<void> {
    lock.current.pending += 1;
    try {
      await task();
    } catch (error) {
      toast(`Erro: ${errorText(error)}`, true);
    } finally {
      lock.current.pending -= 1;
    }
    refreshSoon();
  }

  const controller: WindowsController = {
    windows: model.windows,
    order: model.order,
    screens,
    selected,
    select: setSelected,
    setDragging,
    refreshSoon,
    reloadScreens,
    windowAction(win, action) {
      predictFor(win, { action });
      return send(() => call(client.POST('/api/windows/action', { body: { handle: win.handle, action } })));
    },
    snap(win, monitor, zone) {
      predictFor(win, { snap: { monitor, zone } });
      return send(() => call(client.POST('/api/windows/snap', { body: { handle: win.handle, monitor, zone } })));
    },
    move(win, monitor) {
      predictFor(win, { move: { monitor } });
      return send(() => call(client.POST('/api/windows/move', { body: { handle: win.handle, monitor } })));
    },
    place(win, x, y, monitor) {
      applyLocal(win.handle, monitor === undefined ? { x, y } : { x, y, monitor });
      return send(() => call(client.POST('/api/windows/place', { body: { handle: win.handle, x, y } })));
    },
  };
  return controller;
}
