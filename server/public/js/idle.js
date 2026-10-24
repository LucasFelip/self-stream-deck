'use strict';

/**
 * Idle dimmer for the AMOLED screen (menu ⚙ > Escurecer após…). After N minutes without a touch a black veil covers the deck and, in the
 * Android shell, window.Android.setDim(true) drops the screen brightness. The first touch only wakes it: the veil swallows that tap, so
 * it never reaches the key underneath. Never dims while the camera transmits, a power action is scheduled, edit mode / a sheet / an
 * overlay / the menu is open, or a finger is down (a slider or a drag in progress): it just checks again later.
 * The choice (minutes, 0 = off) lives in localStorage (`ssd.idleMinutes`) inside try/catch; off by default.
 */
(() => {
  const { $, h } = Deck;
  const KEY = 'ssd.idleMinutes';
  const OPTIONS = [{ id: '0', label: 'Desligado' }, { id: '1', label: '1 min' }, { id: '2', label: '2 min' }, { id: '5', label: '5 min' }];
  const RETRY_MS = 5000;
  const WAKE_GUARD_MS = 400; // the veil stays (invisible) a moment so the click that ends the waking tap still lands on it

  const read = () => {
    try {
      const value = Number(localStorage.getItem(KEY));
      return OPTIONS.some((option) => option.id === String(value)) ? value : 0;
    } catch { return 0; }
  };
  let minutes = read();
  let lastActivity = Date.now();
  let timer = null;
  let guardTimer = null;
  let dimmed = false;
  let fingers = 0;

  const veil = h('div', { class: 'idle-veil', hidden: true, 'aria-hidden': 'true' });
  document.body.append(veil);

  const hasDim = () => Boolean(window.Android && typeof window.Android.setDim === 'function');
  const setNativeDim = (on) => {
    if (!hasDim()) return;
    try { window.Android.setDim(on); } catch { /* the shell is optional */ }
  };

  const busy = () => {
    const pc = Deck.pc && Deck.pc.state;
    return fingers > 0
      || Boolean(Deck.camera && Deck.camera.sending)
      || Boolean(pc && pc.scheduled)
      || document.body.classList.contains('editing')
      || $('modal-root').childElementCount > 0
      || Boolean(document.querySelector('.overlay:not([hidden])'))
      || !$('menu-pop').hidden;
  };

  function arm() {
    clearTimeout(timer);
    timer = null;
    if (!minutes || dimmed) return;
    const wait = Math.max(0, lastActivity + minutes * api.unitMs - Date.now());
    timer = setTimeout(() => {
      if (busy()) {
        lastActivity = Date.now() - (minutes * api.unitMs) + Math.min(RETRY_MS, minutes * api.unitMs); // look again soon
        arm();
        return;
      }
      dim();
    }, wait);
  }

  function dim() {
    dimmed = true;
    clearTimeout(guardTimer);
    veil.classList.remove('waking');
    veil.hidden = false;
    setNativeDim(true);
  }

  function wake() {
    dimmed = false;
    lastActivity = Date.now();
    setNativeDim(false);
    veil.classList.add('waking');
    clearTimeout(guardTimer);
    guardTimer = setTimeout(() => { veil.hidden = true; veil.classList.remove('waking'); }, WAKE_GUARD_MS);
    arm();
  }

  // the veil sits above everything: whatever touches it only wakes the screen
  for (const name of ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend', 'mousedown']) {
    veil.addEventListener(name, (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (dimmed && (name === 'pointerdown' || name === 'touchstart' || name === 'click' || name === 'mousedown')) wake();
    });
  }

  const touch = () => { if (!dimmed) { lastActivity = Date.now(); arm(); } };
  document.addEventListener('pointerdown', () => { fingers += 1; touch(); }, { capture: true, passive: true });
  for (const name of ['pointerup', 'pointercancel']) {
    document.addEventListener(name, () => { fingers = Math.max(0, fingers - 1); touch(); }, { capture: true, passive: true });
  }
  document.addEventListener('pointermove', () => { if (fingers) touch(); }, { capture: true, passive: true });

  function set(value) {
    minutes = OPTIONS.some((option) => option.id === String(value)) ? Number(value) : 0;
    try { localStorage.setItem(KEY, String(minutes)); } catch { /* no storage: it lasts until the page reloads */ }
    lastActivity = Date.now();
    if (!minutes && dimmed) wake();
    arm();
  }

  // --- the picker ---------------------------------------------------------------------------------------------
  const picker = Deck.segmented(OPTIONS, (id) => set(id), 'Escurecer após');
  const note = h('p', { class: 'muted', text: 'Escurece a tela depois desse tempo sem toque. O primeiro toque só acorda a tela.' });
  const sheet = Deck.overlay({
    title: 'Escurecer após…',
    el: h('section', { class: 'idle-page' }, picker.el, note),
    onOpen: () => picker.set(String(minutes)),
  });
  Deck.menuItems.push({ label: 'Escurecer após…', onClick: () => sheet.open() });

  const api = {
    unitMs: 60000, // one "minute"; tests shrink it
    set,
    get minutes() { return minutes; },
    get dimmed() { return dimmed; },
    openSheet: () => sheet.open(),
  };
  Deck.idle = api;
  arm();
})();
