'use strict';

/**
 * The live controls (microphone, mini player) and the settings menu (the gear). Deliberately small: icons only. The live strip also holds the
 * volume button, the power pill, the camera and the FPS pill. Also owns the scrim that closes the open panels (volume, menu).
 * The track title appears as a brief notice when the song changes.
 */
(() => {
  const { $, h, api, toast: showToast, vibrate } = Deck;

  const micButton = $('mic');
  const playerButton = $('player');
  const menuButton = $('menu');
  const menu = $('menu-pop');
  let lastTrack = null;
  let micShown = null;
  let playerShown = null;

  menuButton.replaceChildren(Deck.icon('settings', 20));
  // the modules push their entries in load order (camera, then editor); the menu wants the editor first, so walk them backwards
  for (const item of [...Deck.menuItems].reverse()) {
    menu.insertBefore(h('button', { type: 'button', role: 'menuitem', text: item.label, on: { click: item.onClick } }), $('settings'));
  }

  function apply() {
    const { mic, playing, miniPlayer } = Deck.pc.state;

    micButton.hidden = !(mic && mic.available);
    if (mic && mic.available && micShown !== mic.muted) {
      micShown = mic.muted;
      micButton.dataset.muted = String(mic.muted);
      micButton.setAttribute('aria-label', mic.muted ? 'Ativar microfone' : 'Silenciar microfone');
      micButton.replaceChildren(Deck.icon(mic.muted ? 'micOff' : 'mic', 18));
    }

    const showPlayer = Boolean(miniPlayer && playing && playing.canToggle);
    playerButton.hidden = !showPlayer;
    if (showPlayer) {
      const state = `${playing.status}|${playing.title}`;
      if (playerShown !== state) {
        playerShown = state;
        playerButton.dataset.status = playing.status;
        playerButton.title = [playing.title, playing.artist, playing.app].filter(Boolean).join(' · ');
        playerButton.replaceChildren(Deck.icon(playing.status === 'playing' ? 'pause' : 'play', 18));
      }

      // a new song starts: say what it is, once
      const track = `${playing.session}|${playing.title}|${playing.artist}`;
      if (lastTrack !== null && track !== lastTrack && playing.status === 'playing' && playing.title) {
        showToast(`♪ ${playing.title}${playing.artist ? ` — ${playing.artist}` : ''}`);
      }
      lastTrack = track;
    } else {
      lastTrack = null;
    }
  }

  micButton.addEventListener('click', async () => {
    vibrate(30);
    try {
      const mic = await api('/api/mic', { method: 'POST', json: { muted: 'toggle' } });
      Deck.pc.patch({ mic });
      apply();
      showToast(mic.muted ? 'Microfone silenciado' : 'Microfone ativo');
    } catch (err) {
      showToast(`Erro: ${err.message}`, true);
    }
  });

  // tap = play/pause the current player; hold = open the Media page
  let holdTimer = null;
  let held = false;
  playerButton.addEventListener('pointerdown', () => {
    held = false;
    holdTimer = setTimeout(() => { held = true; vibrate(25); Deck.pager.goToId('sound'); }, 550);
  });
  for (const name of ['pointerup', 'pointerleave', 'pointercancel']) playerButton.addEventListener(name, () => clearTimeout(holdTimer));
  playerButton.addEventListener('click', async () => {
    if (held) return;
    const { playing } = Deck.pc.state;
    if (!playing) return;
    // optimistic: the Windows session takes a moment to report the new state
    Deck.pc.patch({ playing: { ...playing, status: playing.status === 'playing' ? 'paused' : 'playing' } });
    playerShown = null;
    apply();
    try {
      await api('/api/media/control', { method: 'POST', json: { session: playing.session, action: 'toggle' } });
    } catch (err) {
      showToast(`Erro: ${err.message}`, true);
    }
    setTimeout(() => Deck.pc.refresh(), 500);
  });

  menuButton.addEventListener('click', () => { menu.hidden = !menu.hidden; });
  menu.addEventListener('click', () => { menu.hidden = true; });

  // A panel that floats over the deck (the volume panel, this menu) gets a transparent scrim under it: a tap outside only closes the
  // panel and never reaches the key below. Watching `hidden` keeps it right however the panel was closed (button, Back, an item).
  const scrim = $('scrim');
  const panels = [$('volume-panel'), menu];
  const syncPanels = () => {
    scrim.hidden = panels.every((panel) => panel.hidden);
    menuButton.setAttribute('aria-expanded', String(!menu.hidden));
  };
  const panelWatcher = new MutationObserver(syncPanels);
  for (const panel of panels) panelWatcher.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  scrim.addEventListener('click', () => { for (const panel of panels) panel.hidden = true; });
  Deck.dragToClose(menu.querySelector('.grip'), menu, () => { menu.hidden = true; });
  Deck.dragToClose(menu.querySelector('.menu-host'), menu, () => { menu.hidden = true; });

  Deck.header = { apply };
})();
