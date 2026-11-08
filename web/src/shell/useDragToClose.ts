import { useEffect, type RefObject } from 'react';

const THRESHOLD = 90; // px of drag that counts as "close"

/**
 * Drag-down-to-close for a portrait bottom sheet. Only `handle` (the grabber / title bar) starts it, never the content, so
 * scrolling inside the sheet cannot close it. Follows the finger, then closes past a threshold (or springs back).
 * `close` runs after the short slide-out. Landscape ignores it (the menu is a popover there).
 */
export function useDragToClose(handle: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    const grip = handle.current;
    const sheet = panel.current;
    if (!grip || !sheet) return undefined;
    let startY: number | null = null;
    let dy = 0;
    let moved = false;

    const down = (event: PointerEvent) => {
      if (!window.matchMedia('(orientation: portrait)').matches) return;
      startY = event.clientY;
      dy = 0;
      moved = false;
    };
    const move = (event: PointerEvent) => {
      if (startY === null) return;
      dy = Math.max(0, event.clientY - startY);
      if (!moved && dy < 6) return;
      if (!moved) {
        moved = true;
        sheet.style.transition = 'none';
        try { grip.setPointerCapture(event.pointerId); } catch { /* the pointer may be gone already */ }
      }
      sheet.style.transform = `translateY(${dy}px)`;
    };
    const end = () => {
      if (startY === null) return;
      startY = null;
      if (!moved) return;
      sheet.style.transition = 'transform 0.16s ease';
      if (dy >= THRESHOLD) {
        sheet.style.transform = 'translateY(100%)';
        setTimeout(() => { close(); sheet.style.transition = ''; sheet.style.transform = ''; }, 170);
      } else {
        sheet.style.transform = '';
        setTimeout(() => { sheet.style.transition = ''; }, 170);
      }
    };

    grip.addEventListener('pointerdown', down);
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    return () => {
      grip.removeEventListener('pointerdown', down);
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
    };
  }, [handle, panel, close]);
}
