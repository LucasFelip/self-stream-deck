import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Arranger } from './features/deck/Arranger';
import { GameWatcher } from './features/game/GameWatcher';
import { IdleDimmer } from './features/idle/IdleDimmer';
import { copyPairingCode } from './features/notices/pairing';
import { useNotifications, useUiReload } from './features/notices/useNotices';
import { useAppsRevWatch, useDeckState } from './features/deck/data';
import { AppsPage, ShortcutsPages } from './features/deck/DeckPages';
import { PcPage } from './features/pc/PcPage';
import { PowerPage } from './features/power/PowerPage';
import { SoundPage } from './features/sound/SoundPage';
import { WindowsPage } from './features/windows/WindowsPage';
import { android } from './lib/android';
import { runBack } from './lib/back';
import { isIOS, vibrate } from './lib/haptics';
import { useConnection, useWakeLock } from './shell/connection';
import { Menu, type MenuItem } from './shell/Menu';
import { Nav } from './shell/Nav';
import { Offline } from './shell/Offline';
import { Pager } from './shell/Pager';
import { SheetsProvider } from './ui/Sheets';
import { ToastProvider, useToast } from './ui/Toast';

function Shell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [idleOpen, setIdleOpen] = useState(false);
  const toast = useToast();
  const connection = useConnection();
  const state = useDeckState();
  useWakeLock();
  useAppsRevWatch();
  useNotifications();
  useUiReload();

  // the menu entries the features add (the order of the old interface: edit, camera, pairing code on iPhone, dimmer)
  const items: MenuItem[] = [
    ...(isIOS() && !android() ? [{ label: 'Código de pareamento', onClick: () => void copyPairingCode(toast) }] : []),
    { label: 'Escurecer após…', onClick: () => setIdleOpen(true) },
  ];

  // what MainActivity calls (the Android Back button)
  useEffect(() => {
    window.Deck = { back: runBack, vibrate };
    return () => { delete window.Deck; };
  }, []);

  // light haptic tick on every button, like a hardware key
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest('button:not(:disabled)')) vibrate(8);
    };
    document.addEventListener('pointerdown', onDown, { capture: true, passive: true });
    return () => document.removeEventListener('pointerdown', onDown, { capture: true });
  }, []);

  return (
    <Pager
      pages={(
        <>
          <AppsPage />
          <ShortcutsPages />
          <WindowsPage />
          <SoundPage />
          <PcPage />
          <PowerPage />
        </>
      )}
      nav={(pager) => <Nav pager={pager} menuOpen={menuOpen} onMenu={() => setMenuOpen((open) => !open)} />}
      aboveMain={<><GameWatcher /><Offline connection={connection} /></>}
    >
      <Menu open={menuOpen} onClose={() => setMenuOpen(false)} items={items} />
      <IdleDimmer open={idleOpen} onClose={() => setIdleOpen(false)} blocked={Boolean(state.data?.scheduled)} />
      <Arranger />
    </Pager>
  );
}

export function App() {
  const queryClient = useMemo(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } } }), []);
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SheetsProvider>
          <Shell />
        </SheetsProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
