'use strict';

// The parts of the new interface that live around the pages, in a real headless browser against the fake deck server: a game starting
// (the FPS counter and the slide to PC > Desempenho), the idle dimmer, Windows notifications, the self-update reload and the iPhone
// extras (the pairing code in the menu, the wake lock asked for again). The cases are the old interface's, ported.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fakeDeck, launchBrowser, findBrowser, sleep } = require('./harness.cjs');
const { tapTab, tapUntil, posts } = require('./support.cjs');

const DIST = path.join(__dirname, '..', 'dist', 'index.html');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };

(async () => {
  if (!findBrowser()) { console.log('skipped (no Chrome, Brave or Edge found; set CHROME_PATH)'); return; }
  if (!fs.existsSync(DIST)) { console.log('skipped (web/dist is not built: npm run build)'); return; }

  const deck = await fakeDeck();
  const extra = [];
  const open = async (width, height, script, ready = `document.querySelectorAll('.tile[data-key]').length >= 1`) => {
    const browser = await launchBrowser({ width, height });
    extra.push(browser);
    const page = await browser.open(`${deck.url}/`, script ? { script } : {});
    await page.waitFor(ready, 'the keys');
    await page.waitFor(`document.body.dataset.state === 'online'`, 'online', 9000);
    await sleep(400);
    return { page, close: () => browser.close() };
  };
  const openMenuItem = async (page, label) => {
    await tapUntil(page, '#menu', `!document.getElementById('menu-pop').hidden`, 'the menu');
    await page.eval(`[...document.querySelectorAll('#menu-pop button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
  };
  const paneTab = (page, name) => tapUntil(page, `.pc-page .seg-btn[data-seg="${name}"]`, `document.querySelector('.pc-page .seg-btn[data-seg="${name}"]').getAttribute('aria-selected') === 'true'`, `the ${name} pane`);

  try {
    await test('a game starting opens PC > Desempenho even from another pane, the counter shows on every other page and goes away when the game ends', async () => {
      const { page, close } = await open(836, 387);
      try {
        await tapTab(page, 'pc');
        await paneTab(page, 'processes');
        await tapTab(page, 'apps');
        deck.model.fps = { fps: 90, frameMs: 11.1, app: 'Jogo', source: 'RTSS' };
        deck.model.pushGame();
        await page.waitFor(`document.querySelector('#tabs .tab[data-section="pc"]').getAttribute('aria-selected') === 'true' && document.querySelector('.pc-page .seg-btn[data-seg="monitor"]').getAttribute('aria-selected') === 'true'`, 'PC > Desempenho for the game', 8000);
        assert.strictEqual(await page.eval(`document.getElementById('fps').hidden`), true, 'the counter hides on Desempenho');
        const easing = `getComputedStyle(document.querySelector('.monitor-page .bar > i')).transitionDuration`;
        await page.waitFor(`document.querySelector('.monitor-page').classList.contains('gaming')`, 'the page knowing about the game');
        assert.strictEqual(await page.eval(easing), '0s', 'the bars do not ease while a game runs');
        // the counter shows on another page
        await tapTab(page, 'apps');
        await page.waitFor(`!document.getElementById('fps').hidden && document.querySelector('#fps b').textContent === '90'`, 'the counter outside Desempenho');
        // a floating counter: fixed in a corner, inside the screen, takes no touch, clear of the gear and of the navigation
        const fps = await page.eval(`(() => {
          const e = document.getElementById('fps'); const r = e.getBoundingClientRect();
          const m = document.getElementById('menu').getBoundingClientRect(); const n = document.querySelector('nav.nav').getBoundingClientRect();
          const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          return { pos: getComputedStyle(e).position, events: getComputedStyle(e).pointerEvents, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, overMenu: hit(r, m), overNav: hit(r, n), small: r.width <= 90 && r.height <= 50 };
        })()`);
        assert.deepStrictEqual(fps, { pos: 'fixed', events: 'none', inside: true, overMenu: false, overNav: false, small: true });
        deck.model.fps = null;
        deck.model.pushGame();
        await page.waitFor(`document.getElementById('fps').hidden`, 'the game ending', 9000);
        await tapTab(page, 'pc');
        await page.waitFor(`getComputedStyle(document.querySelector('.monitor-page .bar > i')).transitionDuration !== '0s'`, 'the bars easing again once the game ends', 8000);
      } finally { deck.model.fps = null; close(); }
    });

    await test('a game already running at load: the frame rate arrives before the pages exist and the counter still shows', async () => {
      deck.model.fps = { fps: 72, frameMs: 13.9, app: 'Jogo', source: 'RTSS' };
      const { page, close } = await open(836, 387);
      try {
        // slides to Desempenho once the pages exist (the counter hides there), then shows on any other page
        await page.waitFor(`document.querySelector('#tabs .tab[data-section="pc"]')?.getAttribute('aria-selected') === 'true' && document.querySelector('.pc-page .seg-btn[data-seg="monitor"]')?.getAttribute('aria-selected') === 'true'`, 'the slide to PC > Desempenho', 8000);
        await tapTab(page, 'apps');
        await page.waitFor(`!document.getElementById('fps').hidden && document.querySelector('#fps b').textContent === '72'`, 'the counter');
      } finally { deck.model.fps = null; close(); }
    });

    const DIM = `window.__ssdIdleUnitMs = 1200; window.__dim = []; window.Android = { vibrate() {}, setDim(on) { window.__dim.push(on); } };`;

    await test('idle dimmer: the menu opens its settings; the choice (minutes) is kept in localStorage', async () => {
      const { page, close } = await open(411, 914, `window.__ssdIdleUnitMs = 60000;`);
      try {
        await openMenuItem(page, 'Escurecer após…');
        await page.waitFor(`!document.querySelector('.idle-page').closest('.overlay').hidden`, 'the settings sheet');
        assert.deepStrictEqual(await page.eval(`[...document.querySelectorAll('.idle-page .seg-btn')].map((b) => b.dataset.seg)`), ['0', '1', '2', '5']);
        assert.strictEqual(await page.eval(`document.querySelector('.idle-page .seg-btn[aria-selected="true"]').dataset.seg`), '0', 'off by default');
        await tapUntil(page, '.idle-page .seg-btn[data-seg="2"]', `document.querySelector('.idle-page .seg-btn[data-seg="2"]').getAttribute('aria-selected') === 'true'`, 'the 2 min option');
        assert.strictEqual(await page.eval(`localStorage.getItem('ssd.idleMinutes')`), '2');
        assert.strictEqual(await page.eval('Deck.back()'), true);
        await page.waitFor(`document.querySelector('.idle-page').closest('.overlay').hidden`, 'the sheet closed by Back');
        await page.eval(`localStorage.removeItem('ssd.idleMinutes')`);
        assert.deepStrictEqual(page.errors, []);
      } finally { close(); }
    });

    await test('idle dimmer: dims after the time, calls Android.setDim, and the first touch only wakes (no key fires) and restarts the timer', async () => {
      const { page, close } = await open(411, 914, `${DIM} localStorage.setItem('ssd.idleMinutes', '1');`);
      try {
        const launches = () => deck.model.calls.filter((c) => c.path.startsWith('/api/launch')).length;
        const before = launches();
        const dimmed = () => page.eval(`document.querySelector('.idle-veil').dataset.dimmed === 'true'`);
        await page.waitFor(`document.querySelector('.idle-veil').dataset.dimmed === 'true' && !document.querySelector('.idle-veil').hidden`, 'the veil', 6000);
        assert.deepStrictEqual(await page.eval('window.__dim'), [true]);
        assert.ok(Number(await page.eval(`getComputedStyle(document.querySelector('.idle-veil')).opacity`)) > 0.9);
        await page.tap('.tile[data-key^="a:"]');
        await page.waitFor(`document.querySelector('.idle-veil').dataset.dimmed === 'false'`, 'waking');
        await sleep(700);
        assert.strictEqual(await page.eval(`document.querySelector('.idle-veil').hidden`), true);
        assert.deepStrictEqual(await page.eval('window.__dim'), [true, false]);
        assert.strictEqual(launches(), before, 'the waking tap did not launch the app');
        await page.waitFor(`document.querySelector('.idle-veil').dataset.dimmed === 'true'`, 'dims again after the idle time', 6000);
        // wake, then turn it off: it stays awake
        await page.tap('.tile[data-key^="a:"]');
        await page.waitFor(`document.querySelector('.idle-veil').dataset.dimmed === 'false'`, 'waking');
        await sleep(500);
        await openMenuItem(page, 'Escurecer após…');
        await tapUntil(page, '.idle-page .seg-btn[data-seg="0"]', `document.querySelector('.idle-page .seg-btn[data-seg="0"]').getAttribute('aria-selected') === 'true'`, 'off');
        await page.eval('Deck.back()');
        await sleep(2600);
        assert.strictEqual(await dimmed(), false, 'off stays awake');
        assert.deepStrictEqual(page.errors, []);
      } finally { close(); }
    });

    await test('idle dimmer: works without Android.setDim (old APK) and with localStorage unavailable; an open sheet postpones it', async () => {
      const NOSTORE = `window.__ssdIdleUnitMs = 400; window.Android = { vibrate() {} }; Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });`;
      const { page, close } = await open(411, 914, NOSTORE);
      try {
        await openMenuItem(page, 'Escurecer após…');
        await tapUntil(page, '.idle-page .seg-btn[data-seg="1"]', `document.querySelector('.idle-page .seg-btn[data-seg="1"]').getAttribute('aria-selected') === 'true'`, 'the 1 min option');
        await sleep(1500);
        assert.strictEqual(await page.eval(`document.querySelector('.idle-veil').dataset.dimmed`), 'false', 'an open overlay blocks it');
        await page.eval('Deck.back()');
        await page.waitFor(`document.querySelector('.idle-veil').dataset.dimmed === 'true'`, 'dims once nothing is open', 9000);
        assert.ok(!page.errors.length, JSON.stringify(page.errors));
      } finally { close(); }
    });

    await test('notifications: a new one shows as a notice (the last, with how many came with it), and what was already waiting is not announced', async () => {
      const old = { id: 'n0', app: 'WhatsApp', title: 'Antiga', body: 'já estava', time: 1 };
      deck.model.notifications = { access: 'allowed', notifications: [old] };
      const { page, close } = await open(411, 914);
      try {
        await sleep(600);
        assert.strictEqual(await page.eval(`document.getElementById('toast').classList.contains('show')`), false, 'the one that was waiting is not announced');
        deck.model.pushNotifications({ access: 'allowed', notifications: [old, { id: 'n1', app: 'WhatsApp', title: 'Ana', body: 'oi', time: 2 }] });
        await page.waitFor(`document.getElementById('toast').classList.contains('show') && document.getElementById('toast').textContent === '🔔 WhatsApp · Ana: oi'`, 'the notice');
        await sleep(300);
        deck.model.pushNotifications({ access: 'allowed', notifications: [old, { id: 'n1', app: 'WhatsApp', title: 'Ana', body: 'oi', time: 2 }, { id: 'n2', app: 'WhatsApp', title: 'Beto', body: 'x'.repeat(200), time: 3 }, { id: 'n3', app: '', title: 'Sem app', body: '', time: 4 }] });
        await page.waitFor(`/^🔔 Sem app \\(\\+1\\)$/.test(document.getElementById('toast').textContent)`, 'the last one with how many more');
      } finally { deck.model.notifications = { access: 'allowed', notifications: [] }; close(); }
    });

    await test('self-update: when the interface version changes on the PC the page reloads, once nobody is touching it', async () => {
      const { page, close } = await open(411, 914);
      try {
        await page.eval('window.__marker = 1');
        deck.model.state = { ...deck.model.state, ui: 2 };
        await page.waitFor(`window.__marker === undefined && document.querySelectorAll('.tile[data-key]').length >= 1`, 'the page reloaded', 14000);
      } finally { deck.model.state = { ...deck.model.state, ui: 1 }; close(); }
    });

    const IPHONE = `
      Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
      Object.defineProperty(navigator, 'vibrate', { value: undefined });
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.__copied.push(text); } } });
      window.__wake = { requests: 0, sentinel: null };
      Object.defineProperty(navigator, 'wakeLock', { value: { request: async () => {
        const listeners = [];
        const sentinel = { released: false, addEventListener: (_name, fn) => listeners.push(fn), fire() { sentinel.released = true; listeners.forEach((fn) => fn()); }, release: async () => undefined };
        window.__wake.requests += 1;
        window.__wake.sentinel = sentinel;
        return sentinel;
      } } });
    `;

    await test('iPhone: the menu has "Código de pareamento", which copies the code from the PC; other browsers do not have it', async () => {
      const { page: plain, close: closePlain } = await open(390, 844);
      try {
        await tapUntil(plain, '#menu', `!document.getElementById('menu-pop').hidden`, 'the menu');
        const items = await plain.eval(`[...document.querySelectorAll('#menu-pop button')].filter((b) => !b.hidden).map((b) => b.textContent.trim())`);
        assert.ok(!items.includes('Código de pareamento'), JSON.stringify(items));
      } finally { closePlain(); }
      const { page: phone, close } = await open(390, 844, IPHONE);
      try {
        await tapUntil(phone, '#menu', `!document.getElementById('menu-pop').hidden`, 'the menu');
        const items = await phone.eval(`[...document.querySelectorAll('#menu-pop button')].filter((b) => !b.hidden).map((b) => b.textContent.trim())`);
        assert.ok(items.indexOf('Código de pareamento') >= 0 && items.indexOf('Código de pareamento') < items.indexOf('Escurecer após…') && items.indexOf('Escurecer após…') < items.indexOf('Atualizar'), JSON.stringify(items));
        await phone.eval(`[...document.querySelectorAll('#menu-pop button')].find((b) => b.textContent.trim() === 'Código de pareamento').click()`);
        await phone.waitFor('window.__copied.length === 1', 'the code copied');
        assert.deepStrictEqual(await phone.eval('window.__copied'), ['codigo-de-teste']);
        assert.match(await phone.eval(`document.getElementById('toast').textContent`), /Código copiado/);
      } finally { close(); }
    });

    await test('iPhone: the screen wake lock is asked for at load and again after the system releases it', async () => {
      const { page: phone, close } = await open(390, 844, IPHONE);
      try {
        await phone.waitFor('window.__wake.requests === 1', 'the first request');
        await phone.eval('window.__wake.sentinel.fire()');
        await phone.waitFor('window.__wake.requests === 2', 'a new request after the release');
        await phone.eval('window.__wake.sentinel.fire()');
        await phone.waitFor('window.__wake.requests === 3', 'and once more');
      } finally { close(); }
    });

    await test('the page raised no script errors', async () => {
      const { page, close } = await open(411, 914);
      try {
        await tapTab(page, 'windows');
        await tapTab(page, 'sound');
        await tapTab(page, 'pc');
        await tapTab(page, 'power');
        await tapTab(page, 'apps');
        assert.deepStrictEqual(page.errors, []);
        assert.ok(posts(deck, '/api/power').length === 0);
      } finally { close(); }
    });
  } finally {
    extra.forEach((browser) => browser.close());
    deck.close();
  }
  console.log(`${passed} passed`);
  process.exit(0); // the page's open event stream would keep the fake server (and so the process) alive
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
