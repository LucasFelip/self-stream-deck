import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { PendingPage } from './features/pending/PendingPage';
import { PowerPage } from './features/power/PowerPage';
import { SoundPage } from './features/sound/SoundPage';
import { runBack } from './lib/back';
import { vibrate } from './lib/haptics';
import { useConnection, useWakeLock } from './shell/connection';
import { Menu } from './shell/Menu';
import { Nav } from './shell/Nav';
import { Offline } from './shell/Offline';
import { Pager } from './shell/Pager';
import { SheetsProvider } from './ui/Sheets';
import { ToastProvider } from './ui/Toast';

function Shell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const connection = useConnection();
  useWakeLock();

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
      pages={{
        apps: <PendingPage section="apps" />,
        shortcuts: <PendingPage section="shortcuts" />,
        windows: <PendingPage section="windows" />,
        sound: <SoundPage />,
        pc: <PendingPage section="pc" />,
        power: <PowerPage />,
      }}
      nav={(pager) => <Nav pager={pager} menuOpen={menuOpen} onMenu={() => setMenuOpen((open) => !open)} />}
      aboveMain={<Offline connection={connection} />}
    >
      <Menu open={menuOpen} onClose={() => setMenuOpen(false)} />
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
