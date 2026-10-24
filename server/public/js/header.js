'use strict';

/**
 * The live controls (microphone) and the settings menu (the gear). Deliberately small: icons only. The live strip also holds the
 * power pill, the camera and the FPS pill. Also owns the scrim that closes the open menu.
 * The track title appears as a brief notice when the song changes.
 */
(() => {
  const { $, h, api, toast: showToast, vibrate } = Deck;

  const micButton = $('mic');
  const menuButton = $('menu');
  const menu = $('menu-pop');
  let lastTrack = null;
  let micShown = null;

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
    if (showPlayer) {
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

  menuButton.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
  });
  menu.addEventListener('click', () => { menu.hidden = true; });

  // A panel that floats over the deck (this menu) gets a transparent scrim under it: a tap outside only closes the
  // panel and never reaches the key below. Watching `hidden` keeps it right however the panel was closed (button, Back, an item).
  const scrim = $('scrim');
  const panels = [menu];
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
