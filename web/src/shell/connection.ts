import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, call, client } from '../api/client';
import { hub, useLiveQuery } from '../api/events';
import { android } from '../lib/android';

export type ConnectionState = 'connecting' | 'online' | 'offline';

export interface Connection {
  state: ConnectionState;
  /** the text of the notice while offline */
  detail: string;
  /** "Tentar agora": ask the PC right now */
  retry: () => Promise<void>;
}

// The PC sends the current state as soon as the stream opens, and again only when it changes, so while the stream is open there
// is nothing to ask. Without a push for this long the tick asks once, which also notices a PC that went away without closing the stream.
const PUSH_SILENCE_MS = 45_000;
const TICK_MS = 3000;

/**
 * The connection to the PC. The state is pushed (the `state` topic); a 3-second tick asks for it when the stream is closed
 * or has been silent for 45 s. An answer means online, a failure means offline (401: not authorized). Sets `body[data-state]`,
 * which style.css uses to show the #offline notice and dim the pager. After a failure comes an answer, everything on screen is read again.
 */
export function useConnection(): Connection {
  const queryClient = useQueryClient();
  const query = useLiveQuery('state', ['state'], () => call(client.GET('/api/state')), { pollMs: false });
  const lastPush = useRef(0);
  useEffect(() => hub.subscribe('state', () => { lastPush.current = Date.now(); }), []);
  const { refetch } = query;
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      if (hub.isOpen() && Date.now() - lastPush.current < PUSH_SILENCE_MS) return;
      void refetch();
    };
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [refetch]);
  const [lastError, setLastError] = useState<unknown>(null);

  const online = query.isSuccess && !query.isError;
  const state: ConnectionState = online ? 'online' : query.isError ? 'offline' : 'connecting';

  useEffect(() => { document.body.dataset.state = state; }, [state]);

  // after an outage the first answer reloads everything the pages show
  useEffect(() => {
    if (query.isError) setLastError(query.error);
    else if (query.isSuccess && lastError) {
      setLastError(null);
      void queryClient.invalidateQueries();
    }
  }, [query.isError, query.isSuccess, query.error, lastError, queryClient]);

  // Lost for ~12 s: if the app knows another way to the PC (USB or Wi-Fi), let it switch to it
  const failures = query.errorUpdateCount;
  useEffect(() => {
    const status = query.error instanceof ApiError ? query.error.status : 0;
    if (failures > 0 && failures % 4 === 0 && status !== 401) android()?.reconnect?.();
  }, [failures, query.error]);

  const retry = useCallback(async () => { await refetch(); }, [refetch]);

  const unauthorized = query.error instanceof ApiError && query.error.status === 401;
  return { state, detail: unauthorized ? 'Não autorizado' : 'PC desconectado', retry };
}

/**
 * Keeps the phone awake while the deck is visible (needs a secure context, e.g. 127.0.0.1 over USB or the HTTPS port).
 * The system lets the lock go when the page is hidden, so it is asked for again when the page comes back or when it is
 * released while visible. A browser that wants a touch first (iOS) gets one more try on the first tap.
 */
export function useWakeLock(): void {
  useEffect(() => {
    if (!('wakeLock' in navigator)) return undefined;
    let lock: WakeLockSentinel | null = null;
    let busy = false;
    let disposed = false;

    const keepAwake = async () => {
      if (disposed || document.visibilityState !== 'visible' || busy || (lock && !lock.released)) return;
      busy = true;
      try {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { if (document.visibilityState === 'visible') setTimeout(() => void keepAwake(), 1000); });
      } catch {
        // denied or unsupported: the screen just follows the system timeout
      } finally {
        busy = false;
      }
    };
    const onPointer = () => { if (!lock || lock.released) void keepAwake(); };
    const onVisible = () => void keepAwake();
    document.addEventListener('pointerdown', onPointer, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onVisible);
    void keepAwake();
    return () => {
      disposed = true;
      document.removeEventListener('pointerdown', onPointer, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, []);
}
