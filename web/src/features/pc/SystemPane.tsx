import { useEffect, useState, type ReactNode } from 'react';
import { duration } from '../../lib/format';
import { orDash, storageBlocks, usedPercent, type SystemInfo } from './pc';
import { Bar } from './widgets';

type Row = readonly [string, string | number | null | undefined];

const date = (iso: string | undefined): string => (iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–');
const dateTime = (iso: string | undefined): string => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');

/** Label/value pairs; a row with nothing to say is left out. */
function Kv({ rows }: { rows: readonly Row[] }) {
  return (
    <dl className="kv">
      {rows.filter(([, value]) => value !== null && value !== undefined && value !== '').map(([key, value]) => (
        <KvRow key={key} label={key} value={String(value)} />
      ))}
    </dl>
  );
}
const KvRow = ({ label, value }: { label: string; value: string }) => <><dt>{label}</dt><dd>{value}</dd></>;

const InfoCard = ({ title, children }: { title: string; children: ReactNode }) => <div className="card"><h3>{title}</h3>{children}</div>;

function DriveRow({ drive }: { drive: SystemInfo['drives'][number] }) {
  return (
    <div className="drive">
      <div className="row">
        <span>{`${drive.name} ${drive.label || ''} · ${drive.fs ?? ''}`.trim()}</span>
        <b>{`${drive.freeGB} / ${drive.totalGB} GB livres`}</b>
      </div>
      <Bar percent={usedPercent(drive.totalGB, drive.freeGB)} />
    </div>
  );
}

interface SystemPaneProps {
  hidden: boolean;
  /** the pane is the one on screen: the uptime ticks only then */
  active: boolean;
  info: SystemInfo | undefined;
  error: Error | null;
}

/** Sistema: what the machine is (OS, CPU, RAM modules, GPU, board, storage, network, monitors). Read once; only the uptime moves. */
export function SystemPane({ hidden, active, info, error }: SystemPaneProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!info) {
    return (
      <section className="system-page pc-pane" hidden={hidden}>
        <div className="loading">{error ? `Não foi possível ler o sistema: ${error.message}` : 'Lendo informações do sistema…'}</div>
      </section>
    );
  }

  const { os, cpu, memory, gpus, board, storage, network, monitors } = info;
  const boot = os.lastBoot ? new Date(os.lastBoot).getTime() : null;
  const uptime = boot ? duration((now - boot) / 1000) : '–';

  // four themed columns (landscape; two grid columns in portrait, see .system-page): the cards of a column share its height
  return (
    <section className="system-page pc-pane" hidden={hidden}>
      <div className="col">
        <InfoCard title="Sistema">
          <Kv rows={[['Computador', info.host], ['Usuário', info.user], ['Windows', os.name.replace(/^Microsoft\s+/, '')], ['Versão', `${os.version} (build ${os.build})`], ['Arquitetura', os.arch], ['Instalado em', date(os.installed)], ['Último boot', dateTime(os.lastBoot)], ['Ligado há', uptime]]} />
        </InfoCard>
        <InfoCard title="Monitores">
          <Kv rows={monitors.map((monitor) => [monitor.name + (monitor.primary ? ' ★' : ''), `${monitor.width}×${monitor.height}`] as const)} />
        </InfoCard>
      </div>
      <div className="col">
        <InfoCard title="Processador">
          <Kv rows={[['Modelo', cpu.name], ['Núcleos / threads', `${cpu.cores} / ${cpu.threads}`], ['Clock base', orDash(cpu.maxMHz, (v) => `${(v / 1000).toFixed(2)} GHz`)], ['Cache', `L2 ${(cpu.l2KB ?? 0) / 1024} MB · L3 ${(cpu.l3KB ?? 0) / 1024} MB`]]} />
        </InfoCard>
        <InfoCard title="Memória">
          <Kv rows={[['Total', `${memory.totalGB} GB`], ...memory.modules.map((m) => [m.slot, `${m.sizeGB} GB ${m.type ?? ''} ${m.speed || ''} MHz`.replace(/\s+/g, ' ')] as const)]} />
        </InfoCard>
        <InfoCard title="Placa-mãe">
          <Kv rows={[['Fabricante', board.maker], ['Modelo', board.model], ['BIOS', board.bios], ['Data da BIOS', date(board.biosDate)]]} />
        </InfoCard>
      </div>
      <div className="col">
        <InfoCard title="Vídeo">
          {gpus.map((gpu) => <Kv key={gpu.name} rows={[['Placa', gpu.name], ['VRAM', `${gpu.vramGB} GB`], ['Driver', gpu.driver]]} />)}
        </InfoCard>
        <InfoCard title="Rede">
          {network.map((adapter) => <Kv key={adapter.name} rows={[[adapter.name, adapter.ip], ['Link', adapter.speed], ['MAC', adapter.mac]]} />)}
        </InfoCard>
      </div>
      <div className="col">
        <InfoCard title="Armazenamento">
          {storageBlocks(storage, info.drives).map((block, index) => (
            <div className="disk" key={block.disk ? `d${block.disk.id ?? block.disk.model}` : `loose${index}`}>
              {block.disk ? <><div className="disk-name">{block.disk.model}</div><div className="disk-kind">{block.kind}</div></> : null}
              {block.drives.map((drive) => <DriveRow key={drive.name} drive={drive} />)}
            </div>
          ))}
        </InfoCard>
      </div>
    </section>
  );
}
