/**
 * After a key is dropped on another the keys glide from where they were drawn to where they are now (FLIP): the drop records where every
 * key of the section was, and the grid that re-renders with the new order animates the difference.
 */
let pending: Map<string, DOMRect> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Records where the keys are right now (call before the order changes). The lifted key is recorded where the finger holds it. */
export function recordFlip(root: ParentNode, section: string): void {
  pending = new Map();
  for (const tile of root.querySelectorAll<HTMLElement>(`.page[data-section="${section}"] .tile[data-key]`)) pending.set(tile.dataset.key ?? '', tile.getBoundingClientRect());
  clearTimeout(timer);
  timer = setTimeout(clearFlip, 600); // a drop that changed nothing never renders: do not leave the record for the next unrelated render
}

/** A key glides from where it was drawn to where it now is. False if it did not move. */
function slide(el: HTMLElement, from: DOMRect): boolean {
  el.style.transform = '';
  const to = el.getBoundingClientRect();
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (!dx && !dy) return false;
  el.style.transition = 'none';
  el.style.transform = `translate(${dx}px, ${dy}px)`;
  el.getBoundingClientRect(); // commit the starting point
  el.style.transition = 'transform 0.18s ease';
  el.style.transform = '';
  setTimeout(() => { el.style.transition = ''; }, 230);
  return true;
}

/** Called by a grid after it rendered: animates the keys it holds that a drop recorded (each key once; a section may have several grids). */
export function takeFlip(grid: HTMLElement): void {
  if (!pending) return;
  for (const tile of grid.querySelectorAll<HTMLElement>('.tile[data-key]')) {
    const key = tile.dataset.key ?? '';
    const from = pending.get(key);
    // a render that comes before the new order (the pager re-rendering) leaves the record for the one that moves the keys
    if (from && slide(tile, from)) pending.delete(key);
  }
}

/** Forget a recorded drop. */
export function clearFlip(): void {
  clearTimeout(timer);
  pending = null;
}
