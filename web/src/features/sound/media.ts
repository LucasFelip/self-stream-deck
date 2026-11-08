import type { components } from '../../api/schema';

export type MediaSession = components['schemas']['MediaSession'];
export type Media = components['schemas']['Media'];

/** Where the timeline was when the PC last said so, on the page's own clock (performance.now, in ms). */
export interface Base {
  position: number;
  at: number;
}

/**
 * Which player the card shows: the one the person picked, else the one Windows itself considers current (the one the media keys
 * control), else one that is playing, else the first. Null when nothing has a media session.
 */
export function pickSession(sessions: readonly MediaSession[], selectedId: string | null, currentId: string | null): MediaSession | null {
  return sessions.find((s) => s.id === selectedId)
    ?? sessions.find((s) => s.id === currentId)
    ?? sessions.find((s) => s.status === 'playing')
    ?? sessions[0]
    ?? null;
}

/** The position of the track now: the last known one plus the time that passed, if it is playing; clamped to the track. Null without a duration. */
export function positionNow(session: Pick<MediaSession, 'duration'>, playing: boolean, base: Base, now: number): number | null {
  if (!Number.isFinite(session.duration)) return null;
  const moving = playing ? (now - base.at) / 1000 : 0;
  return Math.max(0, Math.min(session.duration, base.position + moving));
}

export const artUrl = (session: Pick<MediaSession, 'id' | 'artKey'>): string => `/api/media/art?session=${encodeURIComponent(session.id)}&key=${session.artKey}`;

/** The line under the title: artist and album, or the app when the player gives neither. */
export const subtitle = (session: Pick<MediaSession, 'artist' | 'album' | 'app'>): string => [session.artist, session.album].filter(Boolean).join(' · ') || session.app;
