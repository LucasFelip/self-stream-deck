import { entries, type PushEntry } from '../webhooks/pushValues';

/** What the dimmed screen shows: a big clock, the date, what is playing and a few values the webhooks left. */
export interface Ambient {
  time: string;
  date: string;
  track: string | null;
  values: PushEntry[];
  /** a few pixels that change every minute, so the same pixels never light up for hours (an AMOLED screen burns in) */
  shift: { x: number; y: number };
}

interface PlayingState {
  playing?: { title?: string; artist?: string; status?: string; app?: string } | null;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const MAX_VALUES = 3;

/** The weekday is spelled out in the person's language where the platform knows it; the numbers do not depend on it. */
function dateText(now: Date): string {
  const day = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}`;
  try {
    return `${new Intl.DateTimeFormat('pt-BR', { weekday: 'long' }).format(now)} · ${day}`;
  } catch {
    return day;
  }
}

/**
 * The text of the dimmed screen. `state` is what the PC last said about the deck (the `playing` part), `pushed` the values of the webhooks;
 * either can be missing.
 */
export function ambientOf(now: Date, state: PlayingState | undefined, pushed: Parameters<typeof entries>[0]): Ambient {
  const playing = state?.playing;
  const track = playing && playing.status === 'playing' && playing.title
    ? `♪ ${playing.title}${playing.artist ? ` · ${playing.artist}` : ''}`
    : null;
  // 5 positions on each axis, moving with the minute: x steps by 1, y by 2 (so the two do not repeat in step)
  const minute = now.getHours() * 60 + now.getMinutes();
  return {
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    date: dateText(now),
    track,
    values: entries(pushed, now.getTime()).slice(0, MAX_VALUES),
    shift: { x: ((minute % 5) - 2) * 3, y: ((Math.floor(minute / 5) % 5) - 2) * 3 },
  };
}
