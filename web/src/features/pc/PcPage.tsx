import { useQuery } from '@tanstack/react-query';
import { call, client } from '../../api/client';
import { useLiveQuery } from '../../api/events';
import { Page } from '../../shell/Page';
import { useIsActive } from '../../shell/PagerContext';
import { Segmented } from '../../ui/Segmented';
import { PANES, PUSH_PANE, paneStore, usePane } from './paneStore';
import { PushPane } from '../webhooks/PushPane';
import { PerformancePane } from './PerformancePane';
import { ProcessesPane } from './ProcessesPane';
import { SystemPane } from './SystemPane';

const SAMPLE_MS = 2000;
const PROCESS_MS = 3000;
const PUSH_MS = 5000;

/**
 * "PC": one page, three panes behind a selector. Only the active pane of the visible page does any work: samples for Desempenho,
 * the process list for Processos, the one-off facts and the uptime clock for Sistema.
 */
export function PcPage() {
  const onScreen = useIsActive('pc');
  const pane = usePane();
  // what scripts pushed through the webhooks; the pane exists only while there is something to show
  const pushed = useLiveQuery('push', ['push'], () => call(client.GET('/api/hook/push')), { pollMs: onScreen ? PUSH_MS : false });
  const hasPushed = Object.keys(pushed.data?.values ?? {}).length > 0;
  const shownPane = pane === 'push' && !hasPushed ? 'monitor' : pane;

  // every sample is new (the numbers always move): the agent pushes each one and there is no slowing down
  const sample = useLiveQuery('monitor', ['monitor'], () => call(client.GET('/api/monitor/sample')), { enabled: onScreen && shownPane === 'monitor', pollMs: SAMPLE_MS });
  const processes = useLiveQuery('processes', ['processes'], () => call(client.GET('/api/monitor/processes')), { enabled: onScreen && shownPane === 'processes', pollMs: PROCESS_MS });
  // what the machine is does not change while the app is open: asked once, the first time Sistema opens
  const info = useQuery({ queryKey: ['system-info'], queryFn: () => call(client.GET('/api/monitor/info')), enabled: onScreen && shownPane === 'system', staleTime: Infinity, retry: false });

  return (
    <Page section="pc" className="pc-page">
      <Segmented items={hasPushed ? [...PANES, PUSH_PANE] : PANES} value={shownPane} onChange={(id) => paneStore.set(id)} label="PC" />
      <PerformancePane hidden={shownPane !== 'monitor'} sample={sample.data} stamp={sample.dataUpdatedAt} loading={!sample.data && onScreen && shownPane === 'monitor'} />
      <ProcessesPane hidden={shownPane !== 'processes'} processes={processes.data} />
      <PushPane hidden={shownPane !== 'push'} data={pushed.data} />
      <SystemPane hidden={shownPane !== 'system'} active={onScreen && shownPane === 'system'} info={info.data} error={info.error} />
    </Page>
  );
}
