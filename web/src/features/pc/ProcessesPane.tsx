import { gb } from '../../lib/format';
import { Bar } from './widgets';
import type { Processes } from './pc';

type Group = Processes['cpu'][number];

function List({ items, valueOf, share }: { items: readonly Group[]; valueOf: (item: Group) => string; share: (item: Group) => number }) {
  return (
    <div className="scroll">
      {items.map((item) => (
        <div className="proc" key={item.name}>
          <div className="name">{item.name}{item.count > 1 ? <small>{` ×${item.count}`}</small> : null}</div>
          <div className="val">{valueOf(item)}</div>
          <Bar percent={share(item)} />
        </div>
      ))}
    </div>
  );
}

/** Processos: the top groups by CPU and by memory (read only, nothing can be ended from here). */
export function ProcessesPane({ hidden, processes }: { hidden: boolean; processes: Processes | undefined }) {
  const cpu = processes?.cpu ?? [];
  const mem = processes?.mem ?? [];
  const topCpu = Math.max(1, ...cpu.map((item) => item.cpu));
  const topMem = Math.max(1, ...mem.map((item) => item.memMB));
  return (
    <section className="processes-page pc-pane" hidden={hidden}>
      <div className="card">
        <h3>Maiores usos de CPU</h3>
        <List items={cpu} valueOf={(item) => `${item.cpu.toFixed(1)}%`} share={(item) => (item.cpu / topCpu) * 100} />
      </div>
      <div className="card">
        <h3>Maiores usos de memória</h3>
        <List items={mem} valueOf={(item) => gb(item.memMB)} share={(item) => (item.memMB / topMem) * 100} />
      </div>
    </section>
  );
}
