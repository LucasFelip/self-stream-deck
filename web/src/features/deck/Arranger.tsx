import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { call, client } from '../../api/client';
import { vibrate } from '../../lib/haptics';
import { usePager } from '../../shell/PagerContext';
import { useToast } from '../../ui/Toast';
import { arrangeStore } from './arrangeStore';
import { DECK_QUERIES } from './data';
import { recordFlip } from './flip';
import { END, reorder } from './layout';
import { errorText } from '../../lib/errors';

// Hold a key for a moment (it lifts), then drag it over the others: letting go on another key swaps the two, on an empty slot the key goes
// to the end. Holding without moving does nothing, and the touch that ends a lift never counts as a tap on the key. Touch is handled with
// touch events, not pointer events: when the browser starts a scroll it cancels a pointer, but a touch keeps reporting, and the
// non-passive touchmove handler is what stops the scroll.
const HOLD_MS = 450;
const HOLD_SLOP = 16; // px of finger movement that still counts as "holding"

interface Press { tile: HTMLElement; x: number; y: number; timer: ReturnType<typeof setTimeout> }
interface Lift { tile: HTMLElement; grid: HTMLElement; target: HTMLElement | null; grabX: number; grabY: number; x: number; y: number; section: string }

const tileAt = (target: EventTarget | null): HTMLElement | null => {
  const tile = target instanceof Element ? target.closest<HTMLElement>('.tile[data-key]') : null;
  return tile && tile.parentElement?.classList.contains('grid') ? tile : null;
};
const cellsOf = (grid: HTMLElement): HTMLElement[] => [...grid.children].filter((cell): cell is HTMLElement => cell instanceof HTMLElement && (cell.classList.contains('tile') || cell.classList.contains('slot')));

// The cell under the finger, by LAYOUT position (offsetLeft/Top ignore transforms), so a key that is still sliding into place can
// never be mistaken for the one the finger is over.
function cellUnder(grid: HTMLElement, tile: HTMLElement, x: number, y: number): HTMLElement | null {
  const box = grid.getBoundingClientRect();
  const gx = x - box.left;
  const gy = y - box.top;
  return cellsOf(grid).find((cell) => cell !== tile
    && gx >= cell.offsetLeft && gx <= cell.offsetLeft + cell.offsetWidth
    && gy >= cell.offsetTop && gy <= cell.offsetTop + cell.offsetHeight) ?? null;
}

const idOf = (cell: HTMLElement | null): string | null => (cell ? cell.dataset.key ?? cell.dataset.slot ?? null : null);

