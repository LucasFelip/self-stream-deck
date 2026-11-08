import { useCallback, useEffect, useRef, useState } from 'react';
import { android } from '../../lib/android';
import { Overlay } from '../../ui/Overlay';
import { Segmented } from '../../ui/Segmented';

// Idle dimmer for the AMOLED screen (menu > Escurecer após…). After N minutes without a touch a black veil covers the deck and, in the
// Android shell, window.Android.setDim(true) drops the screen brightness. The first touch only wakes it: the veil swallows that tap, so it
// never reaches the key underneath. It never dims while the camera transmits, a power action is scheduled, edit mode / a sheet / an overlay /
// the menu is open, or a finger is down (a slider or a drag in progress): it just checks again later. The choice (minutes, 0 = off) lives
// in localStorage (`ssd.idleMinutes`) inside try/catch; off by default.
const KEY = 'ssd.idleMinutes';
const OPTIONS = [{ id: '0', label: 'Desligado' }, { id: '1', label: '1 min' }, { id: '2', label: '2 min' }, { id: '5', label: '5 min' }] as const;
const RETRY_MS = 5000;
const WAKE_GUARD_MS = 400; // the veil stays (invisible) a moment so the click that ends the waking tap still lands on it

/** One "minute" in ms. The browser tests shrink it by setting `window.__ssdIdleUnitMs` before the page loads. */
const unitMs = (): number => (window as unknown as { __ssdIdleUnitMs?: number }).__ssdIdleUnitMs ?? 60000;

const readMinutes = (): number => {
  try {
    const value = Number(localStorage.getItem(KEY));
    return OPTIONS.some((option) => option.id === String(value)) ? value : 0;
  } catch {
    return 0; // no storage: it lasts until the page reloads
  }
};

interface IdleDimmerProps {
  open: boolean;
  onClose: () => void;
  /** something the dimmer must not interrupt (the camera transmitting, a power action scheduled, edit mode) */
  blocked: boolean;
}

/** The veil, the timer and the settings sheet of the dimmer. */
export function IdleDimmer({ open, onClose, blocked }: IdleDimmerProps) {
  const [minutes, setMinutes] = useState(readMinutes);
  const [dimmed, setDimmed] = useState(false);
  const [waking, setWaking] = useState(false);
  const [veilShown, setVeilShown] = useState(false);
  const veil = useRef<HTMLDivElement | null>(null);
  const state = useRef({ minutes, dimmed: false, lastActivity: Date.now(), fingers: 0, blocked });
  state.current.blocked = blocked;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const guard = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setNativeDim = (on: boolean) => {
    const bridge = android();
    if (!bridge || typeof bridge.setDim !== 'function') return; // an old APK only gets the veil
    try { bridge.setDim(on); } catch { /* the shell is optional */ }
  };

  const busy = (): boolean => state.current.fingers > 0
    || state.current.blocked
    || document.body.classList.contains('editing')
    || (document.getElementById('modal-root')?.childElementCount ?? 0) > 0
    || Boolean(document.querySelector('.overlay:not([hidden])'))
    || !(document.getElementById('menu-pop')?.hidden ?? true);

  const dim = useCallback(() => {
    state.current.dimmed = true;
    clearTimeout(guard.current);
    setDimmed(true);
    setWaking(false);
    setVeilShown(true);
    setNativeDim(true);
  }, []);

  const arm = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const { minutes: now, dimmed: isDimmed } = state.current;
    if (!now || isDimmed) return;
    const wait = Math.max(0, state.current.lastActivity + now * unitMs() - Date.now());
    timer.current = setTimeout(() => {
      if (busy()) {
        state.current.lastActivity = Date.now() - now * unitMs() + Math.min(RETRY_MS, now * unitMs()); // look again soon
        arm();
        return;
      }
      dim();
    }, wait);
  }, [dim]);

  const wake = useCallback(() => {
    state.current.dimmed = false;
    state.current.lastActivity = Date.now();
    setDimmed(false);
    setNativeDim(false);
    setWaking(true);
    clearTimeout(guard.current);
    guard.current = setTimeout(() => { setVeilShown(false); setWaking(false); }, WAKE_GUARD_MS);
    arm();
  }, [arm]);

  // the veil sits above everything: whatever touches it only wakes the screen (native listeners, to stop the event for real)
  useEffect(() => {
    const element = veil.current;
    if (!element) return undefined;
    const handler = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.current.dimmed && ['pointerdown', 'touchstart', 'click', 'mousedown'].includes(event.type)) wake();
    };
    const names = ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend', 'mousedown'];
    for (const name of names) element.addEventListener(name, handler);
    return () => { for (const name of names) element.removeEventListener(name, handler); };
  }, [wake]);

  // any touch anywhere restarts the countdown
  useEffect(() => {
    const touch = () => { if (!state.current.dimmed) { state.current.lastActivity = Date.now(); arm(); } };
    const down = () => { state.current.fingers += 1; touch(); };
    const up = () => { state.current.fingers = Math.max(0, state.current.fingers - 1); touch(); };
    const move = () => { if (state.current.fingers) touch(); };
    const options = { capture: true, passive: true } as const;
    document.addEventListener('pointerdown', down, options);
    document.addEventListener('pointerup', up, options);
    document.addEventListener('pointercancel', up, options);
    document.addEventListener('pointermove', move, options);
    arm();
    return () => {
      document.removeEventListener('pointerdown', down, options);
      document.removeEventListener('pointerup', up, options);
      document.removeEventListener('pointercancel', up, options);
      document.removeEventListener('pointermove', move, options);
      clearTimeout(timer.current);
      clearTimeout(guard.current);
    };
  }, [arm]);

  const choose = (id: string) => {
    const next = OPTIONS.some((option) => option.id === id) ? Number(id) : 0;
    state.current.minutes = next;
    setMinutes(next);
    try { localStorage.setItem(KEY, String(next)); } catch { /* no storage: it lasts until the page reloads */ }
    state.current.lastActivity = Date.now();
    if (!next && state.current.dimmed) wake();
    arm();
  };

  return (
    <>
      <div className={`idle-veil${waking ? ' waking' : ''}`} ref={veil} hidden={!veilShown} aria-hidden="true" data-dimmed={String(dimmed)} />
      <Overlay open={open} title="Escurecer após…" onClose={onClose}>
        <section className="idle-page">
          <Segmented items={OPTIONS} value={String(minutes) as (typeof OPTIONS)[number]['id']} onChange={choose} label="Escurecer após" />
          <p className="muted">Escurece a tela depois desse tempo sem toque. O primeiro toque só acorda a tela.</p>
        </section>
      </Overlay>
    </>
  );
}
