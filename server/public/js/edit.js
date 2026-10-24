'use strict';

/**
 * Edit mode on the deck itself (menu ⚙ > Editar botões). While it is on (body.editing) a tap on a key opens the button editor
 * already on that key instead of launching it, an empty slot is a "+" that opens the editor with a new item, and holding and
 * dragging still reorders (arrange.js). The "Concluir" chip in #edit-bar (in the flow, between the live strip and the pager) ends
 * it, and so do Deck.back() and leaving Apps / Atalhos. The editor sheet itself is js/editor.js.
 */
(() => {
  const { $, toast } = Deck;
  const pager = $('pager');
  const bar = $('edit-bar');

  const GRID_SECTIONS = ['apps', 'shortcuts'];
  const HINT_KEY = 'ssd.editHint';
  const HINT = 'Toque numa tecla para editar · segure e arraste para mover';
  let active = false;
  let hintShown = false; // also covers a WebView without storage: at most once per load

  function hintSeen() {
    try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; /* no storage: rely on hintShown */ }
  }

  function showHintOnce() {
    if (hintShown || hintSeen()) return;
    hintShown = true;
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* no storage: it just shows once per load */ }
    toast(HINT);
  }

  // empty slots become "+" buttons while editing (the "+" itself is drawn by CSS)
  function decorate() {
    for (const slot of pager.querySelectorAll('.slot')) {
      if (active) {
        slot.setAttribute('role', 'button');
        slot.setAttribute('tabindex', '0');
        slot.setAttribute('aria-label', 'Adicionar botão');
      } else {
        slot.removeAttribute('role');
        slot.removeAttribute('tabindex');
        slot.removeAttribute('aria-label');
      }
    }
  }

  function enter() {
    if (active) return;
    active = true;
    document.body.classList.add('editing');
    bar.hidden = false;
    if (!GRID_SECTIONS.includes(Deck.pager.currentSection())) Deck.goTo('apps-0');
    decorate();
    showHintOnce();
  }

  function exit() {
    if (!active) return;
    active = false;
    document.body.classList.remove('editing');
    bar.hidden = true;
    decorate();
  }

  // a tap on a key in edit mode (called by tiles.js)
  function tap(item) {
    const key = item.key || '';
    if (key.startsWith('c:')) {
      toast('A tecla da câmera não tem o que editar');
      return;
    }
    Deck.editor.open({ key });
  }

  const slotTap = (event) => {
    if (!active || Deck.arrange.justDropped) return;
    const slot = event.target.closest ? event.target.closest('.slot') : null;
    if (!slot) return;
    const page = slot.closest('.page');
    Deck.editor.open({ create: page ? page.dataset.section : 'shortcuts' });
  };
  pager.addEventListener('click', slotTap);
  pager.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); slotTap(event); }
  });

  $('edit-done').addEventListener('click', exit);

  Deck.edit = {
    enter,
    exit,
    tap,
    decorate,
    get active() { return active; },
    // the pager reports the section on screen: leaving Apps / Atalhos ends edit mode
    sectionChanged(section) { if (active && !GRID_SECTIONS.includes(section)) exit(); },
  };
})();
