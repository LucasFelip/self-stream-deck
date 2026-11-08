import { useEffect, useRef, type ReactNode } from 'react';
import { registerBack } from '../lib/back';
import { useDragToClose } from '../shell/useDragToClose';
import { Icon } from './Icon';

interface OverlayProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * A panel over the deck (the camera, the button editor, the dimmer settings): one tap in the menu opens it, one tap on its close button
 * returns. Landscape: a full panel. Portrait: a bottom sheet (~92 % high, grabber on top) that also closes by dragging its bar down or
 * tapping the dimmed strip above it. Back closes the newest one first.
 */
export function Overlay({ open, title, onClose, children }: OverlayProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);

  useDragToClose(bar, root, onClose);
  useEffect(() => {
    if (!open) return undefined;
    return registerBack(() => { onClose(); return true; });
  }, [open, onClose]);

  return (
    <>
      {/* portrait only (style.css): the dimmed strip above the sheet; a tap there closes it instead of reaching the deck below */}
      <div className="overlay-scrim" hidden={!open} onClick={onClose} />
      <div className="overlay" hidden={!open} role="dialog" aria-label={title} ref={root}>
        <div className="overlay-bar" ref={bar}>
          <i className="grabber" aria-hidden="true" />
          <b>{title}</b>
          <button type="button" className="overlay-close" aria-label="Fechar" onClick={onClose}>
            <Icon name="close" size={22} />
            <span>Fechar</span>
          </button>
        </div>
        <div className="overlay-body">{children}</div>
      </div>
    </>
  );
}
