import { useEffect, useState } from 'react';
import { entries, leftText } from './pushValues';

type Values = Parameters<typeof entries>[0];

export interface RulesInfo {
  rules: string[];
  active: string[];
  pausedUntil: number | null;
  error: string | null;
}

interface PushPaneProps {
  hidden: boolean;
  data: Values;
  rules: RulesInfo | undefined;
  /** 0 resumes the rules */
  onPause: (minutes: number) => void;
}

const PAUSE_MIN = 30;

/** "Regras": how many rules, which hold now, and a button to pause them (or to resume). */
function RulesCard({ rules, now, onPause }: { rules: RulesInfo; now: number; onPause: (minutes: number) => void }) {
  const paused = rules.pausedUntil !== null && rules.pausedUntil > now;
  const left = paused && rules.pausedUntil ? leftText(Math.ceil((rules.pausedUntil - now) / 1000)) : '';
  return (
    <div className="card rules-card">
      <h3>Regras</h3>
      <dl className="kv">
        <dt>Ativas agora</dt>
        <dd>{rules.active.length ? rules.active.join(', ') : 'nenhuma'}</dd>
        <dt>Cadastradas</dt>
        <dd>{`${rules.rules.length}${paused ? ` · pausadas (${left})` : ''}`}</dd>
        {rules.error ? <><dt>Erro</dt><dd>{rules.error}</dd></> : null}
      </dl>
      <button type="button" className="overlay-close" data-rules-pause onClick={() => onPause(paused ? 0 : PAUSE_MIN)}>
        {paused ? 'Retomar regras' : `Pausar ${PAUSE_MIN} min`}
      </button>
    </div>
  );
}

/** Painel: what scripts and automations pushed through the webhooks (one row per key, with the time the value has left) and the rules. */
export function PushPane({ hidden, data, rules, onPause }: PushPaneProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (hidden) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hidden]);
  const rows = entries(data, now);
  return (
    <section className="push-pane pc-pane" hidden={hidden}>
      {rows.length > 0 ? (
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
      ) : null}
      {rules && (rules.rules.length > 0 || rules.error) ? <RulesCard rules={rules} now={now} onPause={onPause} /> : null}
    </section>
  );
}

const PushRow = ({ name, text, left }: { name: string; text: string; left: string }) => (
  <>
    <dt>{name}</dt>
    <dd>{left ? `${text} · ${left}` : text}</dd>
  </>
);
