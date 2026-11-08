import { useSyncExternalStore } from 'react';

export type Pane = 'monitor' | 'processes' | 'system';

export const PANES: ReadonlyArray<{ id: Pane; label: string }> = [
  { id: 'monitor', label: 'Desempenho' },
  { id: 'processes', label: 'Processos' },
  { id: 'system', label: 'Sistema' },
];

let current: Pane = 'monitor';
const listeners = new Set<() => void>();

/**
 * Which pane of the PC page is showing. Outside React state on purpose: the game detector (a different part of the interface) slides
 * to PC > Desempenho from wherever the person is, and the pane has to be right when the page arrives.
 */
export const paneStore = {
  get: (): Pane => current,
  set(pane: Pane): void {
    if (pane === current) return;
    current = pane;
    listeners.forEach((fn) => fn());
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};

export const usePane = (): Pane => useSyncExternalStore(paneStore.subscribe, paneStore.get);
