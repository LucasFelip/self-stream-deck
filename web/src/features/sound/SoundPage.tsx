import { call, client } from '../../api/client';
import { useLiveQuery } from '../../api/events';
import { Page } from '../../shell/Page';
import { useIsActive } from '../../shell/PagerContext';
import { AudioCards } from './AudioCards';
import { MediaPlayer } from './MediaPlayer';

/**
 * "Som": a slim player strip on top and, under it, Saída, Entrada and the per-app mixer as three cards in landscape or stacked in
 * portrait, so changing the song and changing the output never takes a swipe.
 */
export function SoundPage() {
  const active = useIsActive('sound');
  // the position moves all the time, so media is resent every 5 s by the agent; the page keeps its own clock between
  const media = useLiveQuery('media', ['media'], () => call(client.GET('/api/media')), { enabled: active, pollMs: 1500 });
  const audio = useLiveQuery('audio', ['audio'], () => call(client.GET('/api/audio')), { enabled: active, pollMs: 2000 });

  return (
    <Page section="sound" className="sound-page">
      <div className="card sound-media">
        <MediaPlayer media={media.data} active={active} failed={media.isError} updatedAt={media.dataUpdatedAt} />
      </div>
      <AudioCards audio={audio.data} />
    </Page>
  );
}
