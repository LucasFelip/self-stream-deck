import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { call, client } from '../api/client';
import { android } from '../lib/android';
import { registerBack } from '../lib/back';
import { useToast } from '../ui/Toast';
import { useDragToClose } from './useDragToClose';

export interface MenuItem {
  label: string;
  onClick: () => void;
}

interface MenuProps {
  open: boolean;
  onClose: () => void;
  /** the entries the features add (edit buttons, camera, dimmer...), shown before the Android entry and Atualizar */
  items?: readonly MenuItem[];
}

/**
 * The settings menu (the gear): a popover beside the rail in landscape, a bottom sheet over the bar in portrait.
 * Outside the nav so it stacks above the scrim. A tap anywhere in it closes it.
 */
export function Menu({ open, onClose, items = [] }: MenuProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const panel = useRef<HTMLDivElement | null>(null);
  const grip = useRef<HTMLDivElement | null>(null);
  const hostRow = useRef<HTMLDivElement | null>(null);
  const [spin, setSpin] = useState(false);

  // the PC's name is in the app list answer
  const apps = useQuery({ queryKey: ['apps'], queryFn: () => call(client.GET('/api/apps')), staleTime: 60_000 });

  const close = useCallback(() => onClose(), [onClose]);
  useDragToClose(grip, panel, close);
  useDragToClose(hostRow, panel, close);

  useEffect(() => {
    if (!open) return undefined;
    return registerBack(() => { onClose(); return true; });
  }, [open, onClose]);

  const refresh = async () => {
    setSpin(false);
    requestAnimationFrame(() => setSpin(true)); // restart the spin
    try {
      await call(client.POST('/api/refresh'));
      await queryClient.invalidateQueries();
      toast('Atualizado');
    } catch (err) {
      toast(`Erro: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  };

  const bridge = android();
  return (
    <>
      {/* Taps outside the open menu land here and only close it, so they never reach the keys underneath. */}
      <div id="scrim" className="scrim" hidden={!open} onClick={close} />
      <div id="menu-pop" className="menu" role="menu" hidden={!open} ref={panel} onClick={close}>
        <div className="grip" aria-hidden="true" ref={grip}><i /></div>
        <div className="menu-host" ref={hostRow}><span className="muted">Computador</span><b id="host">{apps.data?.host ?? 'PC'}</b></div>
        {items.map((item) => <button key={item.label} type="button" role="menuitem" onClick={item.onClick}>{item.label}</button>)}
        <button id="settings" type="button" role="menuitem" hidden={!bridge || typeof bridge.openSettings !== 'function'} onClick={() => bridge?.openSettings?.()}>Endereço do PC…</button>
        <button id="refresh" type="button" role="menuitem" className={spin ? 'spin' : ''} onClick={refresh}>Atualizar</button>
      </div>
    </>
  );
}
