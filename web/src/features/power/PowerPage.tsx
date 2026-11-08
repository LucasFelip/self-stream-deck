import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { call, client } from '../../api/client';
import { useLiveQuery } from '../../api/events';
import { clock, duration } from '../../lib/format';
import { Page } from '../../shell/Page';
import { useIsActive } from '../../shell/PagerContext';
import { Icon } from '../../ui/Icon';
import { useSheets } from '../../ui/Sheets';
import { useToast } from '../../ui/Toast';
import { ACTIONS, SCHEDULE_LABELS, type ActionDef } from './actions';
import { ConfirmSheet } from './ConfirmSheet';

const POLL_MS = 5000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * "Energia" page: lock, sleep, hibernate, sign out, restart, shut down, restart into the BIOS or the advanced boot menu, with an
 * optional delay, a visible countdown and a way to cancel. Anything that ends the session asks for confirmation in a sheet.
 */
export function PowerPage() {
  const active = useIsActive('power');
  const toast = useToast();
  const sheets = useSheets();
  const queryClient = useQueryClient();
  const query = useLiveQuery('power', ['power'], () => call(client.GET('/api/power')), { enabled: active, pollMs: POLL_MS });
  const power = query.data;

  // The countdown of a scheduled action and the uptime are counted here, once a second, from when the answer arrived.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const elapsed = power ? Math.max(0, (now - query.dataUpdatedAt) / 1000) : 0;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['power'] });
    void queryClient.invalidateQueries({ queryKey: ['state'] });
  };

  async function perform(action: ActionDef['id'], options: { delaySec?: number; force?: boolean } = {}) {
    try {
      const result = await call(client.POST('/api/power', { body: { action, confirm: true, ...options } }));
      refresh();
      return result;
    } catch (err) {
      toast(`Erro: ${errorText(err)}`, true);
      throw err;
    }
  }

  async function cancelSchedule() {
    try {
      const { cancelled } = await call(client.POST('/api/power', { body: { action: 'cancel' } }));
      toast(cancelled ? 'Agendamento cancelado' : 'Nada estava agendado');
      refresh();
    } catch (err) {
      toast(`Erro: ${errorText(err)}`, true);
    }
  }

  function choose(action: ActionDef) {
    if (action.immediate) {
      perform(action.id).then(() => toast('Bloqueando…')).catch(() => undefined);
      return;
    }
    sheets.open(action.title ?? action.label, (close) => (
      <ConfirmSheet
        action={action}
        power={power}
        close={close}
        onConfirm={(options) => {
          perform(action.id, options)
            .then((result) => toast(result.at ? `${action.label} agendado` : `${action.label}…`))
            .catch(() => undefined); // perform() already showed the error
        }}
      />
    ));
  }

  const pending = power?.scheduled ?? null;
  const left = pending ? Math.max(0, Math.round(pending.inSec - elapsed)) : 0;
  // an action the PC cannot do (hibernation off) is hidden, not greyed out; the "Hibernação: Desativada" line says why
  const shown = ACTIONS.filter((action) => !(action.needs && power && !power[action.needs]));
  // with seven keys the last one takes two columns, so there is no hole (see pages.css)
  const count = power ? shown.length : ACTIONS.length;

  return (
    <Page section="power" className="power-page">
      <div className="power-status">
        <span>Ligado há <b>{power ? duration(power.uptimeSec + elapsed) : '–'}</b></span>
        <span>Reinício pendente <b className={power?.rebootPending ? 'warn' : ''}>{power ? (power.rebootPending ? 'Sim' : 'Não') : ''}</b></span>
        <span>Hibernação <b className={power?.hibernate ? 'ok' : ''}>{power ? (power.hibernate ? 'Ativa' : 'Desativada') : ''}</b></span>
      </div>
      <div className="schedule" hidden={!pending}>
        <span>{pending ? <>{SCHEDULE_LABELS[pending.action] ?? pending.action} em <b>{clock(left)}</b></> : null}</span>
        <button type="button" onClick={cancelSchedule}>Cancelar agendamento</button>
      </div>
      <div className="grid actions-grid" data-count={String(count)}>
        {ACTIONS.map((action) => (
          <button
            key={action.id}
            type="button"
            className="tile act-tile"
            data-tone={action.tone}
            title={action.short}
            aria-label={`${action.label}. ${action.short}`}
            hidden={Boolean(action.needs && power && !power[action.needs])}
            disabled={power?.enabled === false}
            onClick={() => choose(action)}
          >
            <div className="fallback"><Icon name={action.icon} /></div>
            <span>{action.label}</span>
          </button>
        ))}
      </div>
    </Page>
  );
}
