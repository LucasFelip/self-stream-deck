import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { leftText } from '../webhooks/pushValues';
import { ambientOf } from './ambient';

const TICK_MS = 15000;
const cacheOnly = (): Promise<never> => Promise.reject(new Error('cache only'));

/**
 * What the veil of the dimmed screen shows (instead of a black rectangle): a big clock and date, what is playing and a few values the
 * webhooks left. Dim and still (the brightness is turned down by the shell), a few pixels away from where it was a minute ago. It reads what the
 * pages already have in the cache; it asks the PC for nothing.
 */
export function IdleAmbient() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const state = useQuery({ queryKey: ['state'], queryFn: cacheOnly, enabled: false });
  const pushed = useQuery({ queryKey: ['push'], queryFn: cacheOnly, enabled: false });
  const ambient = ambientOf(now, state.data as Parameters<typeof ambientOf>[1], pushed.data as Parameters<typeof ambientOf>[2]);
  return (
    <div className="idle-ambient" style={{ transform: `translate(${ambient.shift.x}px, ${ambient.shift.y}px)` }}>
      <div className="idle-time">{ambient.time}</div>
      <div className="idle-date">{ambient.date}</div>
      {ambient.track ? <div className="idle-track">{ambient.track}</div> : null}
      {ambient.values.length > 0 ? (
        <div className="idle-values">
          {ambient.values.map((v) => <span key={v.key}>{`${v.key} ${v.text}${v.leftSec !== null ? ` · ${leftText(v.leftSec)}` : ''}`}</span>)}
        </div>
      ) : null}
    </div>
  );
}
