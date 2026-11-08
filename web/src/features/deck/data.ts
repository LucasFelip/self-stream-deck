import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { call, client } from '../../api/client';
import { appsKeys, shortcutKeys, type DeckItem } from './items';
import { arranged } from './layout';

export const DECK_QUERIES = ['apps', 'shortcuts', 'macros', 'layout'] as const;

const EMPTY: never[] = [];

/** What the PC says about itself (running apps, windows, the scheduled shutdown...): pushed by the connection, read here from the cache. */
export function useDeckState() {
  return useQuery({ queryKey: ['state'], queryFn: () => call(client.GET('/api/state')), enabled: false });
}

export interface DeckData {
  /** the app list has been read (or has failed): before that the Apps page is empty instead of showing only the camera key */
  ready: boolean;
  apps: DeckItem[];
  shortcuts: DeckItem[];
  running: ReadonlySet<string>;
  open: ReadonlySet<string>;
  order: { apps: string[]; shortcuts: string[] };
}

/** The keys of both pages, in the saved order, and which apps are running or have a window. */
export function useDeckData(): DeckData {
  const apps = useQuery({ queryKey: ['apps'], queryFn: () => call(client.GET('/api/apps')), retry: false });
  const shortcuts = useQuery({ queryKey: ['shortcuts'], queryFn: () => call(client.GET('/api/shortcuts')), retry: false });
  const macros = useQuery({ queryKey: ['macros'], queryFn: () => call(client.GET('/api/macros')), retry: false });
  const layout = useQuery({ queryKey: ['layout'], queryFn: () => call(client.GET('/api/layout')), retry: false });
  const state = useDeckState();

  const order = { apps: layout.data?.apps ?? EMPTY, shortcuts: layout.data?.shortcuts ?? EMPTY };
  return {
    ready: !apps.isPending && !macros.isPending && !layout.isPending,
    apps: arranged(order.apps, appsKeys(apps.data?.apps ?? EMPTY, macros.data?.macros ?? EMPTY)),
    shortcuts: arranged(order.shortcuts, shortcutKeys(shortcuts.data?.shortcuts ?? EMPTY, macros.data?.macros ?? EMPTY)),
    running: new Set(state.data?.running ?? EMPTY),
    open: new Set(state.data?.open ?? EMPTY),
    order,
  };
}

/** The taskbar list changed on the PC (it was read again after a restart, or an app was pinned): read the keys again. Mount once. */
export function useAppsRevWatch(): void {
  const queryClient = useQueryClient();
  const state = useDeckState();
  const rev = state.data?.appsRev;
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (rev === undefined) return;
    if (last.current !== null && rev !== last.current) for (const key of DECK_QUERIES) void queryClient.invalidateQueries({ queryKey: [key] });
    last.current = rev;
  }, [rev, queryClient]);
}
