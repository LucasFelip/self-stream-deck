import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { arrangeStore, slotId, useIsLifted, useIsTarget } from './arrangeStore';
import { keycapText, type DeckItem } from './items';

function Fallback({ name }: { name: string }) {
  return <div className="fallback">{name.charAt(0).toUpperCase()}</div>;
}

function Visual({ item }: { item: DeckItem }) {
  const [broken, setBroken] = useState(false);
  if (item.kind === 'app') {
    if (!item.hasIcon || broken) return <Fallback name={item.label} />;
    // a long press on an icon must not start the browser image drag
    return <img src={`/api/icon/${item.id}?v=${item.iconVersion || ''}`} alt="" draggable={false} onError={() => setBroken(true)} />;
  }
  if (item.kind === 'shortcut') return <div className="keycap">{keycapText(item.display)}</div>;
  return (
    <div className="keycap macro">
      <Icon name="play" size={22} />
      <small>{`${item.steps} passo${item.steps === 1 ? '' : 's'}`}</small>
    </div>
  );
}

interface TileProps {
  item: DeckItem;
  running: boolean;
  open: boolean;
  /** what a tap does; a macro can take seconds, so the key stays marked busy until it ends */
  onTap: (item: DeckItem) => Promise<void> | void;
}

/** A key: icon (or key combination) over its name. Marks that its app is running or has a window, and that it was just pressed. */
export function Tile({ item, running, open, onTap }: TileProps) {
  const lifting = useIsLifted(item.key);
  const target = useIsTarget(item.key);
  const [launched, setLaunched] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const press = () => {
    if (arrangeStore.justDropped) return; // the touch that ended a drag is not a tap
    setLaunched(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setLaunched(false), 250);
    const result = onTap(item);
    if (result && typeof result.then === 'function') {
      setBusy(true);
      void result.finally(() => setBusy(false));
    }
  };

  const className = ['tile', running && 'running', open && 'open', launched && 'launched', busy && 'busy', lifting && 'lifting', target && 'drop-target'].filter(Boolean).join(' ');
  return (
    <button type="button" className={className} data-key={item.key} data-app-id={item.kind === 'app' ? item.id : undefined} aria-label={item.kind === 'app' ? item.label : undefined} onClick={press}>
      <Visual item={item} />
      <span>{item.label}</span>
    </button>
  );
}

/** An empty cell of the grid: keeps the page's grid whole, and takes a key dropped on it to the end. */
export function Slot({ section, index }: { section: string; index: number }) {
  const target = useIsTarget(slotId(section, index));
  return <div className={`slot${target ? ' drop-target' : ''}`} data-slot={slotId(section, index)} />;
}
