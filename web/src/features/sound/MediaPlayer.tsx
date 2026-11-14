import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { call, client } from '../../api/client';
import { clock } from '../../lib/format';
import { Icon } from '../../ui/Icon';
import { useToast } from '../../ui/Toast';
import { artUrl, pickSession, positionNow, subtitle, type Base, type Media } from './media';
import { errorText } from '../../lib/errors';

const CLOCK_MS = 250;
const EMPTY_TEXT = 'Abra o Spotify, um vídeo do YouTube ou qualquer música no navegador.';

interface MediaPlayerProps {
  media: Media | undefined;
  /** the page is on screen: the timeline clock runs only then */
  active: boolean;
  failed: boolean;
  /** when `media` arrived (changes with every answer): the page's clock starts over from it */
  updatedAt: number;
}

type Action = 'toggle' | 'play' | 'pause' | 'next' | 'previous' | 'seek';

/**
 * What is playing right now (Spotify, YouTube or anything else in a browser, VLC...) with cover art, a seekable timeline and transport
 * controls for that specific player. Source: the Windows media session. The position between answers is counted here.
 */
export function MediaPlayer({ media, active, failed, updatedAt }: MediaPlayerProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const sessions = media?.sessions ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const session = pickSession(sessions, selectedId, media?.current ?? null);

  // the toggle shows at once (Windows takes a moment to report it); the next answer replaces it
  const [override, setOverride] = useState<{ id: string; status: 'playing' | 'paused' } | null>(null);
  const status = session && override?.id === session.id ? override.status : session?.status;
  const playing = status === 'playing';

  // the page's own clock for the timeline: where the PC said the track was, and when
  const base = useRef<Base>({ position: 0, at: performance.now() });
  const [now, setNow] = useState(() => performance.now());
  const sessionKey = session ? `${session.id}|${session.artKey}` : '';
  const sessionPosition = session?.position;
  useEffect(() => {
    base.current = { position: Number.isFinite(sessionPosition) ? (sessionPosition as number) : 0, at: performance.now() };
    setOverride(null);
    setNow(performance.now());
  }, [updatedAt, sessionKey, sessionPosition]);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(performance.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, [active]);

  const [seeking, setSeeking] = useState<number | null>(null);
  const [artLoaded, setArtLoaded] = useState<string | null>(null);

  const reloadSoon = () => setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['media'] }), 350);

  async function control(action: Action, position?: number) {
    if (!session) return;
    if (action === 'toggle') {
      const at = positionNow(session, playing, base.current, performance.now());
      if (at !== null) base.current = { position: at, at: performance.now() }; // keep the clock where it is, then let it run or freeze
      setOverride({ id: session.id, status: playing ? 'paused' : 'playing' });
    }
    try {
      const { accepted } = await call(client.POST('/api/media/control', { body: { session: session.id, action, position } }));
      if (!accepted) toast('O player não aceitou o comando', true);
    } catch (error) {
      toast(`Erro: ${errorText(error)}`, true);
    }
    reloadSoon();
  }

  const hasTimeline = Boolean(session) && Number.isFinite(session?.duration) && (session?.duration ?? 0) > 0;
  const duration = session?.duration ?? 0;
  const at = session ? positionNow(session, playing, base.current, now) : null;
  const shownSeconds = seeking !== null ? (seeking / 1000) * duration : (at ?? 0);
  const fill = hasTimeline ? (seeking !== null ? seeking / 10 : ((at ?? 0) / duration) * 100) : 0;
  const sliderValue = seeking !== null ? seeking : hasTimeline ? Math.round(((at ?? 0) / duration) * 1000) : 0;

  const commitSeek = () => {
    if (!session || seeking === null) return;
    const target = (seeking / 1000) * duration;
    base.current = { position: target, at: performance.now() };
    void control('seek', target);
    setTimeout(() => setSeeking(null), 600);
  };

  return (
    <section className="media-page" data-empty={String(!session)}>
      <div className="media-body">
        <div className="cover">
          <Icon name="note" size={56} />
          <img
            alt=""
            draggable={false}
            className={session?.hasArt && artLoaded === session.artKey ? 'loaded' : undefined}
            src={session?.hasArt ? artUrl(session) : undefined}
            onLoad={() => setArtLoaded(session?.artKey ?? null)}
            onError={() => setArtLoaded(null)}
          />
        </div>
        <div className="track">
          <div className="track-source">
            <span className="chip" hidden={sessions.length > 1}>{session ? `${session.app}${status === 'paused' ? ' · pausado' : ''}` : ''}</span>
            <div className="chips">
              {sessions.length > 1
                ? sessions.map((s) => (
                  <button key={s.id} type="button" className="chip" aria-pressed={s.id === session?.id} onClick={() => setSelectedId(s.id)}>{s.app}</button>
                ))
                : null}
            </div>
          </div>
          <div className="track-text">
            <div className="track-title">{session ? session.title || 'Sem título' : ''}</div>
            <div className="track-artist">{session ? subtitle(session) : ''}</div>
          </div>
          <div className="timeline" hidden={!hasTimeline}>
            <span>{clock(shownSeconds)}</span>
            <input
              type="range"
              min={0}
              max={1000}
              value={sliderValue}
              className="range"
              aria-label="Posição"
              style={{ '--fill': `${fill}%` } as CSSProperties}
              disabled={!session?.canSeek}
              onPointerDown={() => setSeeking(sliderValue)}
              onChange={(event) => setSeeking(Number(event.target.value))}
              onPointerUp={commitSeek}
              onKeyUp={commitSeek}
              onPointerCancel={() => setSeeking(null)}
            />
            <span>{hasTimeline ? clock(duration) : '0:00'}</span>
          </div>
          <div className="transport">
            <button type="button" aria-label="Faixa anterior" disabled={!session?.canPrev} onClick={() => void control('previous')}><Icon name="prev" /></button>
            <button type="button" className="primary" aria-label="Reproduzir ou pausar" disabled={!session || !(session.canPlay || session.canPause)} onClick={() => void control('toggle')}>
              <Icon name={playing ? 'pause' : 'play'} />
            </button>
            <button type="button" aria-label="Próxima faixa" disabled={!session?.canNext} onClick={() => void control('next')}><Icon name="next" /></button>
          </div>
        </div>
      </div>
      <div className="media-empty">
        <Icon name="note" size={44} />
        <p>Nada tocando</p>
        <small>{failed ? 'Não foi possível ler a mídia do Windows.' : EMPTY_TEXT}</small>
      </div>
    </section>
  );
}
