import { useEffect, useRef, useState } from 'react';
import { call, client } from '../../api/client';
import { useLiveQuery } from '../../api/events';
import { usePager } from '../../shell/PagerContext';
import { paneStore, usePane } from '../pc/paneStore';

const ENDED_AFTER_MS = 5000; // a loading screen or an alt-tab stalls the counters for a moment: that is not the end of the game

// not while a sheet or dialog is open: sliding the page away under it would be a surprise
const busy = (): boolean => Boolean(document.querySelector('.overlay:not([hidden])')) || (document.getElementById('modal-root')?.childElementCount ?? 0) > 0;

/**
 * A game being played. The moment its frame rate shows up the deck slides to PC > Desempenho, so the person sees it; anywhere else a small
 * floating counter in the corner (#fps, no touch) keeps the number in view. It listens to the light "game" topic, so it works from every page
 * and not only while Desempenho is open.
 */
export function GameWatcher() {
  const pager = usePager();
  const pane = usePane();
  const query = useLiveQuery('game', ['game'], () => call(client.GET('/api/monitor/fps')), { pollMs: 2000 });
  const game = query.data; // undefined: not asked yet; null: no game; else the frame rate

  const [playing, setPlaying] = useState(false);
  const [sliding, setSliding] = useState(false); // on its way to Desempenho: the counter would only flash while the page slides
  const shown = useRef('');
  const wantSlide = useRef(false); // a game just started and the deck has not slid to Desempenho yet
  const playingRef = useRef(false);
  const endTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const onMonitor = (pager.active === 'pc' && pane === 'monitor') || sliding;
  useEffect(() => { if (pager.active === 'pc') setSliding(false); }, [pager.active]);

  // The frame rate can arrive before the pages exist (at startup): going to the page then says no, and we try again when the pages are there.
  const { goToPage, pages } = pager;
  const trySlide = () => {
    if (!wantSlide.current) return;
    if (busy() || onMonitor) { wantSlide.current = false; return; }
    if (goToPage('pc')) {
      wantSlide.current = false;
      paneStore.set('monitor');
      setSliding(true);
    }
  };

  useEffect(() => {
    if (game === undefined) return;
    if (game) {
      clearTimeout(endTimer.current);
      endTimer.current = undefined;
      if (!playingRef.current) {
        playingRef.current = true;
        setPlaying(true);
        wantSlide.current = true;
      }
      shown.current = String(game.fps);
      trySlide();
    } else if (playingRef.current && !endTimer.current) {
      endTimer.current = setTimeout(() => {
        endTimer.current = undefined;
        playingRef.current = false;
        wantSlide.current = false;
        setPlaying(false);
      }, ENDED_AFTER_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, query.dataUpdatedAt]);

  // the pages came after the frame rate did
  useEffect(() => {
    trySlide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);
  useEffect(() => () => clearTimeout(endTimer.current), []);

  return (
    <div id="fps" className="fps-float" role="status" aria-label="Quadros por segundo" hidden={!playing || onMonitor} title={game ? `${game.app || 'Jogo'} · ${game.frameMs ?? ''} ms` : undefined}>
      <b>{shown.current}</b>
      <small>FPS</small>
    </div>
  );
}
