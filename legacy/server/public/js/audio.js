'use strict';

/**
 * "Áudio" page: everything the Windows Sound settings offer, reachable from the phone:
 *   Saída    - pick the default playback device, set its volume / mute
 *   Entrada  - pick the default microphone, set its volume / mute (a big one for streaming)
 *   Apps     - per-application volume mixer
 */
(() => {
  const { h, icon, api, toast, slider } = Deck;

  const POLL_MS = 2000;
  let watcher = null; // live updates (or the fallback poller) while the page is the visible one

  const post = (path, json) => api(path, { method: 'POST', json });
  const fail = (err) => toast(`Erro: ${err.message}`, true);

  /** One line: [mute] [label] [slider] [value]. set() refreshes it from server data. */
  function volumeRow({ label, icons, onLevel, onMute }) {
    const value = h('span', { class: 'value', text: '–' });
    const volume = slider({ onChange: onLevel });
    const mute = h('button', { type: 'button', class: 'icon-btn', 'aria-pressed': 'false', 'aria-label': 'Silenciar' }, icon(icons[0]));
    const row = h('div', { class: `vol-row${label ? ' labeled' : ''}`, data: { muted: 'false' } }, mute, label ? h('span', { class: 'label', text: label }) : null, volume.el, value);
    let muted = false;

    volume.el.addEventListener('level', (event) => {
      value.textContent = `${event.detail}%`;
      row.dataset.muted = 'false';
      mute.setAttribute('aria-pressed', 'false');
    });
    mute.addEventListener('click', () => onMute(!muted));

    return {
      el: row,
      set({ level, muted: isMuted }) {
        muted = Boolean(isMuted);
        volume.set(level);
        if (!volume.isDragging()) value.textContent = Number.isFinite(level) ? (muted ? 'mudo' : `${level}%`) : '–';
        row.dataset.muted = String(muted);
        mute.setAttribute('aria-pressed', String(muted));
        mute.replaceChildren(icon(muted ? icons[1] : icons[0]));
        volume.disable(!Number.isFinite(level));
      },
      setLabel(text) { const el = row.querySelector('.label'); if (el) el.textContent = text; },
      setInactive(inactive) { row.classList.toggle('inactive', inactive); },
    };
  }

  /** Radio-style chips of devices (the active one is lit); rebuilt only when the set of devices or the default changes. */
  function deviceList(onPick) {
    const list = h('div', { class: 'device-list', role: 'radiogroup' });
    return {
      el: list,
      render(devices, emptyText) {
        const signature = devices.map((device) => `${device.id}:${device.default}`).join('|');
        if (list.dataset.sig === signature) return;
        list.dataset.sig = signature;
        if (!devices.length) {
          list.replaceChildren(h('div', { class: 'audio-empty', text: emptyText }));
          return;
        }
        list.replaceChildren(...devices.map((device) => h('button', {
          type: 'button',
          class: 'device',
          role: 'radio',
          'aria-checked': String(device.default),
          on: { click: () => { if (!device.default) onPick(device); } },
        },
        h('span', { class: 'mark' }),
        h('span', { class: 'name' }, device.name, device.adapter ? h('small', { text: device.adapter }) : null))));
      },
    };
  }

  // --- Saída ----------------------------------------------------------------------------------

  let playbackDefault = null;
  const outputList = deviceList(async (device) => {
    try {
      await post('/api/audio/default', { id: device.id });
      toast(`Saída: ${device.name}`);
    } catch (err) { fail(err); }
    poll();
  });
  const outputRow = volumeRow({
    icons: ['speaker', 'muted'],
    onLevel: (level) => (playbackDefault ? post('/api/audio/device', { id: playbackDefault.id, level }) : null),
    onMute: (muted) => (playbackDefault ? post('/api/audio/device', { id: playbackDefault.id, muted }).then(poll, fail) : null),
  });
  const outputCard = h('div', { class: 'card audio-out' }, h('h3', { text: 'Saída' }), outputRow.el, h('div', { class: 'scroll' }, outputList.el));

  // --- Entrada --------------------------------------------------------------------------------

  let captureDefault = null;
  const inputList = deviceList(async (device) => {
    try {
      await post('/api/audio/default', { id: device.id });
      toast(`Microfone: ${device.name}`);
    } catch (err) { fail(err); }
    poll();
  });
  const inputRow = volumeRow({
    icons: ['mic', 'micOff'],
    onLevel: (level) => (captureDefault ? post('/api/audio/device', { id: captureDefault.id, level }) : null),
    onMute: (muted) => (captureDefault ? post('/api/audio/device', { id: captureDefault.id, muted }).then(poll, fail) : null),
  });
  const inputCard = h('div', { class: 'card audio-in' }, h('h3', { text: 'Entrada' }), inputRow.el, h('div', { class: 'scroll' }, inputList.el));

  // --- Aplicativos ----------------------------------------------------------------------------

  const mixer = h('div', { class: 'mixer' });
  const mixerCard = h('div', { class: 'card audio-mixer' }, h('h3', { text: 'Aplicativos' }), h('div', { class: 'scroll' }, mixer));
  const mixerRows = new Map(); // session key -> row

  function renderMixer(sessions) {
    const keys = sessions.map((s) => (s.system ? 'system' : String(s.pid)));
    for (const [key, row] of mixerRows) {
      if (!keys.includes(key)) {
        row.el.remove();
        mixerRows.delete(key);
      }
    }

    sessions.forEach((session, index) => {
      const key = keys[index];
      let row = mixerRows.get(key);
      if (!row) {
        const target = () => ({ pid: session.pid, system: session.system });
        row = volumeRow({
          label: session.label,
          icons: ['speaker', 'muted'],
          onLevel: (level) => post('/api/audio/session', { ...target(), level }),
          onMute: (muted) => post('/api/audio/session', { ...target(), muted }).then(poll, fail),
        });
        mixerRows.set(key, row);
      }
      row.setLabel(session.label);
      row.setInactive(!session.active);
      row.set(session);
      if (mixer.children[index] !== row.el) mixer.insertBefore(row.el, mixer.children[index] || null);
    });

    mixer.querySelector('.audio-empty')?.remove();
    if (!sessions.length) mixer.append(h('div', { class: 'audio-empty', text: 'Nenhum aplicativo com áudio aberto.' }));
  }

  // --- data -----------------------------------------------------------------------------------

  function render({ playback, capture, sessions }) {
    playbackDefault = playback.find((device) => device.default) || null;
    captureDefault = capture.find((device) => device.default) || null;

    outputList.render(playback, 'Nenhuma saída de áudio ativa.');
    inputList.render(capture, 'Nenhum microfone ativo.');
    outputRow.set(playbackDefault || {});
    inputRow.set(captureDefault || {});
    renderMixer(sessions);
  }

  // reads once more right away (after an action); the live stream or the fallback poller keeps it fresh otherwise
  async function poll() {
    if (document.hidden) return;
    try {
      render(await api('/api/audio'));
    } catch {
      // keep what is on screen; the connection light in the navigation reports outages
    }
  }

  const el = h('section', { class: 'audio-page' }, outputCard, inputCard, mixerCard);

  // the other half of the "Som" page (see sound.js)
  Deck.sound = Deck.sound || {};
  Deck.sound.audio = {
    el,
    show() {
      if (watcher) watcher.stop();
      watcher = Deck.live.watch('audio', { apply: render, poll: () => api('/api/audio'), ms: POLL_MS, idleMs: 4000, idleAfter: 8 });
    },
    hide() {
      if (watcher) watcher.stop();
      watcher = null;
    },
  };
})();
