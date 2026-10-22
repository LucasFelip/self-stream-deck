'use strict';

/** The volume strip (mute, slider, media keys) that sits in the last row of the first shortcuts page. */
(() => {
  const { $, api, toast: showToast } = Deck;

  const box = $('volume');
  const slider = $('vol');
  const value = $('vol-value');
  const muteButton = $('mute');

  let dragging = false;
  let dragTimer;

  function render({ level, muted }) {
    box.dataset.ready = 'true';
    box.dataset.muted = String(muted);
    if (!dragging) {
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

  Deck.volume = { render, refresh };
})();
