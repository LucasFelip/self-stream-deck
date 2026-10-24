'use strict';

/**
 * Shared toolkit for the deck UI: API client, toast, haptics, formatters and the page registry.
 * Page modules (media.js, audio.js, ...) register themselves here; app.js owns the pager.
 */
window.Deck = (() => {
  const $ = (id) => document.getElementById(id);

  // h('div', { class: 'x', text: 'hi', on: { click } }, child, child)
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'on') for (const [name, handler] of Object.entries(value)) el.addEventListener(name, handler);
      else if (key === 'data') Object.assign(el.dataset, value);
      else if (key === 'style') el.style.cssText = value;
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, value);
    }
    el.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
    return el;
  }

  // inline SVG icons, 24x24, stroke only (same style as the header buttons)
  const ICONS = {
    prev: '<path d="M6 5v14M19 5l-9 7 9 7V5z"/>',
    next: '<path d="M18 5v14M5 5l9 7-9 7V5z"/>',
    play: '<path d="M7 4l13 8-13 8V4z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    note: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
    speaker: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    muted: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9l5 6M22 9l-5 6" class="err"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    micOff: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/><path d="M3 3l18 18" class="err"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    sleep: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
    hibernate: '<path d="M12 3v9M7 6.5a7.5 7.5 0 1 0 10 0"/><path d="M9 15l3 3 3-3"/>',
    logout: '<path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/>',
    restart: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    power: '<path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/>',
    chip: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
    wrench: '<path d="M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2-.5-.5-2z"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    minimize: '<path d="M6 18h12"/>',
    maximize: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
    restore: '<rect x="9" y="4" width="11" height="11" rx="1.5"/><path d="M4 9v10a1 1 0 0 0 1 1h10"/>',
    swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    snapLeft: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4.6 5.6h7.4v12.8H4.6z" fill="currentColor" stroke="none" opacity=".55"/>',
    snapRight: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M12 5.6h7.4v12.8H12z" fill="currentColor" stroke="none" opacity=".55"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    camera: '<path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8z"/><circle cx="12" cy="12.5" r="3.5"/>',
    keys: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  };

  function icon(name, size) {
    const svg = h('span', { class: 'ico', 'aria-hidden': 'true' });
    svg.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name] || ''}</svg>`;
    if (size) svg.style.setProperty('--size', `${size}px`);
    return svg;
  }

  // --- feedback -------------------------------------------------------------------------------

  const toastEl = $('toast');
  let toastTimer;
  function toast(message, isError = false) {
    toastEl.textContent = message;
    toastEl.classList.toggle('error', isError);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2000);
  }

  // Haptics: the Android shell exposes a native vibrator (the WebView's own navigator.vibrate is unreliable);
  // a normal browser falls back to the Vibration API where it exists.
  function vibrate(ms = 10) {
    try {
      if (window.Android && typeof window.Android.vibrate === 'function') window.Android.vibrate(ms);
      else if (navigator.vibrate) navigator.vibrate(ms);
    } catch {
      // haptics are optional
    }
  }

  // --- API ------------------------------------------------------------------------------------

  async function api(path, { method = 'GET', json, signal } = {}) {
    const options = { method, credentials: 'same-origin', signal };
    if (json !== undefined) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(json);
    }
    const response = await fetch(path, options);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw Object.assign(new Error(body.error || response.statusText), { status: response.status });
    }
    return response.json();
  }

  // --- formatting -----------------------------------------------------------------------------

  const pad = (n) => String(n).padStart(2, '0');

  const fmt = {
    clock(seconds) {
      if (!Number.isFinite(seconds)) return '–:––';
      const s = Math.max(0, Math.floor(seconds));
      const hours = Math.floor(s / 3600);
      const minutes = Math.floor((s % 3600) / 60);
      return hours ? `${hours}:${pad(minutes)}:${pad(s % 60)}` : `${minutes}:${pad(s % 60)}`;
    },
    duration(seconds) {
      const s = Math.max(0, Math.floor(seconds));
      const days = Math.floor(s / 86400);
      const hours = Math.floor((s % 86400) / 3600);
      const minutes = Math.floor((s % 3600) / 60);
      if (days) return `${days}d ${hours}h ${minutes}min`;
      if (hours) return `${hours}h ${pad(minutes)}min`;
      return `${minutes}min`;
    },
    bytes(value) {
      if (!Number.isFinite(value)) return '–';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let n = value;
      let i = 0;
      while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
      return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
    },
    rate: (value) => (Number.isFinite(value) ? `${Deck.fmt.bytes(value)}/s` : '–'),
    gb: (mb) => (Number.isFinite(mb) ? `${(mb / 1024).toFixed(1)} GB` : '–'),
    pct: (value) => (Number.isFinite(value) ? `${Math.round(value)}%` : '–'),
    date: (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–'),
    dateTime: (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–'),
  };

  // --- slider with a throttled "latest value wins" sender -------------------------------------

  /**
   * Range input that reports changes while dragging, but never has more than one request in flight:
   * newer positions replace older ones. `set()` updates the display from outside (e.g. polling) without
   * fighting the user's finger.
   */
  function slider({ onChange, className = '' }) {
    const input = h('input', { type: 'range', min: 0, max: 100, step: 1, value: 0, class: `range ${className}` });
    let dragging = false;
    let timer;
    let pending = null;
    let sending = false;

    const paint = (value) => input.style.setProperty('--fill', `${value}%`);

    async function flush() {
      if (sending || pending === null) return;
      sending = true;
      const value = pending;
      pending = null;
      try {
        await onChange(value);
      } catch (err) {
        toast(`Erro: ${err.message}`, true);
      }
      sending = false;
      flush();
    }

    input.addEventListener('pointerdown', () => { dragging = true; clearTimeout(timer); });
    const end = () => { clearTimeout(timer); timer = setTimeout(() => { dragging = false; }, 400); };
    input.addEventListener('pointerup', end);
    input.addEventListener('pointercancel', end);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      paint(value);
      input.dispatchEvent(new CustomEvent('level', { detail: value }));
      pending = value;
      flush();
    });

    return {
      el: input,
      isDragging: () => dragging,
      set(value) {
        if (dragging || !Number.isFinite(value)) return;
        input.value = value;
        paint(value);
      },
      disable(disabled) { input.disabled = disabled; },
    };
  }

  // --- hold to confirm ------------------------------------------------------------------------

  /** A button that only fires after being held (1.2 s by default), with a fill that shows the progress. */
  function holdButton(label, onDone, { ms = 1200, className = '' } = {}) {
    const button = h('button', { type: 'button', class: `hold ${className}`.trim(), style: `--hold-ms:${ms}ms` }, h('span', { text: label }));
    let timer = null;

    const start = (event) => {
      event.preventDefault();
      if (timer) return;
      button.classList.add('holding');
      vibrate(15);
      timer = setTimeout(() => {
        timer = null;
        button.classList.remove('holding');
        vibrate(80);
        onDone();
      }, ms);
    };
    const stop = () => {
      clearTimeout(timer);
      timer = null;
      button.classList.remove('holding');
    };
    button.addEventListener('pointerdown', start);
    for (const name of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(name, stop);
    button.addEventListener('contextmenu', (event) => event.preventDefault());
    return button;
  }
  // --- page registry --------------------------------------------------------------------------

  const pages = [];
  /** def: { id, title, el, show?(), hide?() } - show/hide fire when the page becomes/stops being the visible one. */
  function addPage(def) { pages.push(def); }

  // show/hide hooks for pages that app.js generates itself (the shortcuts page hosts the windows list): id -> { show, hide }
  const lifecycle = {};

  // entries the header's menu shows besides its own: { label, onClick }
  const menuItems = [];

  // A full-screen panel over the deck (the screen map, the system info): one tap in the menu or on a button opens it,
  // one tap on its close button returns. onOpen/onClose are where a panel starts and stops its polling.
  // the overlays that are open, oldest first: Deck.back() closes the newest
  const openOverlays = [];

  function overlay({ title, el, onOpen, onClose }) {
    const closeButton = h('button', { type: 'button', class: 'overlay-close', 'aria-label': 'Fechar' }, icon('close', 22), h('span', { text: 'Fechar' }));
    const root = h('div', { class: 'overlay', hidden: true, role: 'dialog', 'aria-label': title },
      h('div', { class: 'overlay-bar' }, h('b', { text: title }), closeButton),
      h('div', { class: 'overlay-body' }, el));
    document.body.append(root);

    const control = {
      open() {
        if (!root.hidden) return;
        root.hidden = false;
        openOverlays.push(control);
        if (onOpen) onOpen();
      },
      close() {
        if (root.hidden) return;
        root.hidden = true;
        const at = openOverlays.indexOf(control);
        if (at !== -1) openOverlays.splice(at, 1);
        if (onClose) onClose();
      },
      get isOpen() { return !root.hidden; },
    };
    closeButton.addEventListener('click', control.close);
    return control;
  }

  /**
   * The Android Back button (MainActivity calls this) and any "go back" gesture. Undoes one thing per call, newest first:
   * the sheet in #modal-root, the open menu, the newest overlay; with nothing open, any page but Apps goes to Apps.
   * Returns true if it did something, false if already on Apps with nothing open (the shell then ignores the press:
   * a stray Back must not drop the deck).
   */
  function back() {
    const sheet = $('modal-root').lastElementChild;
    if (sheet) {
      sheet.remove();
      return true;
    }
    const menu = $('menu-pop');
    if (menu && !menu.hidden) {
      menu.hidden = true;
      return true;
    }
    const top = openOverlays[openOverlays.length - 1];
    if (top) {
      top.close();
      return true;
    }
    if (Deck.pager && Deck.pager.currentSection() !== 'apps') return Deck.goTo('apps-0');
    return false;
  }

  return { $, h, icon, api, toast, vibrate, fmt, slider, holdButton, pages, addPage, lifecycle, menuItems, overlay, back, state: { online: false } };
})();
