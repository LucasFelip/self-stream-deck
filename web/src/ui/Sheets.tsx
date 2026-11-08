import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { registerBack } from '../lib/back';

interface SheetEntry {
  id: number;
  title: string;
  render: (close: () => void) => ReactNode;
}

interface SheetsApi {
  /** Opens a confirmation sheet (`#modal-root`): a bottom sheet in portrait, centered in landscape. Returns its close function. */
  open: (title: string, render: (close: () => void) => ReactNode) => () => void;
}

const SheetsContext = createContext<SheetsApi>({ open: () => () => undefined });

export function SheetsProvider({ children }: { children: ReactNode }) {
  const [sheets, setSheets] = useState<SheetEntry[]>([]);
  const next = useRef(1);

  const close = useCallback((id: number) => setSheets((list) => list.filter((sheet) => sheet.id !== id)), []);
  const open = useCallback<SheetsApi['open']>((title, render) => {
    const id = next.current;
    next.current += 1;
    setSheets((list) => [...list, { id, title, render }]);
    return () => close(id);
  }, [close]);

  // Back closes the newest sheet first
  const last = sheets[sheets.length - 1];
  useEffect(() => {
    if (!last) return undefined;
    return registerBack(() => { close(last.id); return true; });
  }, [last, close]);

  const api = useMemo(() => ({ open }), [open]);
  return (
    <SheetsContext.Provider value={api}>
      {children}
      <div id="modal-root">
        {sheets.map((sheet) => (
          <div key={sheet.id} className="backdrop" onClick={(event) => { if (event.target === event.currentTarget) close(sheet.id); }}>
            <div className="sheet" role="dialog" aria-modal="true" aria-label={sheet.title}>
              {sheet.render(() => close(sheet.id))}
            </div>
          </div>
        ))}
      </div>
    </SheetsContext.Provider>
  );
}

export const useSheets = (): SheetsApi => useContext(SheetsContext);
