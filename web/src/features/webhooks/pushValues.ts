/** How the values the webhooks pushed are shown on the PC page (the "Painel" pane). */

export interface PushEntry {
  key: string;
  text: string;
  /** seconds until it disappears; `null` when it stays */
  leftSec: number | null;
}

interface PushValues {
  values: Record<string, { data: unknown; at: number; expiresAt: number | null }>;
}

const MAX_TEXT = 120;

/** A number or text as it is, anything else as compact JSON; cut at 120 characters. */
export function valueText(data: unknown): string {
  const text = typeof data === 'string' ? data : JSON.stringify(data) ?? '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

/** The values by key, with the time they have left (counted from `now`, unix ms). */
export function entries(data: PushValues | undefined, now: number): PushEntry[] {
  return Object.entries(data?.values ?? {})
    .map(([key, item]) => ({
      key,
      text: valueText(item.data),
      leftSec: item.expiresAt === null ? null : Math.max(0, Math.ceil((item.expiresAt - now) / 1000)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** "5 s", "3 min", "2 h" — what a value has left. */
export function leftText(seconds: number | null): string {
  if (seconds === null) return '';
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}
