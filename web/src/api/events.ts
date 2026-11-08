import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import type { components } from './schema';

export type EventTopic = components['schemas']['EventTopic'];

type Listener = (data: unknown) => void;

interface EventSourceLike {
  readyState: number;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(name: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

/**
 * Live updates from the PC (server-sent events, GET /api/events), one stream for every topic in use: the same job as
 * live.js in the old interface. The stream closes while the screen is off and reopens (the agent sends the latest values at
 * once) when it is on again; if it cannot open, the pages poll their GET route instead (see useLiveQuery).
 */
export class LiveHub {
  private handlers = new Map<EventTopic, Set<Listener>>();
  private changes = new Set<() => void>();
  private source: EventSourceLike | null = null;
  private wanted = '';
  private open = false;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly create: (url: string) => EventSourceLike;
  private readonly custom: boolean;

  constructor(
    create?: (url: string) => EventSourceLike,
    private readonly hidden: () => boolean = () => document.hidden,
  ) {
    this.custom = Boolean(create);
    this.create = create ?? ((url) => new EventSource(url) as unknown as EventSourceLike);
    document.addEventListener('visibilitychange', () => this.sync());
  }

  /** true while the stream is open */
  isOpen = (): boolean => this.open;

  /** for useSyncExternalStore */
  onChange = (fn: () => void): (() => void) => {
    this.changes.add(fn);
    return () => { this.changes.delete(fn); };
  };

  subscribe(topic: EventTopic, listener: Listener): () => void {
    let set = this.handlers.get(topic);
    if (!set) { set = new Set(); this.handlers.set(topic, set); }
    set.add(listener);
    this.sync();
    return () => {
      set.delete(listener);
      this.sync();
    };
  }

  private topicList(): string {
    return [...this.handlers.entries()].filter(([, set]) => set.size).map(([name]) => name).sort().join(',');
  }

  private setOpen(value: boolean): void {
    if (this.open === value) return;
    this.open = value;
    this.changes.forEach((fn) => fn());
  }

  private close(): void {
    this.source?.close();
    this.source = null;
    this.wanted = '';
    clearTimeout(this.retryTimer);
    this.setOpen(false);
  }

  private connect(list: string): void {
    this.wanted = list;
    const source = this.create(`/api/events?topics=${list}`);
    this.source = source;
    source.onopen = () => { this.failures = 0; this.setOpen(true); };
    source.onerror = () => {
      this.setOpen(false);
      // the browser reconnects by itself unless it gave up (an error answer): then start over, waiting longer each time
      if (this.source === source && source.readyState === 2) {
        source.close();
        this.source = null;
        this.wanted = '';
        this.failures += 1;
        this.retryTimer = setTimeout(() => this.sync(), Math.min(15000, 2000 * this.failures));
      }
    };
    for (const name of list.split(',') as EventTopic[]) {
      source.addEventListener(name, (event) => {
        let data: unknown;
        try { data = JSON.parse(event.data); } catch { return; /* a message that is not JSON is ignored */ }
        this.handlers.get(name)?.forEach((fn) => fn(data));
      });
    }
  }

  /** Opens, changes or closes the stream to match what is subscribed (a short pause groups a page change into one reconnect). */
  private sync(): void {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      const list = this.topicList();
      if (!list || this.hidden() || (!this.custom && typeof EventSource === 'undefined')) { this.close(); return; }
      if (this.source && list === this.wanted) return;
      if (this.source) this.close();
      this.connect(list);
    }, 60);
  }
}

export const hub = new LiveHub();

interface LiveOptions {
  /** the page shows this data right now; false stops the subscription and the polling */
  enabled?: boolean;
  /** how often to ask the GET route while the stream is not open; false: the caller polls by itself (see useConnection) */
  pollMs: number | false;
}

/**
 * Data that the agent pushes as an event and that can also be fetched: the pushed value lands in the query cache, and
 * the GET route is polled only while the stream is closed. The same object either way (contract: x-events).
 */
export function useLiveQuery<T>(topic: EventTopic, key: QueryKey, fetcher: () => Promise<T>, { enabled = true, pollMs }: LiveOptions) {
  const queryClient = useQueryClient();
  const streamOpen = useSyncExternalStore(hub.onChange, hub.isOpen);
  useEffect(() => {
    if (!enabled) return undefined;
    return hub.subscribe(topic, (data) => queryClient.setQueryData(key, data as T));
    // the key is a constant array per call site; its serialized form is the dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, topic, queryClient, JSON.stringify(key)]);
  return useQuery({
    queryKey: key,
    queryFn: fetcher,
    enabled,
    refetchInterval: streamOpen ? false : pollMs,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
