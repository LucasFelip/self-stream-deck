// The demo (docs/desenvolvimento.md): the real panel in a browser, with no PC behind it. This file answers `/api/*` from `snapshot.json` (what a
// `--fake-platform` agent said, recorded by tools/demo/record.cjs) and plays the part of the event stream, so every page works and the webhooks
// can be tried from the little bar at the top. Loaded only by `vite build --mode demo` (see main.tsx); the normal build never contains it.
import snapshot from './snapshot.json';

type Json = Record<string, unknown>;
type Listener = (event: { data: string }) => void;

const answers = snapshot as unknown as Record<string, unknown>;
const state: Json = JSON.parse(JSON.stringify(answers));

// ---- what the stream carries
const TOPIC_SOURCE: Record<string, string> = {
  state: '/api/state',
  audio: '/api/audio',
  media: '/api/media',
  windows: '/api/windows',
  power: '/api/power',
  monitor: '/api/monitor/sample',
  processes: '/api/monitor/processes',
  game: '/api/monitor/fps',
};

const panel = { seq: 0, events: [] as Array<{ seq: number; kind: string; data: unknown; at: number }> };
const pushed: { values: Record<string, { data: unknown; at: number; expiresAt: number | null }>; version: number } = { values: {}, version: 0 };
const rules = { rules: ['musica-na-sala', 'cpu-alta'], active: [] as string[], pausedUntil: null as number | null, error: null as string | null };

const sources = new Set<DemoEventSource>();

function valueOf(topic: string): unknown {
  if (topic === 'push') return pushed;
  if (topic === 'panel') return panel;
  if (topic === 'notifications') return { access: 'allowed', notifications: [] };
  const path = TOPIC_SOURCE[topic];
  return path ? state[path] : undefined;
}

function emit(topic: string): void {
  for (const source of sources) source.send(topic);
}

class DemoEventSource {
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Listener>();
  private readonly topics: string[];

  constructor(url: string) {
    this.topics = (new URL(url, location.href).searchParams.get('topics') ?? '').split(',').filter(Boolean);
    sources.add(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
      for (const topic of this.topics) this.send(topic);
    }, 30);
  }

  addEventListener(name: string, listener: Listener): void { this.listeners.set(name, listener); }

  send(topic: string): void {
    if (this.readyState !== 1 || !this.topics.includes(topic)) return;
    const value = valueOf(topic);
    if (value !== undefined) this.listeners.get(topic)?.({ data: JSON.stringify(value) });
  }

  close(): void { this.readyState = 2; sources.delete(this); }
}

// ---- what the webhooks do here
function queue(kind: string, data: unknown): number {
  panel.seq += 1;
  panel.events.push({ seq: panel.seq, kind, data, at: Date.now() });
  panel.events = panel.events.slice(-50);
  emit('panel');
  return panel.seq;
}

function setValue(key: string, data: unknown, ttlSec: number | null): void {
  const now = Date.now();
  pushed.values[key] = { data, at: now, expiresAt: ttlSec ? now + ttlSec * 1000 : null };
  pushed.version += 1;
  emit('push');
  if (ttlSec) setTimeout(() => { delete pushed.values[key]; pushed.version += 1; emit('push'); }, ttlSec * 1000);
}

function parsed(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function answer(method: string, url: URL, text: string): Response {
  const path = url.pathname.replace(/^.*?(\/api\/)/, '/api/');
  const body = parsed(text);
  if (path === '/api/hook/notify') {
    const object = (typeof body === 'object' && body ? body : { text: String(body) }) as { title?: string; text?: string };
    return reply({ ok: true, seq: queue('notify', { title: object.title ?? '', text: object.text ?? '' }) });
  }
  if (path.startsWith('/api/hook/goto/')) return reply({ ok: true, seq: queue('goto', { page: path.slice('/api/hook/goto/'.length) }) });
  if (path === '/api/hook/refresh') return reply({ ok: true, seq: queue('refresh', null) });
  if (path.startsWith('/api/hook/push/') && method !== 'GET') {
    const key = decodeURIComponent(path.slice('/api/hook/push/'.length));
    if (method === 'DELETE') { delete pushed.values[key]; pushed.version += 1; emit('push'); return reply({ ok: true }); }
    const ttl = Number(url.searchParams.get('ttl')) || null;
    setValue(key, body, ttl);
    return reply({ ok: true, key, version: pushed.version });
  }
  if (path === '/api/hook/push') return reply(pushed);
  if (path === '/api/rules') return reply(rules);
  if (path === '/api/rules/pause') {
    const minutes = Number((body as { minutes?: number }).minutes ?? 0);
    rules.pausedUntil = minutes ? Date.now() + minutes * 60_000 : null;
    return reply({ ok: true, pausedUntil: rules.pausedUntil });
  }
  if (path === '/api/volume' && method === 'POST') {
    const volume = state['/api/volume'] as { level: number; muted: boolean };
    const next = body as { level?: number; muted?: boolean | 'toggle' };
    volume.level = typeof next.level === 'number' ? Math.max(0, Math.min(100, next.level)) : volume.level;
    if (next.muted !== undefined) volume.muted = next.muted === 'toggle' ? !volume.muted : Boolean(next.muted);
    const app = state['/api/state'] as { volume: unknown };
    app.volume = { ...volume };
    emit('state');
    return reply(volume);
  }
  if (method !== 'GET') return reply({ ok: true });
  if (path in state) return reply(state[path]);
  return reply({ error: 'not in the demo' }, 404);
}

// ---- the little bar that lets a visitor try the webhooks
function bar(): void {
  const element = document.createElement('div');
  element.setAttribute('role', 'note');
  element.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;padding:4px 8px;font:12px system-ui,sans-serif;background:#1c2540;color:#d7dae3;';
  element.innerHTML = '<span>Demonstração com dados de mentira.</span>';
  const button = (label: string, run: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'font:inherit;padding:2px 8px;border-radius:6px;border:1px solid #7c9cff;background:transparent;color:#7c9cff;';
    b.addEventListener('click', run);
    element.append(b);
  };
  button('Webhook: aviso', () => { queue('notify', { title: 'CI', text: 'build verde' }); });
  button('Webhook: ir para Som', () => { queue('goto', { page: 'sound' }); });
  button('Webhook: valor', () => { setValue('temp.sala', `${(20 + Math.random() * 4).toFixed(1)} °C`, 60); });
  document.body.prepend(element);
  document.body.style.paddingTop = '28px';
}

export function installDemo(): void {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url, location.href);
    if (!url.pathname.includes('/api/')) return real(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const text = input instanceof Request ? await input.clone().text() : typeof init?.body === 'string' ? init.body : '';
    return answer(method, url, text);
  };
  (window as unknown as { EventSource: unknown }).EventSource = DemoEventSource;
  document.addEventListener('DOMContentLoaded', bar);
  if (document.readyState !== 'loading') bar();
}
