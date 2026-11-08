import { Icon } from '../../ui/Icon';
import type { Win } from './geometry';
import { WindowIcon } from './WindowIcon';

interface WindowListProps {
  windows: readonly Win[];
  order: readonly number[];
  selected: number | null;
  onAction: (win: Win, action: 'focus' | 'minimize' | 'maximize' | 'restore') => void;
}

/**
 * Every open window with its actions one tap away. Tap a row to bring it to the front; its two buttons minimize / maximize (or
 * restore) it. The row also selects the window, so the map shows the same selection.
 */
export function WindowList({ windows, order, selected, onAction }: WindowListProps) {
  const byHandle = new Map(windows.map((win) => [win.handle, win]));
  const frontmost = windows.find((win) => win.state !== 1);

  return (
    <div className="card wlist">
      <h3>Janelas</h3>
      <div className="scroll wlist-body">
        {order.map((handle) => {
          const win = byHandle.get(handle);
          if (!win) return null;
          // the app's name on top, the window's title under it (the list is wide enough for both)
          const appName = win.app || win.title;
          const sub = win.title && win.title !== appName ? win.title : '';
          const minimized = win.state === 1;
          const maximized = win.state === 2;
          return (
            <div
              key={handle}
              className={`wrow${minimized ? ' dim' : ''}${win === frontmost ? ' front' : ''}${handle === selected ? ' sel' : ''}`}
              data-handle={handle}
              title={win.title}
            >
              <button type="button" className="wmain" onClick={() => onAction(win, 'focus')}>
                <span className="wicon"><WindowIcon win={win} /></span>
                <span className="wtitle"><b>{appName}</b><small>{sub}</small></span>
              </button>
              {/* the buttons show what they will do now */}
              <button type="button" className="wbtn" aria-label={minimized ? 'Restaurar' : 'Minimizar'} onClick={() => onAction(win, minimized ? 'focus' : 'minimize')}>
                <Icon name={minimized ? 'restore' : 'minimize'} size={22} />
              </button>
              <button type="button" className="wbtn" aria-label={maximized ? 'Restaurar' : 'Maximizar'} onClick={() => onAction(win, maximized ? 'restore' : 'maximize')}>
                <Icon name={maximized ? 'restore' : 'maximize'} size={22} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
