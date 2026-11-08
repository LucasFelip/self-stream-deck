import type { CSSProperties, ReactNode } from 'react';
import { pushHistory, sparkPaths, type Level } from './pc';
import { useEffect, useState } from 'react';

/** The history of a reading that arrives with every answer (`stamp` changes with each one): the chart's values. */
export function useHistory(value: number | undefined, stamp: number): number[] {
  const [values, setValues] = useState<number[]>([]);
  useEffect(() => {
    if (value === undefined || stamp === 0) return;
    setValues((previous) => pushHistory(previous, value));
    // a new answer is a new reading even when the number is the same
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);
  return values;
}

interface SparkProps {
  values: readonly number[];
  /** the scale's top; omit to use the largest value seen (at least `floor`) */
  max?: number;
  floor?: number;
  alt?: boolean;
}

/** Scrolling line chart. */
export function Spark({ values, max, floor = 1, alt = false }: SparkProps) {
  const { line, fill } = sparkPaths(values, max ?? null, floor);
  return (
    <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none">
      <path className="fill" d={fill} />
      <path className={`line${alt ? ' alt' : ''}`} d={line} />
    </svg>
  );
}

export function Bar({ percent, level = 'ok' }: { percent: number; level?: Level }) {
  const width = Math.max(0, Math.min(100, percent || 0));
  return (
    <div className="bar" data-level={level}>
      <i style={{ width: `${width}%` }} />
    </div>
  );
}

export function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** The big number of a card: `23` + a small `%`. */
export function Big({ value, unit, level }: { value: string; unit?: string; level?: Level }) {
  return <div className="big" data-level={level}>{value}{unit ? <small>{unit}</small> : null}</div>;
}

export function MonitorCard({ title, sub = '', className, children }: { title: string; sub?: string; className: string; children: ReactNode }) {
  return (
    <div className={`card ${className}`}>
      <div className="head"><h3>{title}</h3><span className="sub">{sub}</span></div>
      {children}
    </div>
  );
}

export const barStyle = (height: number): CSSProperties => ({ height: `${Math.min(100, height)}%` });
