'use strict';

/**
 * Owns the pager (swipe between pages), the generated Apps / Shortcuts pages with the volume strip,
 * the connection state and the "power scheduled" pill. The other pages live in js/*.js and register
 * themselves with Deck.addPage().
 */
(() => {
  const { $, h, api, toast: showToast, vibrate } = Deck;

  const pager = $('pager');
  const volumeHolder = $('volume-holder');
  const tabs = $('tabs');
  const status = $('status');

  const volumeBox = $('volume');
  const volumeSlider = $('vol');
  const volumeValue = $('vol-value');
  const muteButton = $('mute');

  // Injected by the Android shell (see android/); absent when opened in a normal browser.
  if (window.Android && typeof window.Android.openSettings === 'function') {
    $('settings').hidden = false;
    $('settings').addEventListener('click', () => window.Android.openSettings());
  }

  function setStatus(state, label) {
    status.dataset.state = state;
    status.textContent = label;
    document.body.dataset.state = state;
    Deck.state.online = state === 'online';
  }

  // light haptic tick on every button, like a hardware key
  document.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button:not(:disabled)')) vibrate(8);
  }, { capture: true, passive: true });

  // --- items ----------------------------------------------------------------------------------
  // An item is { label, visual(): Node, onTap(), appId? }. Pages are rebuilt from these on every layout change.

  const sections = {
    apps: { title: 'Aplicativos', items: [] },
    shortcuts: { title: 'Atalhos', items: [] },
  };

  function fallbackIcon(name) {
    const el = document.createElement('div');
    el.className = 'fallback';
    el.textContent = name.charAt(0).toUpperCase();
    return el;
  }

  function appItem(app) {
    return {
      appId: app.id,
      label: app.name,
      visual() {
        if (!app.hasIcon) return fallbackIcon(app.name);
        const img = document.createElement('img');
        img.src = `/api/icon/${app.id}?v=${app.iconVersion || ''}`;
        img.alt = '';
        img.addEventListener('error', () => img.replaceWith(fallbackIcon(app.name)));
        return img;
      },
      async onTap() {
        try {
          const { action } = await api(`/api/launch/${app.id}`, { method: 'POST' });
          showToast(action === 'focused' ? `${app.name} em primeiro plano` : `Abrindo ${app.name}`);
          setTimeout(refreshState, 1500); // the "running" dot appears once the window exists
        } catch (err) {
          showToast(`Erro: ${err.message}`, true);
        }
      },
    };
  }

  function shortcutItem(shortcut) {
    return {
      label: shortcut.label,
      visual() {
        const keycap = document.createElement('div');
        keycap.className = 'keycap';
        keycap.textContent = shortcut.display.replace(/\+/g, '+​'); // allow a line break after each "+"
        return keycap;
      },
      async onTap() {
        try {
          await api(`/api/shortcut/${shortcut.id}`, { method: 'POST' });
        } catch (err) {
          showToast(`Erro: ${err.message}`, true);
        }
      },
    };
  }

  function makeTile(item) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    if (item.appId) tile.dataset.appId = item.appId;

    const text = document.createElement('span');
    text.textContent = item.label;
    tile.append(item.visual(), text);

    // an item may also react to a long press (the camera tile opens its sheet); the click that ends it is then ignored
    let holdTimer = null;
    let held = false;
    if (item.onHold) {
      tile.addEventListener('pointerdown', () => {
        held = false;
        holdTimer = setTimeout(() => { held = true; vibrate(25); item.onHold(); }, 550);
      });
      for (const name of ['pointerup', 'pointerleave', 'pointercancel']) tile.addEventListener(name, () => clearTimeout(holdTimer));
      tile.addEventListener('contextmenu', (event) => event.preventDefault());
    }

    tile.addEventListener('click', () => {
      if (held) { held = false; return; }
      tile.classList.add('launched');
      setTimeout(() => tile.classList.remove('launched'), 250);
      item.onTap();
    });
    return tile;
  }

  // The phone camera as the PC's webcam is one more key on the apps page: a tap turns it on or off, a long press
  // opens its settings. A red dot on it means it is transmitting.
  function cameraItem() {
    return {
      appId: 'camera',
      label: 'Câmera',
      visual() {
        const box = document.createElement('div');
        box.className = 'fallback cam';
        box.append(Deck.icon('camera', 30));
        return box;
      },
      onTap: () => Deck.camera.toggle(),
      onHold: () => Deck.camera.openSheet(),
    };
  }

  function paintCameraTile() {
    const live = Boolean(Deck.camera && Deck.camera.sending);
    pager.querySelectorAll('.tile[data-app-id="camera"]').forEach((tile) => tile.classList.toggle('live', live));
  }

  async function loadApps() {
    const { apps, host } = await api('/api/apps');
    if (host) $('host').textContent = host;
    sections.apps.items = [...apps.map(appItem), ...(Deck.camera ? [cameraItem()] : [])];
  }

  async function loadShortcuts() {
    const { shortcuts } = await api('/api/shortcuts');
    sections.shortcuts.items = shortcuts.map(shortcutItem);
  }

  // --- generated pages --------------------------------------------------------------------------

  const PAGE_PADDING_X = 16;
  const PAGE_PADDING_Y = 12;
  const GAP = 10;
  const MIN_TILE_H = 96;
  const TILE_ASPECT = 1.1; // keys are roughly square, like a real deck
  const TILE_CHROME = 50; // vertical space a tile spends on padding, gap and the two-line label

  // Fit a fixed grid to the real screen: as many rows as the height allows, then as many roughly
  // square columns as the width allows. Also returns how big the icons can be inside those tiles.
  function measure() {
    const width = pager.clientWidth - 2 * PAGE_PADDING_X;
    const height = pager.clientHeight - 2 * PAGE_PADDING_Y;
    const rows = Math.max(1, Math.floor((height + GAP) / (MIN_TILE_H + GAP)));
    const tileH = (height - (rows - 1) * GAP) / rows;
    const cols = Math.max(2, Math.round((width + GAP) / (tileH * TILE_ASPECT + GAP)));
    const tileW = (width - (cols - 1) * GAP) / cols;
    const icon = Math.max(32, Math.min(64, tileW - 24, tileH - TILE_CHROME));
    return { cols, rows, icon };
  }

  function buildPage(id, title, part, sectionId) {
    const page = document.createElement('section');
    page.className = 'page generated';
    page.dataset.section = sectionId;
    page.dataset.id = id;
    page.dataset.title = title;
    if (part) page.dataset.part = part;
    return page;
  }

  function buildPages() {
    const { cols, rows, icon } = measure();
    const perPage = cols * rows;
    pager.style.setProperty('--icon', `${icon}px`);

    const pages = [];
    for (const [key, section] of Object.entries(sections)) {
      // The volume strip takes the last row of the first shortcuts page, so shortcuts and sound share one page.
      const footer = key === 'shortcuts' ? volumeBox : null;
      // the same page also carries the open windows: the last columns of its first page belong to that list
      const side = footer && Deck.windowsUi && cols >= 5 ? 2 : 0;
      const firstCols = cols - side;
      const firstPageCapacity = footer ? firstCols * (rows - 1) : perPage;

      if (section.items.length === 0 && !footer) {
        if (key === 'apps') {
          const page = buildPage(`${key}-0`, section.title, '', key);
          page.innerHTML = '<p class="empty">Nenhum app encontrado na barra de tarefas.</p>';
          pages.push(page);
        }
        continue;
      }

      const overflow = Math.max(0, section.items.length - firstPageCapacity);
      const count = 1 + Math.ceil(overflow / perPage);
      for (let index = 0; index < count; index += 1) {
        const start = index === 0 ? 0 : firstPageCapacity + (index - 1) * perPage;
        const capacity = index === 0 ? firstPageCapacity : perPage;
        const hasFooter = footer && index === 0;

        const title = hasFooter ? (side ? 'Atalhos' : 'Atalhos e som') : section.title;
        const page = buildPage(`${key}-${index}`, title, count > 1 ? `${index + 1}/${count}` : '', key);
        const grid = document.createElement('div');
        grid.className = 'grid';
        grid.style.setProperty('--cols', hasFooter ? firstCols : cols);
        grid.style.setProperty('--rows', rows);

        const tiles = section.items.slice(start, start + capacity).map(makeTile);
        // unused positions stay visible as faint slots, so every page keeps the same grid
        const slots = Array.from({ length: capacity - tiles.length }, () => Object.assign(document.createElement('div'), { className: 'slot' }));
        grid.append(...tiles, ...slots);
        if (hasFooter) grid.append(footer);

        if (hasFooter && side) {
          const split = document.createElement('div');
          split.className = 'split';
          split.style.setProperty('--total', cols);
          split.style.setProperty('--first', firstCols);
          split.style.setProperty('--side', side);
          split.append(grid, Deck.windowsUi.list);
          page.append(split);
        } else {
          page.append(grid);
        }
        pages.push(page);
      }
    }
    return pages;
  }

  // pages owned by modules: same pager, built once, kept alive across layout rebuilds
  function modulePages() {
    const order = (def) => SECTIONS.findIndex((section) => section.id === (def.section || def.id));
    return [...Deck.pages].sort((x, y) => order(x) - order(y)).map((def) => {
      def.el.classList.add('page');
      def.el.dataset.section = def.section || def.id;
      def.el.dataset.id = def.id;
      def.el.dataset.title = def.title;
      return def.el;
    });
  }

  const allPages = () => [...pager.querySelectorAll('.page')];
  const currentIndex = () => Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));

  function goTo(index, smooth = true) {
    pager.scrollTo({ left: index * pager.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
  }

  function goToId(id) {
    const index = allPages().findIndex((page) => page.dataset.id === id);
    if (index !== -1) goTo(index);
  }

  const pageId = (page) => page.dataset.id;
  const sectionOf = (page) => page.dataset.section;
  const pagesOf = (sectionId) => allPages().filter((page) => sectionOf(page) === sectionId);

  // --- section tabs ---------------------------------------------------------------------------
  // The pager is one flat row of pages, but people think in four places. A tab jumps straight to a place
  // (remembering the page you last had open there); tapping the active tab goes to its next page; the dots
  // under the active tab show where you are inside it. Swiping still walks through every page in order.

  const SECTIONS = [
    { id: 'apps', label: 'Apps', icon: 'grid' },
    { id: 'shortcuts', label: 'Atalhos', icon: 'keys' },
    { id: 'sound', label: 'Som', icon: 'speaker' },
    { id: 'monitor', label: 'Desempenho', icon: 'chip' },
    { id: 'power', label: 'Energia', icon: 'power' },
    { id: 'processes', label: 'Processos', icon: 'list' },
  ];
  const lastPageIn = {}; // section id -> id of the page last seen there

  function openSection(sectionId) {
    const pages = pagesOf(sectionId);
    const current = allPages()[currentIndex()];
    const target = current && sectionOf(current) === sectionId
      ? pages[(pages.indexOf(current) + 1) % pages.length]
      : pages.find((page) => pageId(page) === lastPageIn[sectionId]) || pages[0];
    if (target) goTo(allPages().indexOf(target));
  }

  function renderTabs() {
    tabs.replaceChildren(
      ...SECTIONS.filter((section) => pagesOf(section.id).length).map((section) => h(
        'button',
        { type: 'button', class: 'tab', role: 'tab', 'aria-selected': 'false', data: { section: section.id }, on: { click: () => openSection(section.id) } },
        Deck.icon(section.icon),
        h('span', { class: 'tab-label', text: section.label }),
        h('span', { class: 'tab-dots' }),
      )),
    );
    updateNav();
  }

  // The page the user is on, remembered by id. Reading it back from scrollLeft after the DOM changed
  // would be wrong: the browser may have re-snapped to a different page in the meantime.
  let currentId = null;

  function notifyPages(previous, current) {
    const hooks = [...Deck.pages, ...Object.entries(Deck.lifecycle).map(([id, hook]) => ({ id, ...hook }))];
    for (const def of hooks) {
      if (def.id === previous && def.hide) def.hide();
      if (def.id === current && def.show) def.show();
    }
  }

  function updateNav() {
    const pages = allPages();
    const index = Math.min(currentIndex(), pages.length - 1);
    const page = pages[index];
    if (page && currentId !== pageId(page)) {
      const previous = currentId;
      currentId = pageId(page);
      notifyPages(previous, currentId);
    }
    if (!page) return;

    const activeSection = sectionOf(page);
    lastPageIn[activeSection] = pageId(page);
    tabs.querySelectorAll('.tab').forEach((tab) => {
      const active = tab.dataset.section === activeSection;
      const section = SECTIONS.find((candidate) => candidate.id === tab.dataset.section);
      const sectionPages = pagesOf(tab.dataset.section);
      const nested = active && sectionPages.length > 1;

      tab.setAttribute('aria-selected', String(active));
      // inside a section with several pages the tab names the page you are on ("Desempenho 1/3")
      tab.querySelector('.tab-label').textContent = nested ? [page.dataset.title, page.dataset.part].filter(Boolean).join(' ') : section.label;
      tab.querySelector('.tab-dots').replaceChildren(...(nested ? sectionPages.map((candidate) => h('i', { class: candidate === page ? 'on' : '' })) : []));
    });
  }

  // Rebuild the generated pages and stay on the same one, so a rotation or a refresh doesn't jump back to page 1.
  function render() {
    if (!pager.clientWidth) return;

    // snapping is paused while the pages change, otherwise the browser re-snaps to the old snap target
    pager.style.scrollSnapType = 'none';
    volumeHolder.append(volumeBox); // keep the volume strip (and its state) out of the pages being thrown away
    pager.replaceChildren(...buildPages(), ...modulePages());

    const keep = allPages().findIndex((page) => pageId(page) === currentId);
    goTo(keep === -1 ? 0 : keep, false);
    renderTabs();
    applyState();
    requestAnimationFrame(() => { pager.style.scrollSnapType = ''; });
  }

  let scrollFrame;
  pager.addEventListener('scroll', () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(updateNav);
  }, { passive: true });

  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  }).observe(pager);

  // --- running apps + scheduled power ------------------------------------------------------------

  let appState = { running: [], open: [], scheduled: null, receivedAt: Date.now() };

  function applyState() {
    paintCameraTile();
    const running = new Set(appState.running);
    const open = new Set(appState.open);
    pager.querySelectorAll('.tile[data-app-id]').forEach((tile) => {
      tile.classList.toggle('running', running.has(tile.dataset.appId));
      tile.classList.toggle('open', open.has(tile.dataset.appId));
    });
    renderPill();
    applyHeader();
  }

  // --- self-update -------------------------------------------------------------------------------
  // When the interface files change on the PC, reload this page, but only once nobody has touched the screen for a
  // moment (never in the middle of a tap or a drag).

  let uiVersion = null;
  let lastTouch = 0;
  let reloadTimer = null;
  document.addEventListener('pointerdown', () => { lastTouch = Date.now(); }, { capture: true, passive: true });
  document.addEventListener('pointerup', () => { lastTouch = Date.now(); }, { capture: true, passive: true });

  function noticeUiVersion(version) {
    if (!version) return;
    if (uiVersion === null) {
      uiVersion = version;
      return;
    }
    if (version === uiVersion || reloadTimer) return;
    reloadTimer = setInterval(() => {
      if (Date.now() - lastTouch > 2500) location.reload();
    }, 500);
  }

  // Throws when the PC cannot be reached (tick() turns that into the connection indicator).
  async function loadState() {
    appState = { ...(await api('/api/state')), receivedAt: Date.now() };
    noticeUiVersion(appState.ui);
    if (appState.volume) renderVolume(appState.volume);
    applyState();
  }

  async function refreshState() {
    try {
      await loadState();
    } catch {
      // the connection indicator in tick() reports problems
    }
  }

  const pill = $('power-pill');
  const PILL_LABELS = { shutdown: 'Desliga', restart: 'Reinicia', firmware: 'Reinicia p/ BIOS', advanced: 'Reinicia (avançado)' };
  let pillTimer;

  function renderPill() {
    const { scheduled } = appState;
    if (!scheduled) {
      pill.hidden = true;
      clearInterval(pillTimer);
      pillTimer = null;
      return;
    }
    const paint = () => {
      const left = Math.max(0, Math.round(scheduled.inSec - (Date.now() - appState.receivedAt) / 1000));
      pill.textContent = `${PILL_LABELS[scheduled.action] || scheduled.action} em ${Deck.fmt.clock(left)}`;
    };
    pill.hidden = false;
    paint();
    clearInterval(pillTimer);
    pillTimer = setInterval(paint, 1000);
  }
  pill.addEventListener('click', () => goToId('power'));

  // --- header: microphone, mini player, menu ------------------------------------------------------
  // Deliberately small: icons only. The track title appears as a brief notice when the song changes.

  const micButton = $('mic');
  const playerButton = $('player');
  const menuButton = $('menu');
  const menu = $('menu-pop');
  let lastTrack = null;
  let micShown = null;
  let playerShown = null;

  menuButton.replaceChildren(Deck.icon('more', 18));
  for (const item of Deck.menuItems) {
    menu.insertBefore(h('button', { type: 'button', role: 'menuitem', text: item.label, on: { click: item.onClick } }), $('refresh'));
  }

  function applyHeader() {
    const { mic, playing, miniPlayer } = appState;

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
      appState = { ...appState, mic };
      applyHeader();
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
    holdTimer = setTimeout(() => { held = true; vibrate(25); goToId('sound'); }, 550);
  });
  for (const name of ['pointerup', 'pointerleave', 'pointercancel']) playerButton.addEventListener(name, () => clearTimeout(holdTimer));
  playerButton.addEventListener('click', async () => {
    if (held) return;
    const { playing } = appState;
    if (!playing) return;
    // optimistic: the Windows session takes a moment to report the new state
    appState = { ...appState, playing: { ...playing, status: playing.status === 'playing' ? 'paused' : 'playing' } };
    playerShown = null;
    applyHeader();
    try {
      await api('/api/media/control', { method: 'POST', json: { session: playing.session, action: 'toggle' } });
    } catch (err) {
      showToast(`Erro: ${err.message}`, true);
    }
    setTimeout(refreshState, 500);
  });

  menuButton.addEventListener('click', () => { menu.hidden = !menu.hidden; });
  menu.addEventListener('click', () => { menu.hidden = true; });
  document.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && !event.target.closest('#menu-pop, #menu')) menu.hidden = true;
  }, { capture: true, passive: true });

  // --- volume strip -----------------------------------------------------------------------------

  let dragging = false;
  let dragTimer;

  function renderVolume({ level, muted }) {
    volumeBox.dataset.ready = 'true';
    volumeBox.dataset.muted = String(muted);
    if (!dragging) {
      volumeSlider.value = level;
      volumeSlider.style.setProperty('--fill', `${level}%`);
      volumeValue.textContent = muted ? 'mudo' : `${level}%`;
    }
  }

  async function refreshVolume() {
    try {
      renderVolume(await api('/api/volume'));
    } catch {
      volumeBox.dataset.ready = 'false';
    }
  }

  // Only the newest slider position matters, so while one request is in flight the rest collapse into one.
  let pendingLevel = null;
  let sending = false;
  async function flushVolume() {
    if (sending || pendingLevel === null) return;
    sending = true;
    const level = pendingLevel;
    pendingLevel = null;
    try {
      renderVolume(await api('/api/volume', { method: 'POST', json: { level } }));
    } catch (err) {
      showToast(`Erro: ${err.message}`, true);
    }
    sending = false;
    flushVolume();
  }

  volumeSlider.addEventListener('pointerdown', () => {
    dragging = true;
    clearTimeout(dragTimer);
  });
  const endDrag = () => {
    clearTimeout(dragTimer);
    dragTimer = setTimeout(() => { dragging = false; }, 400);
  };
  volumeSlider.addEventListener('pointerup', endDrag);
  volumeSlider.addEventListener('pointercancel', endDrag);

  volumeSlider.addEventListener('input', () => {
    const level = Number(volumeSlider.value);
    volumeSlider.style.setProperty('--fill', `${level}%`);
    volumeValue.textContent = `${level}%`;
    volumeBox.dataset.muted = 'false';
    pendingLevel = level;
    flushVolume();
  });

  muteButton.addEventListener('click', async () => {
    try {
      renderVolume(await api('/api/volume', { method: 'POST', json: { muted: 'toggle' } }));
    } catch (err) {
      showToast(`Erro: ${err.message}`, true);
    }
  });

  // these buttons send the global media keys (whatever player Windows considers current)
  document.querySelectorAll('[data-media]').forEach((button) => {
    button.addEventListener('click', () => {
      api(`/api/mediakey/${button.dataset.media}`, { method: 'POST' }).catch((err) => showToast(`Erro: ${err.message}`, true));
    });
  });

  // --- refresh button ---------------------------------------------------------------------------

  const refreshButton = $('refresh');
  refreshButton.addEventListener('click', async () => {
    refreshButton.classList.remove('spin');
    void refreshButton.offsetWidth; // restart the spin
    refreshButton.classList.add('spin');
    try {
      await api('/api/refresh', { method: 'POST' });
      await Promise.all([loadApps(), loadShortcuts(), refreshVolume(), refreshState()]);
      render();
      showToast('Atualizado');
    } catch (err) {
      showToast(`Erro: ${err.message}`, true);
    }
  });

  // --- connection -------------------------------------------------------------------------------

  // Doubles as the connection indicator and as the way the UI recovers on its own after the PC
  // sleeps or Wi-Fi drops: the first successful ping after an outage reloads everything.
  let online = false;
  // One request per tick (the state already carries the volume), and none while the screen is off or the app is in the
  // background: that saves the phone's radio and lets the PC's media helper stop when nobody is looking.
  async function tick() {
    if (document.hidden) return;
    try {
      await loadState();
    } catch (err) {
      online = false;
      setStatus('offline', err.status === 401 ? 'não autorizado' : 'sem conexão');
      return;
    }
    if (!online) {
      online = true;
      setStatus('online', 'online');
      await Promise.allSettled([loadApps(), loadShortcuts()]);
      render();
    }
  }

  // Keep the phone awake while the deck is visible (needs a secure context, e.g. 127.0.0.1 over USB).
  async function keepAwake() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      await navigator.wakeLock.request('screen');
    } catch {
      // denied or unsupported: the screen just follows the system timeout
    }
  }
  document.addEventListener('visibilitychange', () => {
    keepAwake();
    // the visible page's polling stops with the screen and starts again, fresh, when it comes back
    const page = [...Deck.pages, ...Object.entries(Deck.lifecycle).map(([id, hook]) => ({ id, ...hook }))].find((def) => def.id === currentId);
    if (document.hidden) {
      if (page && page.hide) page.hide();
      return;
    }
    if (page && page.show) page.show();
    tick();
  });
  keepAwake();

  // modules can ask to jump to a page (e.g. the power pill)
  Deck.goTo = goToId;
  Deck.refreshState = refreshState;

  render();
  tick();
  setInterval(tick, 3000);
})();
