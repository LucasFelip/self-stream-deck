import { useState } from 'react';
import { HoldButton } from '../../ui/HoldButton';
import { Icon } from '../../ui/Icon';
import { DELAYS, defaultDelay, isForced, summarize, type ActionDef, type PowerInfo } from './actions';

interface ConfirmSheetProps {
  action: ActionDef;
  power: PowerInfo | undefined;
  close: () => void;
  /** called after the sheet closes, with the options the person chose */
  onConfirm: (options: { delaySec?: number; force?: boolean }) => void;
}

/**
 * The sheet an action that ends the session asks for: it explains the consequences, lists the apps that are open (they may
 * hold unsaved work) and must be *held* to confirm, so a stray tap can't do it.
 */
export function ConfirmSheet({ action, power, close, onConfirm }: ConfirmSheetProps) {
  const [delay, setDelay] = useState(defaultDelay(action));
  const [force, setForce] = useState(false);

  const forced = isForced(force, delay);
  const apps = power && power.openApps.length ? power.openApps.map((app) => app.name).join(', ') : '';

  return (
    <>
      <header data-tone={action.tone}>
        <Icon name={action.icon} />
        <h2>{action.title}</h2>
      </header>
      <p>{action.effects}</p>
      {action.apps && apps ? <p className="warning">{`Janelas abertas: ${apps}. Alterações não salvas podem ser perdidas.`}</p> : null}
      <p>{action.reconnect}</p>
      {action.delay ? (
        <div className="field">
          <label>Quando</label>
          <div className="chips">
            {DELAYS.map(([label, seconds]) => (
              <button key={seconds} type="button" className="chip" aria-pressed={seconds === delay} onClick={() => setDelay(seconds)}>{label}</button>
            ))}
          </div>
        </div>
      ) : null}
      {action.delay ? (
        <button type="button" className="switch" role="switch" aria-checked={forced} disabled={delay > 0} onClick={() => { if (delay === 0) setForce(!force); }}>
          <span className="knob" />
          <span>
            Forçar o fechamento dos apps
            <small>
              {delay > 0
                ? 'Sempre ativo quando há atraso (regra do Windows): alterações não salvas serão perdidas.'
                : 'Sem isso, um app com arquivo aberto pode bloquear o processo e o PC não reinicia.'}
            </small>
          </span>
        </button>
      ) : null}
      {action.delay ? <p className="muted">{summarize(action, delay, forced)}</p> : null}
      <div className="sheet-actions">
        <button type="button" onClick={close}>Cancelar</button>
        <HoldButton
          label={`Segure para ${action.label.toLowerCase()}`}
          onDone={() => {
            close();
            onConfirm(action.delay ? { delaySec: delay, force: forced } : {});
          }}
        />
      </div>
    </>
  );
}
