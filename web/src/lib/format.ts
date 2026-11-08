const pad = (n: number): string => String(n).padStart(2, '0');

/** 3725 -> "1:02:05", 65 -> "1:05"; not a number -> "–:––" */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds)) return '–:––';
  const s = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return hours ? `${hours}:${pad(minutes)}:${pad(s % 60)}` : `${minutes}:${pad(s % 60)}`;
}

/** 93784 -> "1d 2h 3min", 3725 -> "1h 02min", 150 -> "2min" */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}min`;
  if (hours) return `${hours}h ${pad(minutes)}min`;
  return `${minutes}min`;
}

export function bytes(value: number): string {
  if (!Number.isFinite(value)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

export const rate = (value: number): string => (Number.isFinite(value) ? `${bytes(value)}/s` : '–');
export const gb = (mb: number): string => (Number.isFinite(mb) ? `${(mb / 1024).toFixed(1)} GB` : '–');
export const pct = (value: number): string => (Number.isFinite(value) ? `${Math.round(value)}%` : '–');
