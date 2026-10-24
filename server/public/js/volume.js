'use strict';

/**
 * The volume: the strip (mute, slider, media keys) lives in #volume-panel, opened by #vol-btn (first button of the live strip), which
 * also shows the level and the muted state, so the volume is one tap away from any page.
 */
(() => {
  const { $, api, toast: showToast } = Deck;

  const box = $('volume');
  const slider = $('vol');
  const value = $('vol-value');
  const muteButton = $('mute');
  const button = $('vol-btn');
  const buttonIcon = button.querySelector('.vol-btn-ico');
  const buttonPct = $('vol-pct');
  const panel = $('volume-panel');

  let dragging = false;
  let dragTimer;

  let shownMuted = null;
  function paintButton(level, muted) {
    buttonPct.textContent = muted ? 'mudo' : `${level}%`;
    button.dataset.muted = String(muted);
    button.title = muted ? 'Volume: mudo' : `Volume ${level}%`;
    if (shownMuted !== muted) {
      shownMuted = muted;
      buttonIcon.replaceChildren(Deck.icon(muted ? 'muted' : 'speaker', 18));
    }
  }

  function render({ level, muted }) {
    box.dataset.ready = 'true';
    box.dataset.muted = String(muted);
    if (!dragging) {
      paintButton(level, muted);
      slider.value = level;
      slider.style.setProperty('--fill', `${level}%`);
      value.textContent = muted ? 'mudo' : `${level}%`;
    }
  }

  async function refresh() {
    try {
      render(await api('/api/volume'));
    } catch {
      box.dataset.ready = 'false';
    }
  }

  // Only the newest slider position matters, so while one request is in flight the rest collapse into one.
  let pendingLevel = null;
  let sending = false;
  async function flush() {
    if (sending || pendingLevel === null) return;
    sending = true;
    const level = pendingLevel;
    pendingLevel = null;
    try {
      render(await api('/api/volume', { method: 'POST', json: { level } }));
    } catch (err) {
      showToast(`Erro: ${err.message}`, true);
    }
    sending = false;
    flush();
  }

  slider.addEventListener('pointerdown', () => {
    dragging = true;
    clearTimeout(dragTimer);
  });
  const endDrag = () => {
    clearTimeout(dragTimer);
    dragTimer = setTimeout(() => { dragging = false; }, 400);
  };
  slider.addEventListener('pointerup', endDrag);
  slider.addEventListener('pointercancel', endDrag);

  slider.addEventListener('input', () => {
    const level = Number(slider.value);
    slider.style.setProperty('--fill', `${level}%`);
    value.textContent = `${level}%`;
    box.dataset.muted = 'false';
    paintButton(level, false);
    pendingLevel = level;
    flush();
  });

  muteButton.addEventListener('click', async () => {
    try {
      render(await api('/api/volume', { method: 'POST', json: { muted: 'toggle' } }));
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

  // --- the panel -------------------------------------------------------------------------------
  // Opened by the button, closed by the button, a tap outside (the scrim, header.js) or Back (Deck.back). Dragging the slider
  // does not close it: the slider keeps its touch-action: none and the panel lives outside the pager, so nothing swipes.
  const setOpen = (open) => {
    if (open) $('menu-pop').hidden = true; // one floating panel at a time
    panel.hidden = !open;
  };
  button.addEventListener('click', () => setOpen(panel.hidden));
  new MutationObserver(() => {
    const open = !panel.hidden;
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      panel.tabIndex = -1;
      panel.focus({ preventScroll: true });
    } else if (panel.contains(document.activeElement)) {
      button.focus({ preventScroll: true }); // do not leave the focus on something that vanished
    }
  }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });

  Deck.volume = { render, refresh, panel: { open: () => setOpen(true), close: () => setOpen(false), get isOpen() { return !panel.hidden; } } };
})();
