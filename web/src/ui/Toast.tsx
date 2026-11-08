import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

type ToastFn = (message: string, isError?: boolean, ms?: number) => void;

const ToastContext = createContext<ToastFn>(() => undefined);

/** A short notice at the bottom of the screen (`#toast`, styled by style.css). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState({ message: '', error: false, show: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback<ToastFn>((message, isError = false, ms = 2000) => {
    setState({ message, error: isError, show: true });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState((previous) => ({ ...previous, show: false })), ms);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const value = useMemo(() => toast, [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div id="toast" className={`toast${state.error ? ' error' : ''}${state.show ? ' show' : ''}`} role="status" aria-live="polite">
        {state.message}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = (): ToastFn => useContext(ToastContext);
