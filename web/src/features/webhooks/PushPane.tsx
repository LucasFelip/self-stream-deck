import { useEffect, useState } from 'react';
import { entries, leftText } from './pushValues';

type Values = Parameters<typeof entries>[0];

/** Painel: what scripts and automations pushed through the webhooks, one row per key, with the time the value has left. */
export function PushPane({ hidden, data }: { hidden: boolean; data: Values }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (hidden) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hidden]);
  const rows = entries(data, now);
  return (
    <section className="push-pane pc-pane" hidden={hidden}>
      <div className="card">
        <h3>Painel</h3>
        <div className="scroll">
          <dl className="kv">
            {rows.map((row) => (
              <PushRow key={row.key} name={row.key} text={row.text} left={leftText(row.leftSec)} />
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

const PushRow = ({ name, text, left }: { name: string; text: string; left: string }) => (
  <>
    <dt>{name}</dt>
    <dd>{left ? `${text} · ${left}` : text}</dd>
  </>
);
