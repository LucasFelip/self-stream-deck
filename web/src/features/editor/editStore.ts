import { useSyncExternalStore } from 'react';
import type { Target } from './model';

/**
 * Edit mode on the deck itself (menu > Editar botões), and the editor sheet it opens. Outside React state because the keys, the empty slots,
 * the bar and the menu are far apart in the tree and none of them owns the mode. While the mode is on, a tap on a key opens the editor already
 * on that key instead of launching it, an empty slot is a "+" that opens the editor with a new item, and holding and dragging still reorders.
 */
let editing = false;
let entering = false; // asked for, and the deck is on its way to Apps / Atalhos
let editorOpen = false;
let target: Target = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export const editStore = {
  get editing(): boolean { return editing; },
  get entering(): boolean { return entering; },
  get editorOpen(): boolean { return editorOpen; },
  get target(): Target { return target; },
  enter(): void {
    if (editing) return;
    editing = true;
    entering = true;
    emit();
  },
  /** the deck is on Apps / Atalhos: the mode is settled */
  settled(): void {
    if (!entering) return;
    entering = false;
    emit();
  },
  exit(): void {
    if (!editing && !editorOpen) return;
    editing = false;
    entering = false;
    editorOpen = false;
    target = null;
    emit();
  },
  openEditor(where: Target): void {
    if (editorOpen) return;
    target = where;
    editorOpen = true;
    emit();
  },
  closeEditor(): void {
    if (!editorOpen) return;
    editorOpen = false;
    target = null;
    emit();
  },
  subscribe,
};

export const useEditing = (): boolean => useSyncExternalStore(subscribe, () => editing);
export const useEditorOpen = (): boolean => useSyncExternalStore(subscribe, () => editorOpen);
