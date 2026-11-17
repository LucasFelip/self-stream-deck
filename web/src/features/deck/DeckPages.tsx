import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { Page } from '../../shell/Page';
import { usePager } from '../../shell/PagerContext';
import { useDeckData } from './data';
import { Slot, Tile } from './Tile';
import type { DeckItem } from './items';
import { appsLayout, measure } from './layout';
import { takeFlip } from './flip';
import { useDeckActions } from './useDeckActions';

const px = (value: number): string => `${value}px`;

interface GridProps {
  section: 'apps';
  items: readonly DeckItem[];
  cols: number;
  rows: number;
  compact?: boolean;
  /** how many cells the grid has; the ones without a key are empty slots */
  cells: number;
  running: ReadonlySet<string>;
  open: ReadonlySet<string>;
  /** where the first slot of this grid sits in the section (a page of Atalhos starts after the previous ones) */
  firstSlot: number;
}

function Grid({ section, items, cols, rows, compact = false, cells, running, open, firstSlot }: GridProps) {
  const { tap } = useDeckActions();
  const element = useRef<HTMLDivElement | null>(null);

  // after a drop the keys glide from where they were to where they are
  useLayoutEffect(() => {
    const grid = element.current;
    if (grid) takeFlip(grid);
  });

  const style = { '--cols': cols, '--rows': rows } as CSSProperties;
  return (
    <div className={compact ? 'grid compact' : 'grid'} style={style} ref={element}>
      {items.map((item) => <Tile key={item.key} item={item} running={item.kind === 'app' && running.has(item.id)} open={item.kind === 'app' && open.has(item.id)} onTap={tap} />)}
      {Array.from({ length: Math.max(0, cells - items.length) }, (_, i) => <Slot key={`slot${i}`} section={section} index={firstSlot + items.length + i} />)}
    </div>
  );
}

/**
 * Apps: ONE page with every key on it. Few keys: the normal grid; more than it holds: the compact fit (see appsLayout); only when even that
 * is too small to read does the page scroll.
 */
export function AppsPage() {
  const { metrics } = usePager();
  const { ready, apps, running, open } = useDeckData();
  const base = measure(metrics);
  const measured = metrics.width > 0;

  // the camera key is always there, so the page is never empty; before the app list is read it shows nothing rather than the camera alone
  if (!ready) return <Page section="apps" id="apps-0" title="Aplicativos" className="generated" />;
  const fit = appsLayout(apps.length, base, metrics.landscape);
  const style = { '--icon': px(base.icon), '--tile-h': px(base.tileH), '--apps-icon': px(fit.icon) } as CSSProperties;
  return (
    <Page section="apps" id="apps-0" title="Aplicativos" className={`generated${fit.mode === 'scroll' ? ' scroll' : ''}`} style={style}>
      {measured ? <Grid section="apps" items={apps} cols={fit.cols} rows={fit.rows} compact={fit.mode === 'fit'} cells={fit.cols * fit.rows} running={running} open={open} firstSlot={0} /> : null}
    </Page>
  );
}
