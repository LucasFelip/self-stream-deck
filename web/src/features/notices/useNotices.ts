import { useEffect, useRef } from 'react';
import { hub } from '../../api/events';
import { vibrate } from '../../lib/haptics';
import { useToast } from '../../ui/Toast';
import { useDeckState } from '../deck/data';

const SHOW_MS = 6000;
const MAX_TEXT = 140;

interface Notice {
  id: string;
  app?: string;
  title?: string;
  body?: string;
  time?: string | number;
}

/** "🔔 WhatsApp · Ana: oi" (cut at 140 characters). */
export function noticeLine({ app, title, body }: Notice): string {
  const text = [title, body].filter(Boolean).join(': ').replace(/\s+/g, ' ');
  const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
  return `🔔 ${app ? `${app} · ` : ''}${clipped}`;
}

/**
 * Windows notifications on the deck. The PC keeps the ones from the chosen apps (config.notifications.apps, WhatsApp by default) even when
 * Do Not Disturb or a game hides them; each new one shows up here as a notice with a short buzz. What was already waiting when the deck
 * connected is not announced again.
 */
export function useNotifications(): void {
  const toast = useToast();
  const seen = useRef(new Set<string>());
  const first = useRef(true);
  useEffect(() => hub.subscribe('notifications', (data) => {
    const list = (data as { notifications?: Notice[] } | null)?.notifications ?? [];
    const fresh = list.filter((item) => !seen.current.has(`${item.id}|${item.time}`));
    for (const item of list) seen.current.add(`${item.id}|${item.time}`);
    if (first.current) { first.current = false; return; }
    const last = fresh[fresh.length - 1];
    if (!last) return;
    toast(noticeLine(last) + (fresh.length > 1 ? ` (+${fresh.length - 1})` : ''), false, SHOW_MS);
    vibrate();
  }), [toast]);
}

/**
 * Self-update: when the interface files change on the PC (the state carries a version number), reload this page, but only once nobody
 * has touched the screen for a moment (never in the middle of a tap or a drag).
 */
export function useUiReload(): void {
  const state = useDeckState();
  const version = state.data?.ui;
  const known = useRef<number | null>(null);
  const lastTouch = useRef(0);
  const reloading = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    const touch = () => { lastTouch.current = Date.now(); };
    document.addEventListener('pointerdown', touch, { capture: true, passive: true });
    document.addEventListener('pointerup', touch, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', touch, { capture: true });
      document.removeEventListener('pointerup', touch, { capture: true });
      clearInterval(reloading.current);
    };
  }, []);

  useEffect(() => {
    if (!version) return;
    if (known.current === null) { known.current = version; return; }
    if (version === known.current || reloading.current) return;
    reloading.current = setInterval(() => { if (Date.now() - lastTouch.current > 2500) location.reload(); }, 500);
  }, [version]);
}
