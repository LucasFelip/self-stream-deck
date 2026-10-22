'use strict';

/**
 * Hold a key for a moment (it lifts), then drag it over the others: they make room as you go. Letting go saves the order.
 * Holding without moving does nothing, and the touch that ends a lift never counts as a tap on the key.
 * Touch is handled with touch events, not pointer events: when the browser starts a scroll it cancels a pointer, but a
 * touch keeps reporting, and the page's own touchmove handler (registered up front, not passive) is what stops the scroll.
 */
(() => {
  const { $, api, toast: showToast, vibrate } = Deck;
  const pager = $('pager');

  // read by tiles.js: the touch that ends a drag is not a tap
  const arrange = { justDropped: false };
  Deck.arrange = arrange;

  const HOLD_MS = 450;
  const HOLD_SLOP = 16; // px of finger movement that still counts as "holding"
  let press = null; // a finger is down on a key and the hold time has not passed
  let lift = null; // a key is lifted and follows the finger

  const cellsOf = (grid) => [...grid.children].filter((cell) => cell.classList.contains('tile') || cell.classList.contains('slot'));
  const tileAt = (target) => {
    const tile = target && target.closest ? target.closest('.tile[data-key]') : null;
    return tile && tile.parentElement.classList.contains('grid') ? tile : null;
  };

  function cancelPress() {
    if (press) clearTimeout(press.timer);
    press = null;
  }

  function startLift() {
    const { tile, x, y } = press;
    press = null;
    const grid = tile.parentElement;
    const rect = tile.getBoundingClientRect();
    lift = { tile, grid, target: null, grabX: x - rect.left, grabY: y - rect.top, x, y, moved: false, section: grid.closest('.page').dataset.section };
    tile.classList.add('lifting');
    pager.classList.add('arranging');
    vibrate(30);
    followFinger();
  }

  // the lifted key sits under the finger, wherever the grid has put its slot
  function followFinger() {
    const { tile } = lift;
    tile.style.transform = '';
    const natural = tile.getBoundingClientRect();
    tile.style.transform = `translate(${lift.x - lift.grabX - natural.left}px, ${lift.y - lift.grabY - natural.top}px) scale(1.06)`;
  }

  // The cell under the finger, by LAYOUT position (offsetLeft/Top ignore transforms), so a key that is still sliding
  // into place can never be mistaken for the one the finger is over.
  function cellUnder(grid, tile, x, y) {
    const box = grid.getBoundingClientRect();
    const gx = x - box.left;
    const gy = y - box.top;
    return cellsOf(grid).find((cell) => cell !== tile
      && gx >= cell.offsetLeft && gx <= cell.offsetLeft + cell.offsetWidth
      && gy >= cell.offsetTop && gy <= cell.offsetTop + cell.offsetHeight) || null;
  }

  function moveLift(x, y) {
    lift.x = x;
    lift.y = y;
    lift.moved = true;
    const target = cellUnder(lift.grid, lift.tile, x, y);
    if (target !== lift.target) {
      if (lift.target) lift.target.classList.remove('drop-target');
      if (target) target.classList.add('drop-target');
      lift.target = target;
    }
    followFinger();
  }

  function swapNodes(a, b) {
    const parent = a.parentNode;
    const after = a.nextSibling === b ? a : a.nextSibling;
    b.replaceWith(a);
    parent.insertBefore(b, after);
  }

  // a key glides from where it was drawn to where it now is
  function slide(el, from) {
    el.style.transform = '';
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (!dx && !dy) return;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    el.getBoundingClientRect(); // commit the starting point
    el.style.transition = 'transform 0.18s ease';
    el.style.transform = '';
    setTimeout(() => { el.style.transition = ''; }, 230);
  }

  // Letting go on another key swaps the two; on an empty slot the key goes to the end; anywhere else nothing changes.
  async function endLift() {
    const { tile, grid, target, section } = lift;
    lift = null;
    pager.classList.remove('arranging');
    tile.classList.remove('lifting');
    if (target) target.classList.remove('drop-target');
    arrange.justDropped = true;
    setTimeout(() => { arrange.justDropped = false; }, 300);

    const tileFrom = tile.getBoundingClientRect();
    let changed = false;
    if (target && target.classList.contains('tile')) {
      const targetFrom = target.getBoundingClientRect();
      swapNodes(tile, target);
      slide(tile, tileFrom);
      slide(target, targetFrom);
      changed = true;
    } else if (target) {
      const last = [...grid.children].filter((cell) => cell.classList.contains('tile')).pop();
      if (last !== tile) {
        last.after(tile);
        slide(tile, tileFrom);
        changed = true;
      }
    }
    if (!changed) {
      slide(tile, tileFrom);
      return;
    }

    // the section's order, page by page, as it is on screen now
    const order = [...pager.querySelectorAll(`.page[data-section="${section}"] .tile[data-key]`)].map((el) => el.dataset.key);
    Deck.tiles.setOrder(section, order);
    try {
      await api('/api/layout', { method: 'POST', json: { page: section, order } });
    } catch (err) {
      showToast(`Não salvou a posição: ${err.message}`, true);
      Deck.reloadDeck();
    }
  }

  const beginPress = (tile, x, y) => {
    if (lift) return;
    press = { tile, x, y, timer: setTimeout(startLift, HOLD_MS) };
  };
  const movePress = (x, y) => {
    if (lift) moveLift(x, y);
    else if (press && Math.hypot(x - press.x, y - press.y) > HOLD_SLOP) cancelPress(); // moved before the hold time: a swipe, not a rearrange
  };
  const endPress = () => {
    cancelPress();
    if (lift) endLift();
  };

  // touch (the phone). Not passive, so the browser waits for this handler before it scrolls: it can then refuse.
  pager.addEventListener('touchstart', (event) => {
    const tile = event.touches.length === 1 ? tileAt(event.target) : null;
    if (tile) beginPress(tile, event.touches[0].clientX, event.touches[0].clientY);
    else endPress();
  }, { passive: false });
  pager.addEventListener('touchmove', (event) => {
    if (lift && event.cancelable) event.preventDefault(); // the page must not scroll under the lifted key
    const touch = event.touches[0];
    if (touch) movePress(touch.clientX, touch.clientY);
  }, { passive: false });
  pager.addEventListener('touchend', endPress);
  pager.addEventListener('touchcancel', endPress);

  // mouse (testing in a desktop browser)
  pager.addEventListener('pointerdown', (event) => {
    const tile = event.pointerType === 'mouse' && event.button === 0 ? tileAt(event.target) : null;
    if (tile) beginPress(tile, event.clientX, event.clientY);
  });
  pager.addEventListener('pointermove', (event) => { if (event.pointerType === 'mouse') movePress(event.clientX, event.clientY); });
  pager.addEventListener('pointerup', (event) => { if (event.pointerType === 'mouse') endPress(); });
  pager.addEventListener('contextmenu', (event) => event.preventDefault());
})();
