/** The panel's side of the webhooks (ADR 0010): what to do with the queue of events the agent keeps (the `panel` topic). */

export interface PanelEvent {
  seq: number;
  kind: 'notify' | 'goto' | 'refresh' | 'back';
  data: unknown;
  at: number;
}

export interface PanelFrame {
  seq: number;
  events: PanelEvent[];
}

/** The last event this phone has seen; `null` before the first frame. */
export type PanelCursor = number | null;

/**
 * The events to act on in a frame, and the cursor to keep. The first frame only sets the starting point (a phone that has just started does
 * not replay a day-old notice), and a number that went back means the agent restarted: start over from there, with nothing to do.
 */
export function newEvents(cursor: PanelCursor, frame: PanelFrame): { cursor: number; events: PanelEvent[] } {
  if (cursor === null || frame.seq < cursor) return { cursor: frame.seq, events: [] };
  const events = frame.events.filter((event) => event.seq > cursor).sort((a, b) => a.seq - b.seq);
  return { cursor: Math.max(cursor, frame.seq), events };
}

const MAX_LINE = 160;

/** "📣 CI: verde" (cut at 160 characters). */
export function noticeText(data: unknown): string {
  const { title, text } = (data ?? {}) as { title?: unknown; text?: unknown };
  const head = typeof title === 'string' && title.trim() ? `${title.trim()}: ` : '';
  const line = `${head}${typeof text === 'string' ? text : ''}`.replace(/\s+/g, ' ').trim();
  const clipped = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
  return `📣 ${clipped}`;
}

/** The rule a `goto` or a `back` belongs to (the agent's rules, ADR 0011), or `null` when it comes from a plain webhook. */
export function ruleOf(data: unknown): string | null {
  const rule = (data as { rule?: unknown } | null)?.rule;
  return typeof rule === 'string' && rule ? rule : null;
}

/** The page a `goto` asks for, or `null` when the event does not carry one. */
export function pageOf(data: unknown): string | null {
  const page = (data as { page?: unknown } | null)?.page;
  return typeof page === 'string' && /^[a-z0-9-]{1,32}$/.test(page) ? page : null;
}
