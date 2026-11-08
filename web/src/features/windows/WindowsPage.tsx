import { useEffect, useRef, useState } from 'react';
import { Page } from '../../shell/Page';
import { useIsActive } from '../../shell/PagerContext';
import { Segmented } from '../../ui/Segmented';
import { useWindowsController } from './controller';
import { WindowList } from './WindowList';
import { WindowMap } from './WindowMap';
import { WindowPanel } from './WindowPanel';

type Pane = 'list' | 'map';
const PANES = [{ id: 'list', label: 'Lista' }, { id: 'map', label: 'Mapa' }] as const;

/**
 * "Janelas": the list of every open window (tap a row to bring it to the front, two buttons to minimize / maximize it) and a to-scale map
 * of the screens with the windows where they really are. Landscape: list on the left, map on the right. Portrait: a "Lista | Mapa" selector,
 * one at a time (the choice is kept for the session). The list and the map share the selection.
 */
export function WindowsPage() {
  const active = useIsActive('windows');
  const controller = useWindowsController(active);
  const [pane, setPane] = useState<Pane>('list');
  const { windows, order, selected } = controller;
  const chipRefs = useRef(new Map<number, HTMLButtonElement>());
  const byHandle = new Map(windows.map((win) => [win.handle, win]));

  // keep the selected chip in view (once per selection, not on every answer)
  useEffect(() => {
    if (selected !== null) chipRefs.current.get(selected)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);

  const act = (handle: number, action: 'focus' | 'minimize' | 'maximize' | 'restore') => {
    const win = byHandle.get(handle);
    if (!win) return;
    controller.select(handle);
    void controller.windowAction(win, action);
  };

  return (
    <Page section="windows" className="windows-page" data={{ pane }}>
      <Segmented items={PANES} value={pane} onChange={setPane} label="Janelas" />
      <div className="wpane wpane-list">
        <WindowList windows={windows} order={order} selected={selected} onAction={(win, action) => act(win.handle, action)} />
      </div>
      <div className="wpane wpane-map">
        <div className="wmap-col">
          <div className="sel-chips">
            {order.map((handle) => {
              const win = byHandle.get(handle);
              if (!win) return null;
              return (
                <button
                  key={handle}
                  ref={(element) => { if (element) chipRefs.current.set(handle, element); else chipRefs.current.delete(handle); }}
                  type="button"
                  className={`chip big-chip${win.state === 1 ? ' dim' : ''}`}
                  aria-pressed={handle === selected}
                  onClick={() => act(handle, 'focus')}
                >
                  {win.title || win.app}
                </button>
              );
            })}
          </div>
          <WindowMap controller={controller} />
          {/* the hint lives under the map and stays in the layout when hidden: if it vanished the map would re-center and slide under the finger mid-drag */}
          <div className="sel-hint" style={{ visibility: selected !== null && byHandle.has(selected) ? 'hidden' : 'visible' }}>
            Toque numa janela para selecionar. Arraste para mover; até a borda de uma tela para encaixar. Toque no vazio para desmarcar.
          </div>
        </div>
        <div className="win-side">
          <WindowPanel controller={controller} />
        </div>
      </div>
    </Page>
  );
}
