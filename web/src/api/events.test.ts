import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveHub } from './events';

type Listener = (event: { data: string }) => void;

class FakeSource {
  static all: FakeSource[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, Listener>();
  constructor(readonly url: string) { FakeSource.all.push(this); }
  addEventListener(name: string, listener: Listener) { this.listeners.set(name, listener); }
  close() { this.closed = true; }
  push(name: string, data: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
}

describe('LiveHub', () => {
  let hidden = false;
  let hub: LiveHub;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSource.all = [];
    hidden = false;
    hub = new LiveHub((url) => new FakeSource(url), () => hidden);
  });
  afterEach(() => vi.useRealTimers());

  it('opens one stream for every topic in use, sorted, and hands each value to its listeners', () => {
    const state: unknown[] = [];
    const power: unknown[] = [];
    hub.subscribe('state', (data) => state.push(data));
    hub.subscribe('power', (data) => power.push(data));
    vi.advanceTimersByTime(100);
    expect(FakeSource.all).toHaveLength(1);
    const source = FakeSource.all[0]!;
    expect(source.url).toBe('/api/events?topics=power,state');
    source.push('state', { ui: 1 });
    source.push('power', { enabled: true });
    expect(state).toEqual([{ ui: 1 }]);
    expect(power).toEqual([{ enabled: true }]);
  });

  it('is open after the stream opens, closed after an error, and tells whoever listens', () => {
    const changes = vi.fn();
    hub.onChange(changes);
    hub.subscribe('state', () => undefined);
    vi.advanceTimersByTime(100);
    const source = FakeSource.all[0]!;
    expect(hub.isOpen()).toBe(false);
    source.onopen?.();
    expect(hub.isOpen()).toBe(true);
    source.onerror?.();
    expect(hub.isOpen()).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('changes the stream when the topics change and closes it when nobody listens', () => {
    const offState = hub.subscribe('state', () => undefined);
    vi.advanceTimersByTime(100);
    const first = FakeSource.all[0]!;
    const offAudio = hub.subscribe('audio', () => undefined);
    vi.advanceTimersByTime(100);
    expect(first.closed).toBe(true);
    const second = FakeSource.all[1]!;
    expect(second.url).toBe('/api/events?topics=audio,state');
    offState();
    offAudio();
    vi.advanceTimersByTime(100);
    expect(second.closed).toBe(true);
  });

  it('does not open a stream while the screen is off', () => {
    hidden = true;
    hub.subscribe('state', () => undefined);
    vi.advanceTimersByTime(100);
    expect(FakeSource.all).toHaveLength(0);
  });

  it('starts over, waiting longer each time, when the browser gave up on the stream', () => {
    hub.subscribe('state', () => undefined);
    vi.advanceTimersByTime(100);
    const first = FakeSource.all[0]!;
    first.readyState = 2;
    first.onerror?.();
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(2100);
    vi.advanceTimersByTime(100);
    expect(FakeSource.all).toHaveLength(2);
  });

  it('ignores a message that is not JSON', () => {
    const seen: unknown[] = [];
    hub.subscribe('state', (data) => seen.push(data));
    vi.advanceTimersByTime(100);
    FakeSource.all[0]!.listeners.get('state')?.({ data: '{not json' });
    expect(seen).toEqual([]);
  });
});
