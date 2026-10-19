'use strict';

/**
 * "Janelas" page (third page of the Deck tab): a to-scale map of your screens with every open window drawn
 * where it really is. Drag a window to move it, also from one screen to another; drag it to a screen's edge to
 * snap it (left half, right half) or to the top to maximize. Tap a window to select it and bring it to the
 * front. A bar underneath lists every window (including minimized and hidden ones) and has the actions for the
 * selected one. Each screen has its own brightness slider (DDC/CI) right under it.
 */
(() => {
  const { h, icon, api, toast, slider, holdButton } = Deck;

  const POLL_MS = 600; // the PC answers in ~12 ms, so reading often is cheap; actions also refresh right away
  const BRIGHT_H = 30; // room under the screens for the brightness sliders
  const DRAG_THRESHOLD = 6; // px before a touch counts as a drag instead of a tap
  const SIDE_ZONE = 0.18; // fraction of a screen's width that snaps left/right
  const TOP_ZONE = 0.14; // fraction of its height that maximizes
  const CLOSE_ARM_MS = 3000;

  let screens = []; // monitors, geometry in real pixels
  let windows = []; // from /api/windows, top of the stack first
  let selected = null; // handle of the selected window
  let drag = null;
  let layout = null;
  let pollTimer = null;
  let inFlight = false;
  let pollAgain = false; // a refresh was asked for while one was running: run again as soon as it ends
  let pending = 0; // actions sent and not yet answered: a poll in between would show the old picture
  const lastNormal = new Map(); // handle -> the rectangle a window had before it was maximized/snapped (for Restore)
  let armTimer = null;
  const STATE_LABEL = { 1: 'minimizada', 2: 'maximizada' };
  const seen = []; // handles in the order the chips are shown (new windows first, the rest keep their place)

  const post = (path, json) => api(path, { method: 'POST', json });
  const fail = (err) => toast(`Erro: ${err.message}`, true);

  // --- DOM ------------------------------------------------------------------------------------

  const map = h('div', { class: 'map' });
  const wrap = h('div', { class: 'map-wrap' }, map);
  const chips = h('div', { class: 'sel-chips' });
  const hint = h('div', { class: 'sel-hint', text: 'Toque numa janela para selecionar. Arraste para mover; até a borda de uma tela para encaixar. Toque no vazio para desmarcar.' });

  // The controls for the selected window live in a big-button panel on the right, and the list of windows on
  // top: both stay away from the bottom edge, which is the hardest part to reach when the phone sits in a stand.
  const winPanel = h('div', { class: 'card win-panel', hidden: true });
  let closeButton = null;

  // the hint lives under the map (not in the bar) so the window chips keep the whole bar
  const column = h('div', { class: 'wmap-col' }, chips, wrap, hint);

  // tapping the empty map (not a window, not a brightness slider) clears the selection
  wrap.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.mwin, .mon-bright')) select(null);
  });

  // --- layout ---------------------------------------------------------------------------------

  function computeLayout() {
    if (!screens.length) return null;
    const minX = Math.min(...screens.map((s) => s.left));
    const minY = Math.min(...screens.map((s) => s.top));
    const maxX = Math.max(...screens.map((s) => s.left + s.width));
    const maxY = Math.max(...screens.map((s) => s.top + s.height));
    const width = wrap.clientWidth;
    const height = wrap.clientHeight - BRIGHT_H - 6;
    if (width <= 0 || height <= 0) return null;
    const scale = Math.min(width / (maxX - minX), height / (maxY - minY));
    return { minX, minY, scale, width: (maxX - minX) * scale, height: (maxY - minY) * scale };
  }

  const toMap = (x, y) => ({ left: (x - layout.minX) * layout.scale, top: (y - layout.minY) * layout.scale });

  const iconFor = (win) => (win.appId
    ? h('img', { src: `/api/icon/${win.appId}?v=${win.iconVersion || ''}`, alt: '', draggable: 'false' })
    : h('b', { text: (win.app || win.title || '?').charAt(0).toUpperCase() }));

  // --- screens (static part of the map) ---------------------------------------------------------

  const hints = []; // one drop-zone highlight per screen
  let winLayer = null;

  function renderScreens() {
    layout = computeLayout();
    hints.length = 0;
    if (!layout) {
      map.replaceChildren();
      return;
    }
    map.style.width = `${layout.width}px`;
    map.style.height = `${layout.height + BRIGHT_H + 6}px`;

    const parts = [];
    screens.forEach((screen, index) => {
      const { left, top } = toMap(screen.left, screen.top);
      const width = screen.width * layout.scale;
      const height = screen.height * layout.scale;

      const zone = h('div', { class: 'hint' });
      hints[index] = zone;
      parts.push(h('div', { class: 'mon', style: `left:${left}px;top:${top}px;width:${width}px;height:${height}px` },
        h('span', { class: 'mon-num', text: `${index + 1}${screen.primary ? ' ★' : ''}` }), zone));

      // brightness sits right under its screen
      const value = h('span', { class: 'value' });
      let control;
      if (screen.brightness === null) {
        control = h('span', { class: 'muted small', text: 'sem controle de brilho' });
      } else {
        const brightness = slider({ onChange: (level) => post('/api/screens/brightness', { device: screen.device, level }) });
        brightness.set(screen.brightness);
        value.textContent = `${screen.brightness}%`;
        brightness.el.addEventListener('level', (event) => { value.textContent = `${event.detail}%`; });
        control = brightness.el;
      }
      parts.push(h('div', { class: 'mon-bright', style: `left:${left}px;top:${layout.height + 6}px;width:${width}px` }, icon('sun', 15), control, value));
    });

    layerEls = new Map();
    winLayer = h('div', { class: 'win-layer', style: `width:${layout.width}px;height:${layout.height}px` });
    parts.push(winLayer);
    map.replaceChildren(...parts);
    renderWindows();
  }

  // --- windows on the map -----------------------------------------------------------------------

  let layerEls = new Map(); // handle -> its element on the map

  // Updated in place on every poll: an element is created once per window and only its position, size, stacking
  // and title change afterwards. Nothing is replaced, so a press never lands on a node that is about to vanish,
  // and a change on the PC shows up on the very next poll.
  function renderWindows() {
    if (!layout || !winLayer || drag) return;
    // bottom-to-top so the stacking matches the real desktop
    const visible = windows.filter((win) => win.state !== 1 && win.w > 0).reverse();
    const alive = new Set();

    visible.forEach((win, index) => {
      alive.add(win.handle);
      let el = layerEls.get(win.handle);
      if (!el) {
        el = h('div', { class: 'mwin', data: { handle: win.handle } },
          h('div', { class: 'mwin-bar' }, h('span', { class: 'mwin-icon' }), h('span', { class: 'mwin-title' })));
        el.addEventListener('pointerdown', (event) => beginDrag(event, el._win, el));
        layerEls.set(win.handle, el);
        winLayer.appendChild(el);
      }
      el._win = win;

      const { left, top } = toMap(win.x, win.y);
      el.className = `mwin${win.state === 2 ? ' max' : ''}${win.handle === selected ? ' sel' : ''}`;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = `${win.w * layout.scale}px`;
      el.style.height = `${win.h * layout.scale}px`;
      el.style.zIndex = String(index + 1);
      el.style.transform = '';

      const iconKey = `${win.appId}:${win.iconVersion}:${win.app}`;
      if (el._iconKey !== iconKey) {
        el._iconKey = iconKey;
        el.querySelector('.mwin-icon').replaceChildren(iconFor(win));
      }
      const title = el.querySelector('.mwin-title');
      if (title.textContent !== win.title) title.textContent = win.title;
    });

    for (const [handle, el] of layerEls) {
      if (alive.has(handle)) continue;
      el.remove();
      layerEls.delete(handle);
    }
  }

  function monitorAt(px, py) {
    return screens.findIndex((screen) => {
      const { left, top } = toMap(screen.left, screen.top);
      return px >= left && px < left + screen.width * layout.scale && py >= top && py < top + screen.height * layout.scale;
    });
  }

  // which snap zone the pointer is in on that screen (null = plain move)
  function zoneAt(index, px, py) {
    if (index < 0) return null;
    const screen = screens[index];
    const { left, top } = toMap(screen.left, screen.top);
    const fx = (px - left) / (screen.width * layout.scale);
    const fy = (py - top) / (screen.height * layout.scale);
    if (fy < TOP_ZONE) return 'full';
    if (fx < SIDE_ZONE) return 'left';
    if (fx > 1 - SIDE_ZONE) return 'right';
    return null;
  }

  function showHint(index, zone) {
    hints.forEach((el, i) => {
      if (!el) return;
      const active = i === index && zone;
      el.style.display = active ? 'block' : 'none';
      if (active) {
        el.style.left = zone === 'right' ? '50%' : '0';
        el.style.width = zone === 'full' ? '100%' : '50%';
        el.style.top = '0';
        el.style.height = '100%';
      }
    });
  }

  function beginDrag(event, win, el) {
    event.preventDefault();
    if (drag && !drag.finishing) cancelDrag(); // a previous gesture that never ended must not block this one
    select(win.handle);
    el.setPointerCapture(event.pointerId);
    drag = { win, el, x: event.clientX, y: event.clientY, moved: false, index: -1, zone: null, at: Date.now(), finishing: false };

    el.onpointermove = (move) => {
      const dx = move.clientX - drag.x;
      const dy = move.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      el.classList.add('dragging');
      el.style.transform = `translate(${dx}px, ${dy}px)`;

      const box = map.getBoundingClientRect();
      const px = move.clientX - box.left;
      const py = move.clientY - box.top;
      drag.index = monitorAt(px, py);
      drag.zone = zoneAt(drag.index, px, py);
      showHint(drag.index, drag.zone);
    };
    el.onpointerup = (up) => finishDrag(up);
    el.onpointercancel = () => cancelDrag();
    // the browser took the finger away (the element was replaced, another gesture won): end the drag instead of hanging
    el.onlostpointercapture = () => { if (drag && drag.el === el && !drag.finishing) cancelDrag(); };
  }

  function cancelDrag() {
    if (!drag) return;
    drag.el.classList.remove('dragging');
    drag.el.style.transform = '';
    showHint(-1, null);
    drag = null;
    renderWindows();
  }

  async function finishDrag(up) {
    const { el, moved } = drag;
    const win = windows.find((item) => item.handle === drag.win.handle) || drag.win; // the current object, not a stale one
    drag.finishing = true;
    const dx = up.clientX - drag.x;
    const dy = up.clientY - drag.y;
    showHint(-1, null);

    // Decide from where the finger really is now: the last pointermove can be a few pixels behind it
    const box = map.getBoundingClientRect();
    const index = monitorAt(up.clientX - box.left, up.clientY - box.top);
    const zone = zoneAt(index, up.clientX - box.left, up.clientY - box.top);

    // what to ask the PC for, and what the map should already show
    let request = null;
    let local = null;
    if (!moved) {
      request = ['/api/windows/action', { handle: win.handle, action: 'focus' }];
      local = () => predict(win, 'focus');
    } else if (index >= 0 && zone) {
      request = ['/api/windows/snap', { handle: win.handle, monitor: index, zone }];
      local = () => predict(win, '', { monitor: index, zone }, '/api/windows/snap');
    } else if (index >= 0 && win.state === 2) {
      if (index !== win.monitor) {
        request = ['/api/windows/move', { handle: win.handle, monitor: index }];
        local = () => predict(win, '', { monitor: index }, '/api/windows/move');
      }
    } else if (index >= 0 && win.state === 0) {
      const x = Math.round(win.x + dx / layout.scale);
      const y = Math.round(win.y + dy / layout.scale);
      request = ['/api/windows/place', { handle: win.handle, x, y }];
      local = () => applyLocal(win, { x, y, monitor: index });
    }

    el.classList.remove('dragging');
    drag = null; // cleared first: while a drag is active nothing is redrawn
    if (local) local();
    el.style.transform = '';
    renderWindows();

    if (request) {
      pending += 1;
      try {
        await post(...request);
      } catch (err) {
        fail(err);
      } finally {
        pending -= 1;
      }
    }
    refreshSoon();
  }
  // --- selection bar ----------------------------------------------------------------------------

  // Only flips the highlight: redrawing the map here would replace the very element being pressed.
  function select(handle) {
    selected = handle;
    disarm();
    renderBar();
    winLayer?.querySelectorAll('.mwin').forEach((el) => el.classList.toggle('sel', Number(el.dataset.handle) === handle));
  }

  const current = () => windows.find((win) => win.handle === selected) || null;

  // --- instant feedback -------------------------------------------------------------------------
  // The PC applies an action in ~30 ms, but a poll only lands every so often. So an action first changes the picture
  // we already have (the map moves right away) and the polls that follow confirm it or correct it.

  // the geometry (where a window ends up) is a pure module, unit-tested in test/geometry.test.js
  function remember(win) {
    if (win.state === 0 && win.w > 0) lastNormal.set(win.handle, { x: win.x, y: win.y, w: win.w, h: win.h });
  }

  function applyLocal(win, change) {
    Object.assign(win, change);
    renderWindows();
    renderBar();
    renderList();
  }

  function predict(win, action, extra = {}, path = '/api/windows/action') {
    const request = { action };
    if (path === '/api/windows/snap') request.snap = { monitor: extra.monitor, zone: extra.zone };
    else if (path === '/api/windows/move') request.move = { monitor: extra.monitor };

    if (!screens.length) return; // geometry not loaded yet: the next poll shows the real result
    remember(win); // before it changes: this is what Restore will bring back
    const change = DeckGeometry.predict({ screens, windows, saved: lastNormal.get(win.handle) }, win, request);
    if (action === 'focus') {
      // to the front of the stack
      const at = windows.indexOf(win);
      if (at >= 0) windows.splice(at, 1);
      windows.unshift(win);
    }
    if (change) applyLocal(win, change);
  }
  function refreshSoon() {
    [60, 220, 520, 1100].forEach((ms) => setTimeout(poll, ms));
  }

  async function act(action, extra = {}, path = '/api/windows/action') {
    const win = current();
    if (!win) return;
    predict(win, action, extra, path);
    pending += 1;
    try {
      await post(path, { handle: win.handle, action, ...extra });
    } catch (err) {
      fail(err);
    } finally {
      pending -= 1;
    }
    refreshSoon();
  }
  // big, labelled touch targets (the panel is built for a phone in a stand, not for a fingertip held an inch away)
  const big = (label, glyph, onTap, className = '') => h('button', {
    type: 'button',
    class: `bigbtn ${className}`.trim(),
    'aria-label': label,
    on: { click: onTap },
  }, icon(glyph, 24), h('span', { text: label }));

  function disarm() {
    clearTimeout(armTimer);
    armTimer = null;
    if (!closeButton) return;
    closeButton.removeAttribute('data-armed');
    closeButton.replaceChildren(icon('close', 24), h('span', { text: 'Fechar' }));
  }

  // The chips are updated in place and the panel is rebuilt only when its buttons change (not when a title does).
  // Replacing a button between the finger going down and coming up would lose that tap.
  const chipEls = new Map(); // handle -> chip button
  let panelSignature = '';
  let panelTitle = null;
  let panelMeta = null;
  let scrolledTo = null;

  function renderBar() {
    const win = current();

    // chips: every window, stable order (new ones first)
    const handles = new Set(windows.map((w) => w.handle));
    for (let i = seen.length - 1; i >= 0; i -= 1) if (!handles.has(seen[i])) seen.splice(i, 1);
    windows.filter((w) => !seen.includes(w.handle)).reverse().forEach((w) => seen.unshift(w.handle));
    const byHandle = new Map(windows.map((w) => [w.handle, w]));

    seen.forEach((handle, position) => {
      const item = byHandle.get(handle);
      let chip = chipEls.get(handle);
      if (!chip) {
        chip = h('button', { type: 'button', on: { click: () => { select(handle); act('focus'); } } });
        chipEls.set(handle, chip);
      }
      chip.className = `chip big-chip${item.state === 1 ? ' dim' : ''}`;
      chip.setAttribute('aria-pressed', String(handle === selected));
      const label = item.title || item.app;
      if (chip.textContent !== label) chip.textContent = label;
      if (chips.children[position] !== chip) chips.insertBefore(chip, chips.children[position] || null);
    });
    for (const [handle, chip] of chipEls) {
      if (byHandle.has(handle)) continue;
      chip.remove();
      chipEls.delete(handle);
    }
    // keep the selected chip in view (once per selection, not on every poll)
    if (scrolledTo !== selected) {
      scrolledTo = selected;
      chipEls.get(selected)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    renderPanel(win);
  }

  // The selected window's controls, in big labelled buttons. Without a selection the same spot shows the screens' controls.
  function renderPanel(win) {
    screensCard.hidden = Boolean(win);
    winPanel.hidden = !win;
    // hidden but still taking its space: if it vanished the map would re-center and slide under the finger mid-drag
    hint.style.visibility = win ? 'hidden' : 'visible';
    if (!win) {
      panelSignature = '';
      return;
    }

    const metaText = [win.app, STATE_LABEL[win.state], screens.length > 1 ? `Tela ${win.monitor + 1}` : ''].filter(Boolean).join(' · ');
    const signature = `${win.handle}:${win.state}:${win.monitor}:${screens.length}`;
    if (signature === panelSignature) {
      // same buttons: only the text can differ (a title that changes must not cost a tap)
      if (panelTitle.textContent !== win.title) panelTitle.textContent = win.title;
      if (panelMeta.textContent !== metaText) panelMeta.textContent = metaText;
      return;
    }
    panelSignature = signature;
    panelTitle = h('b', { text: win.title });
    panelMeta = h('span', { class: 'muted', text: metaText });

    closeButton = big('Fechar', 'close', () => {
      if (closeButton.dataset.armed === 'true') {
        disarm();
        act('close');
        return;
      }
      closeButton.dataset.armed = 'true';
      closeButton.replaceChildren(icon('close', 24), h('span', { text: 'Toque de novo' }));
      armTimer = setTimeout(disarm, CLOSE_ARM_MS);
    }, 'danger');

    const screenIndex = Math.max(0, win.monitor);
    const maximized = win.state === 2;
    winPanel.replaceChildren(
      h('div', { class: 'panel-title' }, panelTitle, panelMeta),
      h('div', { class: 'bigs' },
        big('Minimizar', 'minimize', () => act('minimize')),
        big(maximized ? 'Restaurar' : 'Maximizar', maximized ? 'restore' : 'maximize', () => act(maximized ? 'restore' : 'maximize')),
        big('Esquerda', 'snapLeft', () => act('', { monitor: screenIndex, zone: 'left' }, '/api/windows/snap')),
        big('Direita', 'snapRight', () => act('', { monitor: screenIndex, zone: 'right' }, '/api/windows/snap')),
        screens.length > 1 ? big('Outra tela', 'swap', () => act('', { monitor: (screenIndex + 1) % screens.length }, '/api/windows/move')) : null,
        closeButton),
    );
  }
  // --- data -----------------------------------------------------------------------------------

  async function poll() {
    // a drag whose element is gone, or that has been 'in progress' for 10 s, is a lost gesture: forget it
    if (drag && (!drag.el.isConnected || (!drag.finishing && Date.now() - drag.at > 10000))) {
      drag = null;
      renderWindows();
    }
    if (drag || pending > 0 || document.hidden) return;
    if (inFlight) {
      pollAgain = true; // do not lose a refresh that was asked for during another one
      return;
    }
    inFlight = true;
    try {
      // a request that never answers must not freeze the map: give up after a few seconds and try again
      const reply = await Promise.race([api('/api/windows'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))]);
      windows = reply.windows;
      windows.forEach((win) => remember(win));
      if (selected && !windows.some((win) => win.handle === selected)) selected = null;
      renderWindows();
      renderBar();
      renderList();
    } catch {
      // keep what is on screen; the header's connection indicator reports outages
    } finally {
      inFlight = false;
      if (pollAgain) {
        pollAgain = false;
        poll();
      }
    }
  }
  async function loadScreens() {
    try {
      screens = (await api('/api/screens')).monitors;
      renderScreens();
    } catch {
      // without the layout there is no map, but the rest of the deck still works
    }
  }

  // --- screen-wide controls ---------------------------------------------------------------------

  async function project(mode, confirm = false) {
    try {
      await post('/api/screens/project', { mode, confirm });
      toast('Mudando a projeção…');
      setTimeout(loadScreens, 3000);
    } catch (err) {
      fail(err);
    }
  }

  const screensCard = h('div', { class: 'card' },
    h('h3', { text: 'Telas' }),
    h('div', { class: 'screens-extra' },
      h('button', { type: 'button', class: 'chip wide', text: 'Desligar telas', on: { click: () => post('/api/screens/off').then(() => toast('Telas desligadas (mexa o mouse para acordar)'), fail) } }),
      h('button', { type: 'button', class: 'chip wide', text: 'Estender', on: { click: () => project('extend') } }),
      h('button', { type: 'button', class: 'chip wide', text: 'Duplicar', on: { click: () => project('clone') } }),
      // modes that leave a single screen on: held, so nobody ends up with a black monitor by accident
      holdButton('Só tela 1', () => project('first', true), { className: 'small' }),
      holdButton('Só tela 2', () => project('second', true), { className: 'small' })));

  const el = h('section', { class: 'windows-page' }, column, h('div', { class: 'win-side' }, winPanel, screensCard));

  new ResizeObserver(() => { if (screens.length) renderScreens(); }).observe(wrap);

  // --- the list on the shortcuts page -----------------------------------------------------------
  // Every open window, one tap away from the shortcuts: tap a row to bring it to the front, or use its two buttons to
  // minimize / maximize it. The map (drag and drop, brightness, projection) opens as a sheet from the "Mapa" button.

  const rows = new Map(); // handle -> row
  const listBody = h('div', { class: 'scroll wlist-body' });
  const mapSheet = Deck.overlay({
    title: 'Janelas e telas',
    el,
    onOpen() { visible.map = true; sync(); },
    onClose() { visible.map = false; sync(); },
  });
  const mapButton = h('button', { type: 'button', class: 'chip', 'aria-label': 'Abrir o mapa de telas', on: { click: () => mapSheet.open() } }, icon('grid', 15), h('span', { text: 'Mapa' }));
  const listEl = h('div', { class: 'card wlist' }, h('div', { class: 'head' }, h('h3', { text: 'Janelas' }), mapButton), listBody);

  function windowAction(handle, action) {
    selected = handle;
    act(action);
  }

  function makeRow(handle) {
    const iconBox = h('span', { class: 'wicon' });
    const title = h('span', { class: 'wtitle' });
    const shrink = h('button', { type: 'button', class: 'wbtn' });
    const grow = h('button', { type: 'button', class: 'wbtn' });
    const row = h('div', { class: 'wrow' },
      h('button', { type: 'button', class: 'wmain', on: { click: () => windowAction(handle, 'focus') } }, iconBox, title),
      shrink, grow);
    shrink.addEventListener('click', () => windowAction(handle, row._win.state === 1 ? 'focus' : 'minimize'));
    grow.addEventListener('click', () => windowAction(handle, row._win.state === 2 ? 'restore' : 'maximize'));
    Object.assign(row, { _icon: iconBox, _title: title, _shrink: shrink, _grow: grow });
    return row;
  }

  function renderList() {
    const byHandle = new Map(windows.map((win) => [win.handle, win]));
    const frontmost = windows.find((win) => win.state !== 1);

    seen.forEach((handle, position) => {
      const win = byHandle.get(handle);
      if (!win) return;
      let row = rows.get(handle);
      if (!row) {
        row = makeRow(handle);
        rows.set(handle, row);
      }
      row._win = win;
      row.className = `wrow${win.state === 1 ? ' dim' : ''}${win === frontmost ? ' front' : ''}`;
      // the app's name fits the narrow column and is what you look for; the full title is the tooltip
      const label = win.app || win.title;
      if (row._title.textContent !== label) row._title.textContent = label;
      row.title = win.title;

      const iconKey = `${win.appId}:${win.iconVersion}:${win.app}`;
      if (row._iconKey !== iconKey) {
        row._iconKey = iconKey;
        row._icon.replaceChildren(iconFor(win));
      }
      // the buttons show what they will do now
      if (row._state !== win.state) {
        row._state = win.state;
        row._shrink.setAttribute('aria-label', win.state === 1 ? 'Restaurar' : 'Minimizar');
        row._shrink.replaceChildren(icon(win.state === 1 ? 'restore' : 'minimize', 22));
        row._grow.setAttribute('aria-label', win.state === 2 ? 'Restaurar' : 'Maximizar');
        row._grow.replaceChildren(icon(win.state === 2 ? 'restore' : 'maximize', 22));
      }
      if (listBody.children[position] !== row) listBody.insertBefore(row, listBody.children[position] || null);
    });
    for (const [handle, row] of rows) {
      if (byHandle.has(handle)) continue;
      row.remove();
      rows.delete(handle);
    }
  }

  // polling runs only while the list or the map is on screen
  const visible = { list: false, map: false };
  function sync() {
    clearInterval(pollTimer);
    pollTimer = null;
    if (!visible.list && !visible.map) return;
    if (!screens.length) loadScreens(); // actions predict their result from the screens' geometry
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }

  Deck.windowsUi = { list: listEl };
  Deck.lifecycle['shortcuts-0'] = {
    show() { visible.list = true; sync(); },
    hide() { visible.list = false; sync(); },
  };
})();
