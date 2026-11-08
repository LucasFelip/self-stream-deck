import { useSyncExternalStore } from 'react';

/**
 * Which key is lifted and which cell it hovers while a key is being rearranged (hold, then drag). Outside React state because the
 * gesture is driven by native touch listeners that must stay non-passive (they have to be able to stop the page from scrolling).
 */
let lifted: string | null = null;
let target: string | null = null;
let dropped = false;
let droppedTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export const slotId = (section: string, index: number): string => `slot:${section}:${index}`;

export const arrangeStore = {
  lift(key: string | null): void {
    if (lifted === key) return;
    lifted = key;
    emit();
  },
  setTarget(id: string | null): void {
    if (target === id) return;
    target = id;
    emit();
  },
  /** the touch that ends a drag is not a tap on the key */
  markDropped(): void {
    dropped = true;
    clearTimeout(droppedTimer);
    droppedTimer = setTimeout(() => { dropped = false; }, 300);
  },
  get justDropped(): boolean { return dropped; },
  get lifted(): string | null { return lifted; },
};

export const useIsLifted = (key: string): boolean => useSyncExternalStore(subscribe, () => lifted === key);
export const useIsTarget = (id: string): boolean => useSyncExternalStore(subscribe, () => target === id);