/** Hold-and-drag reordering of the keys of Apps and Atalhos. Draws nothing: it listens on the pager. */
export function Arranger() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { setArranging } = usePager();

  useEffect(() => {
    const pager = document.getElementById('pager');
    if (!pager) return undefined;
    let press: Press | null = null;
    let lift: Lift | null = null;

    const cancelPress = () => { if (press) clearTimeout(press.timer); press = null; };

    // the lifted key sits under the finger, wherever the grid has put its slot
    function followFinger() {
      if (!lift) return;
      const { tile } = lift;
      tile.style.transform = '';
      const natural = tile.getBoundingClientRect();
      tile.style.transform = `translate(${lift.x - lift.grabX - natural.left}px, ${lift.y - lift.grabY - natural.top}px) scale(1.06)`;
    }

    function startLift() {
      if (!press) return;
      const { tile, x, y } = press;
      press = null;
      const grid = tile.parentElement;
      const section = tile.closest<HTMLElement>('.page')?.dataset.section;
      if (!grid || !section) return;
      const rect = tile.getBoundingClientRect();
      lift = { tile, grid, target: null, grabX: x - rect.left, grabY: y - rect.top, x, y, section };
      arrangeStore.lift(tile.dataset.key ?? null);
      setArranging(true);
      vibrate(30);
      followFinger();
    }

    function moveLift(x: number, y: number) {
      if (!lift) return;
      lift.x = x;
      lift.y = y;
      const target = cellUnder(lift.grid, lift.tile, x, y);
      if (target !== lift.target) {
        lift.target = target;
        arrangeStore.setTarget(idOf(target));
      }
      followFinger();
    }

    function persist(section: string, order: string[]) {
      queryClient.setQueryData(['layout'], (old: { apps: string[]; shortcuts: string[] } | undefined) => ({ apps: [], shortcuts: [], ...old, [section]: order }));
      call(client.POST('/api/layout', { body: { page: section as 'apps' | 'shortcuts', order } })).catch((error: unknown) => {
        toast(`Não salvou a posição: ${errorText(error)}`, true);
        for (const key of DECK_QUERIES) void queryClient.invalidateQueries({ queryKey: [key] });
      });
    }

    function endLift() {
      if (!lift) return;
      const { tile, target, section } = lift;
      lift = null;
      arrangeStore.lift(null);
      arrangeStore.setTarget(null);
      arrangeStore.markDropped();
      setArranging(false);

      const liftedKey = tile.dataset.key ?? '';
      const keys = [...pager!.querySelectorAll<HTMLElement>(`.page[data-section="${section}"] .tile[data-key]`)].map((el) => el.dataset.key ?? '');
      const targetId = idOf(target);
      const next = targetId ? reorder(keys, liftedKey, target?.classList.contains('slot') ? END : targetId) : keys;
      const changed = next.some((key, index) => key !== keys[index]);
      if (!changed) {
        // nothing moves: the key glides back from the finger to its place
        const from = tile.getBoundingClientRect();
        tile.style.transform = '';
        const to = tile.getBoundingClientRect();
        tile.style.transition = 'none';
        tile.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px)`;
        tile.getBoundingClientRect();
        tile.style.transition = 'transform 0.18s ease';
        tile.style.transform = '';
        setTimeout(() => { tile.style.transition = ''; }, 230);
        return;
      }
      recordFlip(pager!, section); // before the order changes: the lifted key is recorded where the finger holds it
      tile.style.transform = '';
      persist(section, next);
    }

    const beginPress = (tile: HTMLElement, x: number, y: number) => {
      if (lift) return;
      press = { tile, x, y, timer: setTimeout(startLift, HOLD_MS) };
    };
    const movePress = (x: number, y: number) => {
      if (lift) moveLift(x, y);
      else if (press && Math.hypot(x - press.x, y - press.y) > HOLD_SLOP) cancelPress(); // moved before the hold time: a swipe, not a rearrange
    };
    const endPress = () => {
      cancelPress();
      if (lift) endLift();
    };

    // touch (the phone). Not passive, so the browser waits for this handler before it scrolls: it can then refuse.
    const onTouchStart = (event: TouchEvent) => {
      const first = event.touches[0];
      const tile = event.touches.length === 1 ? tileAt(event.target) : null;
      if (tile && first) beginPress(tile, first.clientX, first.clientY);
      else endPress();
    };
    const onTouchMove = (event: TouchEvent) => {
      if (lift && event.cancelable) event.preventDefault(); // the page must not scroll under the lifted key
      const touch = event.touches[0];
      if (touch) movePress(touch.clientX, touch.clientY);
    };
    pager.addEventListener('touchstart', onTouchStart, { passive: false });
    pager.addEventListener('touchmove', onTouchMove, { passive: false });
    pager.addEventListener('touchend', endPress);
    pager.addEventListener('touchcancel', endPress);

    // mouse (testing in a desktop browser)
    const onPointerDown = (event: PointerEvent) => {
      const tile = event.pointerType === 'mouse' && event.button === 0 ? tileAt(event.target) : null;
      if (tile) beginPress(tile, event.clientX, event.clientY);
    };
    const onPointerMove = (event: PointerEvent) => { if (event.pointerType === 'mouse') movePress(event.clientX, event.clientY); };
    const onPointerUp = (event: PointerEvent) => { if (event.pointerType === 'mouse') endPress(); };
    const noMenu = (event: Event) => event.preventDefault();
    pager.addEventListener('pointerdown', onPointerDown);
    pager.addEventListener('pointermove', onPointerMove);
    pager.addEventListener('pointerup', onPointerUp);
    pager.addEventListener('contextmenu', noMenu);

    return () => {
      cancelPress();
      pager.removeEventListener('touchstart', onTouchStart);
      pager.removeEventListener('touchmove', onTouchMove);
      pager.removeEventListener('touchend', endPress);
      pager.removeEventListener('touchcancel', endPress);
      pager.removeEventListener('pointerdown', onPointerDown);
      pager.removeEventListener('pointermove', onPointerMove);
      pager.removeEventListener('pointerup', onPointerUp);
      pager.removeEventListener('contextmenu', noMenu);
    };
  }, [queryClient, toast, setArranging]);

  return null;
}
