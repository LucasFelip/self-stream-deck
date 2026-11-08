import { useState } from 'react';
import type { Connection } from './connection';

/** The notice at the top of `.main` while the PC cannot be reached: it takes real space (the pager shrinks) and shows only for body[data-state="offline"]. */
export function Offline({ connection }: { connection: Connection }) {
  const [busy, setBusy] = useState(false);
  return (
    <div id="offline" className="offline" role="alert">
      <span id="offline-text">{connection.detail}</span>
      <button
        id="offline-retry"
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try { await connection.retry(); } finally { setBusy(false); }
        }}
      >
        Tentar agora
      </button>
    </div>
  );
}
