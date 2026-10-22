'use strict';

// public/js/live.js: pushed values reach the page, and when the stream is not available the page polls, slowing down while
// nothing changes and speeding up again on change. Run in a vm with a stand-in browser.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function load({ withEventSource }) {
  const sources = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = {}; sources.push(this); setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 5); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    close() { this.readyState = 2; }
    push(name, data) { if (this.listeners[name]) this.listeners[name]({ data: JSON.stringify(data) }); }
  }
  const sandbox = { Deck: {}, document: { hidden: false, addEventListener() {} }, setTimeout, clearTimeout, JSON, Date, Promise, Set, Map, console };
  if (withEventSource) sandbox.EventSource = FakeEventSource;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'live.js'), 'utf8'), sandbox, { filename: 'live.js' });
  return { live: sandbox.Deck.live, sources };
}

(async () => {
  await test('a subscriber gets the values the PC pushes, on one stream for all topics', async () => {
    const { live, sources } = load({ withEventSource: true });
    const seen = [];
    const stopA = live.subscribe('windows', (data) => seen.push(['windows', data]));
    live.subscribe('audio', (data) => seen.push(['audio', data]));
    await sleep(120);
    assert.strictEqual(sources.length, 1);
    assert.strictEqual(sources[0].url, '/api/events?topics=audio,windows');
    assert.strictEqual(live.open, true);
    sources[0].push('windows', { n: 1 });
    sources[0].push('audio', { n: 2 });
    assert.deepStrictEqual(seen, [['windows', { n: 1 }], ['audio', { n: 2 }]]);
    stopA();
    await sleep(120);
    assert.strictEqual(sources.length, 2, 'the stream is reopened for the topics that remain');
    assert.strictEqual(sources[1].url, '/api/events?topics=audio');
  });

  await test('while the stream is open watch() does not poll', async () => {
    const { live } = load({ withEventSource: true });
    let polls = 0;
    const watcher = live.watch('windows', { apply() {}, poll: async () => { polls += 1; return {}; }, ms: 150 });
    await sleep(500);
    assert.strictEqual(live.open, true);
    // one read right away (before the stream is up) is all it takes; then the pushes do the work
    assert.ok(polls <= 2, `polled ${polls} times with the stream open`);
    watcher.stop();
  });

  await test('without a stream watch() polls, then slows down when nothing changes and speeds up on a change', async () => {
    const { live } = load({ withEventSource: false });
    const times = [];
    let value = 0;
    const applied = [];
    const watcher = live.watch('windows', { apply: (data) => applied.push(data), poll: async () => { times.push(Date.now()); return { value }; }, ms: 10, idleMs: 80, idleAfter: 3 });
    await sleep(400);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    assert.ok(gaps[0] < 40, `starts at the normal pace: ${gaps}`);
    assert.ok(gaps[gaps.length - 1] >= 60, `slows down while nothing changes: ${gaps}`);
    value = 1;
    const before = times.length;
    watcher.nudge();
    await sleep(300);
    assert.ok(applied.some((data) => data.value === 1), 'the change is applied');
    const after = times.slice(before).map((t, i, list) => (i ? t - list[i - 1] : 0)).slice(1);
    assert.ok(after.some((gap) => gap < 40), `a change brings the normal pace back: ${after}`);
    watcher.stop();
  });

  await test('stop() ends polling', async () => {
    const { live } = load({ withEventSource: false });
    let polls = 0;
    const watcher = live.watch('audio', { apply() {}, poll: async () => { polls += 1; return {}; }, ms: 10 });
    await sleep(60);
    watcher.stop();
    const at = polls;
    await sleep(100);
    assert.strictEqual(polls, at);
  });

  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((err) => { console.log(err); process.exit(1); });
