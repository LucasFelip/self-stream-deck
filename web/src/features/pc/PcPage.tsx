import { useQuery, useQueryClient } from '@tanstack/react-query';
import { call, client } from '../../api/client';
import { useLiveQuery } from '../../api/events';
import { Page } from '../../shell/Page';
import { useIsActive } from '../../shell/PagerContext';
import { Segmented } from '../../ui/Segmented';
import { PANES, PUSH_PANE, paneStore, usePane } from './paneStore';
import { PushPane } from '../webhooks/PushPane';
import { PerformancePane } from './PerformancePane';

const SAMPLE_MS = 2000;
const PUSH_MS = 5000;

/**
 * "PC": Desempenho, plus the Painel pane while webhooks have values to show; the selector appears only when there is more than one pane.
 * Only the visible page samples.
 */
export function PcPage() {
  const onScreen = useIsActive('pc');
  const pane = usePane();
  // what scripts pushed through the webhooks; the pane exists only while there is something to show
  const pushed = useLiveQuery('push', ['push'], () => call(client.GET('/api/hook/push')), { pollMs: onScreen ? PUSH_MS : false });
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => call(client.GET('/api/rules')), refetchInterval: onScreen ? PUSH_MS : false, staleTime: PUSH_MS, retry: false });
  const hasPushed = Object.keys(pushed.data?.values ?? {}).length > 0 || (rules.data?.rules.length ?? 0) > 0 || Boolean(rules.data?.error);
  const shownPane = pane === 'push' && !hasPushed ? 'monitor' : pane;
  const pauseRules = (minutes: number) => { void call(client.POST('/api/rules/pause', { body: { minutes } })).then(() => queryClient.invalidateQueries({ queryKey: ['rules'] })); };

  // every sample is new (the numbers always move): the agent pushes each one and there is no slowing down
  const sample = useLiveQuery('monitor', ['monitor'], () => call(client.GET('/api/monitor/sample')), { enabled: onScreen && shownPane === 'monitor', pollMs: SAMPLE_MS });

  return (
    <Page section="pc" className="pc-page">
      {hasPushed ? <Segmented items={[...PANES, PUSH_PANE]} value={shownPane} onChange={(id) => paneStore.set(id)} label="PC" /> : null}
      <PerformancePane hidden={shownPane !== 'monitor'} sample={sample.data} stamp={sample.dataUpdatedAt} loading={!sample.data && onScreen && shownPane === 'monitor'} />
      <PushPane hidden={shownPane !== 'push'} data={pushed.data} rules={rules.data} onPause={pauseRules} />
    </Page>
  );
}
