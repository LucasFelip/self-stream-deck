import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createLatestWins } from '../lib/latestWins';
import { useToast } from './Toast';
import { errorText } from '../lib/errors';

interface RangeSliderProps {
  /** what the PC says (0..100); the slider follows it except while the finger is on it */
  value: number | undefined;
  disabled?: boolean;
  /** called while dragging with the newest position; never more than one call in flight */
  onChange: (value: number) => Promise<unknown> | void;
  /** the position being dragged, or null when the finger lets go (the parent shows it as text) */
  onDrag?: (value: number | null) => void;
  className?: string;
  label?: string;
}

/**
 * A 0..100 range input (the 48 px slider of style.css) that reports changes while dragging but keeps at most one request in flight,
 * and does not fight the finger: updates from the PC are ignored while it is down and for 400 ms after.
 */
export function RangeSlider({ value, disabled = false, onChange, onDrag, className = '', label }: RangeSliderProps) {
  const toast = useToast();
  const [local, setLocal] = useState(value ?? 0);
  const dragging = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestValue = useRef(value);
  latestValue.current = value;
  const latestChange = useRef(onChange);
  latestChange.current = onChange;

  const send = useMemo(
    () => createLatestWins<number>((next) => latestChange.current(next), (error) => toast(`Erro: ${errorText(error)}`, true)),
    [toast],
  );

  useEffect(() => {
    if (!dragging.current && value !== undefined) setLocal(value);
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const end = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      dragging.current = false;
      onDrag?.(null);
      if (latestValue.current !== undefined) setLocal(latestValue.current);
    }, 400);
  };

  return (
    <input
      type="range"
      min={0}
      max={100}
      step={1}
      value={local}
      className={`range ${className}`.trim()}
      style={{ '--fill': `${local}%` } as CSSProperties}
      disabled={disabled}
      aria-label={label}
      onPointerDown={() => { dragging.current = true; clearTimeout(timer.current); }}
      onPointerUp={end}
      onPointerCancel={end}
      onChange={(event) => {
        const next = Number(event.target.value);
        setLocal(next);
        onDrag?.(next);
        send(next);
      }}
    />
  );
}
