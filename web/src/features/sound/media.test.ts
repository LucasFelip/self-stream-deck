import { describe, expect, it } from 'vitest';
import { artUrl, pickSession, positionNow, subtitle, type MediaSession } from './media';

const session = (over: Partial<MediaSession>): MediaSession => ({
  id: 's', app: 'Spotify', status: 'paused', title: 't', artist: '', album: '', duration: 200, position: 0,
  canPlay: true, canPause: true, canPrev: true, canNext: true, canSeek: true, hasArt: false, artKey: '0123456789ab', ...over,
});

describe('pickSession', () => {
  const a = session({ id: 'a', status: 'paused' });
  const b = session({ id: 'b', status: 'playing' });
  const c = session({ id: 'c', status: 'paused' });

  it('prefers the one picked, then the current one, then one that is playing, then the first', () => {
    expect(pickSession([a, b, c], 'c', 'a')?.id).toBe('c');
    expect(pickSession([a, b, c], null, 'a')?.id).toBe('a');
    expect(pickSession([a, b, c], null, null)?.id).toBe('b');
    expect(pickSession([a, c], null, null)?.id).toBe('a');
  });

  it('forgets a pick that is gone and has nothing to show without players', () => {
    expect(pickSession([a, b], 'gone', null)?.id).toBe('b');
    expect(pickSession([], null, null)).toBeNull();
  });
});

describe('positionNow', () => {
  const base = { position: 42, at: 1000 };

  it('runs with the clock while playing and stands still while paused', () => {
    expect(positionNow({ duration: 200 }, true, base, 4000)).toBe(45);
    expect(positionNow({ duration: 200 }, false, base, 4000)).toBe(42);
  });

  it('never leaves the track, and has no position without a duration', () => {
    expect(positionNow({ duration: 50 }, true, base, 60_000)).toBe(50);
    expect(positionNow({ duration: 200 }, true, { position: 1, at: 1000 }, 0)).toBe(0);
    expect(positionNow({ duration: Number.NaN }, true, base, 4000)).toBeNull();
  });
});

describe('artUrl and subtitle', () => {
  it('names the session and the track in the art URL', () => {
    expect(artUrl({ id: 'a b', artKey: 'k' })).toBe('/api/media/art?session=a%20b&key=k');
  });

  it('shows artist and album, or the app', () => {
    expect(subtitle({ artist: 'Banda', album: 'Disco', app: 'Spotify' })).toBe('Banda · Disco');
    expect(subtitle({ artist: '', album: '', app: 'Spotify' })).toBe('Spotify');
  });
});
