import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { vibrate } from '../lib/haptics';

/**
 * The hold completes while the finger is still down and the sheet goes away; lifting the finger then "clicks" whatever was under it
 * (in portrait, a tab of the bar). Swallows the click that follows this touch, and only that one.
 */
function swallowNextClick(): void {
  const block = (event: Event) => { event.stopPropagation(); event.preventDefault(); };
  document.addEventListener('click', block, true);
  const release = () => setTimeout(() => document.removeEventListener('click', block, true), 350);
  document.addEventListener('pointerup', release, { capture: true, once: true });
  document.addEventListener('pointercancel', release, { capture: true, once: true });
}

interface HoldButtonProps {
  label: string;
  onDone: () => void;
  /** how long the button must be held */
  ms?: number;
  className?: string;
}

/** A button that only fires after being held (1.2 s by default), with a fill that shows the progress, so a stray tap cannot do it. */
export function HoldButton({ label, onDone, ms = 1200, className = '' }: HoldButtonProps) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    mounted.current = true;
    return () => {
      // the sheet was taken away while held (Back, a rebuild): pointerleave never comes for a removed button, and it must not act
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  }, []);

  const start = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (timer.current) return;
    setHolding(true);
    vibrate(15);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!mounted.current) return;
      setHolding(false);
      vibrate(80);
      swallowNextClick();
      done.current();
    }, ms);
  };

  return (
    <button
      type="button"
      className={`hold ${className}${holding ? ' holding' : ''}`.trim()}
      style={{ '--hold-ms': `${ms}ms` } as CSSProperties}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span>{label}</span>
    </button>
  );
}
