import { gb, rate } from '../../lib/format';
import { gpuShortName, level, orDash, usedPercent, type GameFps, type MonitorSample } from './pc';
import { Bar, Big, MonitorCard, Spark, Stat, barStyle, useHistory } from './widgets';

interface PerformancePaneProps {
  hidden: boolean;
  sample: MonitorSample | undefined;
  /** when `sample` arrived (changes with every answer) */
  stamp: number;
  /** the first answer is on its way: the sensors start on demand and take a few seconds */
  loading: boolean;
}

const gbNumber = (mb: number): string => gb(mb).replace(' GB', '');
const CORES = 16;

/** Desempenho: live CPU (per core), memory, GPU, disk and network, plus the game's frame rate in a strip while a game draws frames. */
export function PerformancePane({ hidden, sample, stamp, loading }: PerformancePaneProps) {
  const cpuHistory = useHistory(sample?.cpu.usage, stamp);
  const netDown = sample ? sample.network.reduce((sum, adapter) => sum + (adapter.downBps || 0), 0) : undefined;
  const netUp = sample ? sample.network.reduce((sum, adapter) => sum + (adapter.upBps || 0), 0) : 0;
  const netHistory = useHistory(netDown, stamp);
  const fps: GameFps = sample?.fps ?? null;
  const fpsHistory = useHistory(fps?.fps, stamp);
  const gaming = Boolean(fps);

  const cpu = sample?.cpu;
  const memory = sample?.memory;
  const gpu = sample?.gpu ?? null;
  const total = sample?.disk.total ?? { active: 0, readBps: 0, writeBps: 0 };

  return (
    <section className={`monitor-page pc-pane${gaming ? ' gaming' : ''}`} hidden={hidden}>
      <div className={`card c-fps${gaming ? ' on' : ''}`}>
        <div className="fps-info">
          <span className="fps-game" title={fps?.source ? `Fonte: ${fps.source}` : undefined}>{fps ? fps.app || 'Jogo' : ''}</span>
          <span className="fps-frame">{fps?.frameMs !== undefined ? `${fps.frameMs} ms` : ''}</span>
        </div>
        <div className="big">{fps ? <>{fps.fps}<small>FPS</small></> : null}</div>
        <Spark values={fpsHistory} floor={60} />
      </div>

      <div className="perf-grid">
        <MonitorCard title="CPU" sub={loading ? 'iniciando sensores…' : ''} className="c-cpu">
          <Big value={String(Math.round(cpu?.usage ?? 0))} unit="%" level={level(cpu?.usage, 80, 95)} />
          <Spark values={cpuHistory} max={100} />
          <div className="stats">
            <Stat label="Clock" value={orDash(cpu?.freqMHz, (v) => `${(v / 1000).toFixed(2)} GHz`)} />
            <Stat
              label="Temp."
              value={orDash(cpu?.temp, (v) => `${Math.round(v)} °C`)}
              title={cpu?.tempSource ? `Fonte: ${cpu.tempSource}` : 'Sensor indisponível (abra o MSI Afterburner para ler a temperatura)'}
            />
            <Stat label="Potência" value={orDash(cpu?.power, (v) => `${v.toFixed(0)} W`)} />
            <Stat label="Tarefas" value={cpu ? `${cpu.processes} · ${cpu.threads}` : '–'} />
          </div>
          <div className="cores">
            {Array.from({ length: CORES }, (_, i) => (
              <i key={i} style={{ visibility: cpu && i < cpu.cores.length ? 'visible' : 'hidden' }}>
                <b style={barStyle(cpu?.cores[i] ?? 0)} />
              </i>
            ))}
          </div>
        </MonitorCard>

        <MonitorCard title="Memória" className="c-mem">
          <Big value={memory ? String(memory.usedPct) : '–'} unit={memory ? '%' : undefined} level={level(memory?.usedPct, 80, 92)} />
          <Bar percent={memory?.usedPct ?? 0} level={level(memory?.usedPct, 80, 92)} />
          <div className="stats">
            <Stat label="Em uso" value={memory ? `${gbNumber(memory.usedMB)} / ${gb(memory.totalMB)}` : '–'} />
            <Stat label="Livre" value={memory ? gb(memory.totalMB - memory.usedMB) : '–'} />
            <Stat label="Commit" value={memory?.commitUsedMB !== undefined && memory.commitLimitMB !== undefined ? `${gbNumber(memory.commitUsedMB)} / ${gb(memory.commitLimitMB)}` : '–'} />
          </div>
        </MonitorCard>

        <MonitorCard title="GPU" sub={gpu ? gpuShortName(gpu.name) : ''} className="c-gpu">
          {gpu ? <Big value={String(Math.round(gpu.usage ?? 0))} unit="%" level={level(gpu.usage, 80, 95)} /> : <div className="big" data-level="ok">–</div>}
          <Bar percent={gpu ? ((gpu.memUsedMB ?? 0) / (gpu.memTotalMB || 1)) * 100 : 0} level={gpu ? level(((gpu.memUsedMB ?? 0) / (gpu.memTotalMB || 1)) * 100, 85, 95) : 'ok'} />
          <div className="stats">
            <Stat label="VRAM" value={gpu && gpu.memUsedMB !== undefined && gpu.memTotalMB !== undefined ? `${gbNumber(gpu.memUsedMB)} / ${gb(gpu.memTotalMB)}` : '–'} />
            <Stat label="Temp." value={gpu ? orDash(gpu.temp, (v) => `${v} °C`) : '–'} />
            <Stat label="Potência" value={gpu ? `${orDash(gpu.power, (v) => v.toFixed(0))} / ${orDash(gpu.powerLimit, (v) => v.toFixed(0))} W` : '–'} />
            <Stat label="Fan" value={gpu ? orDash(gpu.fan, (v) => `${v}%`) : '–'} />
            <Stat label="Clock" value={gpu ? orDash(gpu.clock, (v) => `${v} MHz`) : '–'} />
          </div>
        </MonitorCard>

        <MonitorCard title="Disco" className="c-dsk">
          <Big value={String(Math.round(total.active ?? 0))} unit="%" level={level(total.active, 80, 95)} />
          <div className="stats">
            <Stat label="Leitura" value={rate(total.readBps)} />
            <Stat label="Escrita" value={rate(total.writeBps)} />
          </div>
          <div className="scroll">
            {(sample?.disk.drives ?? []).map((drive) => {
              const usedPct = usedPercent(drive.totalGB, drive.freeGB);
              return (
                <div key={drive.name} className="drive" data-drive={drive.name}>
                  <div className="row"><span>{`${drive.name} ${drive.label || ''}`.trim()}</span><b>{`${Math.round(drive.freeGB)} GB livres`}</b></div>
                  <Bar percent={usedPct} level={level(usedPct, 85, 95)} />
                </div>
              );
            })}
          </div>
        </MonitorCard>

        <MonitorCard title="Rede" sub={sample ? sample.network.map((adapter) => adapter.name).join(', ') : ''} className="c-net">
          <div className="big">{`↓ ${rate(netDown ?? 0)}`}</div>
          <Spark values={netHistory} floor={100 * 1024} />
          <div className="stats">
            <Stat label="Envio" value={`↑ ${rate(netUp)}`} />
            <Stat label="Link" value={sample?.network[0]?.speed ?? '–'} />
          </div>
        </MonitorCard>
      </div>
    </section>
  );
}
