import { useQuery } from '@tanstack/react-query';
import { call, client } from '../../api/client';
import { useLiveQuery } from '../../api/events';
import { Page } from '../../shell/Page';
import { useIsActive } from '../../shell/PagerContext';
import { Segmented } from '../../ui/Segmented';
import { PANES, paneStore, usePane } from './paneStore';
import { PerformancePane } from './PerformancePane';
import { ProcessesPane } from './ProcessesPane';
import { SystemPane } from './SystemPane';

const SAMPLE_MS = 2000;
const PROCESS_MS = 3000;

/**
 * "PC": one page, three panes behind a selector. Only the active pane of the visible page does any work: samples for Desempenho,
 * the process list for Processos, the one-off facts and the uptime clock for Sistema.
 */
export function PcPage() {
  const onScreen = useIsActive('pc');
  const pane = usePane();

  // every sample is new (the numbers always move): the agent pushes each one and there is no slowing down
  const sample = useLiveQuery('monitor', ['monitor'], () => call(client.GET('/api/monitor/sample')), { enabled: onScreen && pane === 'monitor', pollMs: SAMPLE_MS });
  const processes = useLiveQuery('processes', ['processes'], () => call(client.GET('/api/monitor/processes')), { enabled: onScreen && pane === 'processes', pollMs: PROCESS_MS });
  // what the machine is does not change while the app is open: asked once, the first time Sistema opens
  const info = useQuery({ queryKey: ['system-info'], queryFn: () => call(client.GET('/api/monitor/info')), enabled: onScreen && pane === 'system', staleTime: Infinity, retry: false });

  return (
    <Page section="pc" className="pc-page">
      <Segmented items={PANES} value={pane} onChange={(id) => paneStore.set(id)} label="PC" />
      <PerformancePane hidden={pane !== 'monitor'} sample={sample.data} stamp={sample.dataUpdatedAt} loading={!sample.data && onScreen && pane === 'monitor'} />
      <ProcessesPane hidden={pane !== 'processes'} processes={processes.data} />
      <SystemPane hidden={pane !== 'system'} active={onScreen && pane === 'system'} info={info.data} error={info.error} />
    </Page>
  );
}
