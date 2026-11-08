'use strict';

/**
 * "Mídia" page: what is playing right now (Spotify, YouTube or anything else in a browser, VLC...),
 * with cover art, a seekable timeline and transport controls for that specific player.
 * Source: the Windows media session, via GET /api/media.
 */
(() => {
  const { h, icon, api, toast, fmt } = Deck;

  const POLL_MS = 1500;
  const CLOCK_MS = 250;

  let sessions = [];
  let currentId = null; // the session Windows itself considers current (the one media keys control)
  let selectedId = null; // the session the person picked in the chips
  let error = null;

  // local clock for the timeline between polls
  let basePosition = 0;
  let baseAt = 0;
  let seeking = false;
  let shownArtKey = null;

  let watcher = null; // live updates (or the fallback poller) while the page is the visible one
  let clockTimer = null;

  // --- DOM ------------------------------------------------------------------------------------

  const coverImg = h('img', { alt: '', draggable: 'false' });
  const coverFallback = icon('note', 56);
  const cover = h('div', { class: 'cover' }, coverFallback, coverImg);

  const sourceChip = h('span', { class: 'chip' });
  const switcher = h('div', { class: 'chips' });
  const title = h('div', { class: 'track-title' });
  const artist = h('div', { class: 'track-artist' });

  const elapsed = h('span', { text: '0:00' });
  const total = h('span', { text: '0:00' });
  const progress = h('input', { type: 'range', min: 0, max: 1000, value: 0, class: 'range', 'aria-label': 'Posição' });
  const timeline = h('div', { class: 'timeline' }, elapsed, progress, total);

  const prevButton = h('button', { type: 'button', 'aria-label': 'Faixa anterior', on: { click: () => control('previous') } }, icon('prev'));
  const playButton = h('button', { type: 'button', class: 'primary', 'aria-label': 'Reproduzir ou pausar', on: { click: () => control('toggle') } }, icon('play'));
  const nextButton = h('button', { type: 'button', 'aria-label': 'Próxima faixa', on: { click: () => control('next') } }, icon('next'));
  const transport = h('div', { class: 'transport' }, prevButton, playButton, nextButton);

  const emptyText = h('small', { text: 'Abra o Spotify, um vídeo do YouTube ou qualquer música no navegador.' });
  const empty = h('div', { class: 'media-empty' }, icon('note', 44), h('p', { text: 'Nada tocando' }), emptyText);

  const el = h(
    'section',
    { class: 'media-page', data: { empty: 'true' } },
    h('div', { class: 'media-body' },
      cover,
      h('div', { class: 'track' },
        h('div', { class: 'track-source' }, sourceChip, switcher),
        h('div', { class: 'track-text' }, title, artist),
        timeline,
        transport)),
    empty,
  );

  // --- state ----------------------------------------------------------------------------------

  function active() {
    return sessions.find((s) => s.id === selectedId)
      || sessions.find((s) => s.id === currentId)
      || sessions.find((s) => s.status === 'playing')
      || sessions[0]
      || null;
  }

  const isPlaying = (session) => session.status === 'playing';

  function positionNow() {
    const session = active();
    if (!session || !Number.isFinite(session.duration)) return null;
    const moving = isPlaying(session) ? (performance.now() - baseAt) / 1000 : 0;
    return Math.max(0, Math.min(session.duration, basePosition + moving));
  }

  function paintClock() {
    const session = active();
    if (!session || seeking) return;
    const at = positionNow();
    if (at === null) return;
    elapsed.textContent = fmt.clock(at);
    progress.value = Math.round((at / session.duration) * 1000);
    progress.style.setProperty('--fill', `${(at / session.duration) * 100}%`);
  }

  function paintCover(session) {
    if (shownArtKey === session.artKey) return;
    shownArtKey = session.artKey;
    coverImg.classList.remove('loaded');
    if (!session.hasArt) {
      coverImg.removeAttribute('src');
      return;
    }
    coverImg.onload = () => coverImg.classList.add('loaded');
    coverImg.onerror = () => coverImg.classList.remove('loaded');
    coverImg.src = `/api/media/art?session=${encodeURIComponent(session.id)}&key=${session.artKey}`;
  }

  function render() {
    const session = active();
    el.dataset.empty = String(!session);
    if (!session) {
      emptyText.textContent = error
        ? 'Não foi possível ler a mídia do Windows.'
        : 'Abra o Spotify, um vídeo do YouTube ou qualquer música no navegador.';
      shownArtKey = null;
      return;
    }

    title.textContent = session.title || 'Sem título';
    artist.textContent = [session.artist, session.album].filter(Boolean).join(' · ') || session.app;
    sourceChip.textContent = `${session.app}${session.status === 'paused' ? ' · pausado' : ''}`;
    paintCover(session);

    playButton.replaceChildren(icon(isPlaying(session) ? 'pause' : 'play'));
    playButton.disabled = !(session.canPlay || session.canPause);
    prevButton.disabled = !session.canPrev;
    nextButton.disabled = !session.canNext;

    const hasTimeline = Number.isFinite(session.duration) && session.duration > 0;
    timeline.hidden = !hasTimeline;
    progress.disabled = !session.canSeek;
    if (hasTimeline) total.textContent = fmt.clock(session.duration);

    switcher.replaceChildren(
      ...(sessions.length > 1
        ? sessions.map((s) => h('button', {
          type: 'button',
          class: 'chip',
          'aria-pressed': String(s.id === session.id),
          text: s.app,
          on: { click: () => { selectedId = s.id; syncClock(); render(); } },
        }))
        : []),
    );
    sourceChip.hidden = sessions.length > 1; // the chips already name the source
    paintClock();
  }

  function syncClock() {
    const session = active();
    if (!session) return;
    basePosition = Number.isFinite(session.position) ? session.position : 0;
    baseAt = performance.now();
  }

  // --- talking to the server ------------------------------------------------------------------

  // a new picture of what is playing (pushed by the PC, or fetched when the stream is not open)
  function apply(data) {
    sessions = data.sessions;
    currentId = data.current;
    if (selectedId && !sessions.some((s) => s.id === selectedId)) selectedId = null;
    error = null;
    syncClock();
    render();
  }

  // reads once more right away (after a command)
  async function poll() {
    if (document.hidden) return;
    try {
      apply(await api('/api/media'));
    } catch (err) {
      error = err;
      sessions = [];
      render();
    }
  }

  async function control(action, position) {
    const session = active();
    if (!session) return;
    // optimistic: the Windows session takes a moment to report the new state
    if (action === 'toggle') {
      const at = positionNow(); // keep the clock where it is, then let it run or freeze
      session.status = isPlaying(session) ? 'paused' : 'playing';
      if (at !== null) {
        basePosition = at;
        baseAt = performance.now();
      }
      render();
    }
    try {
      const { accepted } = await api('/api/media/control', { method: 'POST', json: { session: session.id, action, position } });
      if (!accepted) toast('O player não aceitou o comando', true);
    } catch (err) {
      toast(`Erro: ${err.message}`, true);
    }
    setTimeout(poll, 350);
  }

  // dragging the timeline previews the time; letting go seeks
  progress.addEventListener('pointerdown', () => { seeking = true; });
  progress.addEventListener('input', () => {
    const session = active();
    if (!session) return;
    const at = (Number(progress.value) / 1000) * session.duration;
    elapsed.textContent = fmt.clock(at);
    progress.style.setProperty('--fill', `${Number(progress.value) / 10}%`);
  });
  progress.addEventListener('change', async () => {
    const session = active();
    if (!session) return;
    const at = (Number(progress.value) / 1000) * session.duration;
    basePosition = at;
    baseAt = performance.now();
    await control('seek', at);
    setTimeout(() => { seeking = false; }, 600);
  });
  progress.addEventListener('pointercancel', () => { seeking = false; });

  // --- page lifecycle -------------------------------------------------------------------------

  // one half of the "Som" page (see sound.js)
  Deck.sound = Deck.sound || {};
  Deck.sound.media = {
    el,
    show() {
      if (watcher) watcher.stop();
      // the position moves all the time: it only counts as a change in 5 s steps (the page keeps its own clock between)
      const signature = (data) => JSON.stringify(data.sessions.map((s) => ({ ...s, position: Math.floor((s.position || 0) / 5) })));
      watcher = Deck.live.watch('media', { apply, poll: () => api('/api/media'), ms: POLL_MS, idleMs: 3000, idleAfter: 6, signature });
      clearInterval(clockTimer);
      clockTimer = setInterval(paintClock, CLOCK_MS);
    },
    hide() {
      if (watcher) watcher.stop();
      watcher = null;
      clearInterval(clockTimer);
      clockTimer = null;
    },
  };
})();
