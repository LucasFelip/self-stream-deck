'use strict';

// The Apps and Atalhos pages of the new interface in a real headless browser against the fake deck server: the old interface's cases
// (every app on one page without scrolling in six viewports, the fall back to scrolling, the grid shared by Atalhos, hold-and-drag
// to swap, the pager's axis per orientation) plus macros, the paginated Atalhos with its page dots, the empty states and the dots of running apps.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fakeDeck, launchBrowser, findBrowser, sleep } = require('../../legacy/server/test/ui/harness');
const { tapTab, tapUntil, posts } = require('./support.cjs');

const DIST = path.join(__dirname, '..', 'dist', 'index.html');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };

(async () => {
  if (!findBrowser()) { console.log('skipped (no Chrome, Brave or Edge found; set CHROME_PATH)'); return; }
  if (!fs.existsSync(DIST)) { console.log('skipped (web/dist is not built: npm run build)'); return; }

  const deck = await fakeDeck();
  const extra = [];
  const open = async (width, height, ready = `document.querySelectorAll('.tile[data-key]').length >= 1`) => {
    const browser = await launchBrowser({ width, height });
    extra.push(browser);
    const page = await browser.open(`${deck.url}/v2/`);
    await page.waitFor(ready, 'the keys');
    await page.waitFor(`document.body.dataset.state === 'online'`, 'online', 9000);
    await sleep(400);
    return { page, close: () => browser.close() };
  };
  const DEFAULT_APPS = ['Navegador', 'Terminal', 'Editor', 'Chat', 'Música', 'Jogos'].map((name, i) => ({ id: `app${i}`, name, hasIcon: false, iconVersion: '' }));
  const setApps = (count) => { deck.model.apps = Array.from({ length: count }, (_, i) => ({ id: `big${i}`, name: `Aplicativo numero ${i}`, hasIcon: false, iconVersion: '' })); };
  const resetApps = () => { deck.model.apps = DEFAULT_APPS; };
  const SHORTCUTS = deck.model.shortcuts;

  try {
    await test('Apps: one key per app with its name, the dot of a running app, and a tap launches it and says so', async () => {
      const { page, close } = await open(411, 914);
      try {
        const names = await page.eval(`[...document.querySelectorAll('.tile[data-key^="a:"]')].map((t) => t.textContent.trim())`);
        for (const name of ['Navegador', 'Terminal', 'Editor', 'Chat', 'Música', 'Jogos']) assert.ok(names.some((n) => n.includes(name)), name);
        assert.ok(await page.eval(`document.querySelector('.tile[data-app-id="app0"]').classList.contains('running')`), 'a running app shows its dot');
        assert.ok(!(await page.eval(`document.querySelector('.tile[data-app-id="app1"]').classList.contains('running')`)));
        assert.strictEqual(await page.eval(`document.querySelector('.tile[data-app-id="app1"]').getAttribute('aria-label')`), 'Terminal');
        assert.strictEqual(await page.eval(`document.querySelector('.tile[data-app-id="app1"] .fallback').textContent`), 'T', 'an app without icon shows its initial');
        assert.strictEqual(await page.eval(`Boolean(document.getElementById('power-pill') || document.getElementById('cam') || document.getElementById('live-strip') || document.getElementById('mic'))`), false);
        deck.model.calls.length = 0;
        await tapUntil(page, '.tile[data-key="a:app1"]', `document.getElementById('toast').classList.contains('show')`, 'the notice');
        assert.ok(posts(deck, '/api/launch/app1').length >= 1);
        assert.match(await page.eval(`document.getElementById('toast').textContent`), /Abrindo Terminal/);
      } finally { close(); }
    });

    await test('Apps: a window that is open but whose app is not running shows the open mark', async () => {
      deck.model.state = { ...deck.model.state, running: [], open: ['app2'] };
      const { page, close } = await open(411, 914);
      try {
        assert.deepStrictEqual(await page.eval(`[...document.querySelectorAll('.tile.open')].map((t) => t.dataset.appId)`), ['app2']);
        assert.strictEqual(await page.eval(`document.querySelectorAll('.tile.running').length`), 0);
      } finally { deck.model.state = { ...deck.model.state, running: ['app0'], open: [] }; close(); }
    });

    await test('Atalhos: a tap sends the shortcut, and the first page uses the whole grid, the same one as Apps', async () => {
      const { page, close } = await open(411, 914);
      try {
        await tapTab(page, 'shortcuts');
        deck.model.calls.length = 0;
        await tapUntil(page, '.tile[data-key="s:copy"]', `true`, 'the tap');
        await sleep(300);
        assert.ok(posts(deck, '/api/shortcut/copy').length >= 1);
        assert.strictEqual(await page.eval(`document.querySelector('.tile[data-key="s:copy"] .keycap').textContent.replace(/\\u200b/g, '')`), 'Ctrl+C');
        const info = await page.eval(`(() => {
          const page = document.querySelector('.page[data-id="shortcuts-0"]');
          const grid = page.querySelector('.grid');
          const apps = document.querySelector('.page[data-id="apps-0"] .grid');
          const g = grid.getBoundingClientRect();
          const p = page.getBoundingClientRect();
          const cells = [...grid.children];
          const rows = new Set(cells.map((c) => Math.round(c.getBoundingClientRect().top))).size;
          return { split: page.querySelectorAll('.split, .wlist').length, volume: Boolean(page.querySelector('#volume, #vol, .volume-bar')), cols: grid.style.getPropertyValue('--cols'), rows: grid.style.getPropertyValue('--rows'), appsCols: apps.style.getPropertyValue('--cols'), appsRows: apps.style.getPropertyValue('--rows'), cells: cells.length, visibleRows: rows, right: Math.round(p.right - g.right), left: Math.round(g.left - p.left) };
        })()`);
        assert.strictEqual(info.split, 0);
        assert.strictEqual(info.volume, false, 'the volume strip is gone from the shortcuts page');
        assert.strictEqual(info.cols, info.appsCols, 'the same number of columns as Apps');
        assert.strictEqual(info.rows, info.appsRows, 'the same number of rows as Apps: the last row is keys, not the volume bar');
        assert.strictEqual(info.cells, Number(info.cols) * Number(info.rows), 'tiles and slots fill the whole grid');
        assert.strictEqual(info.visibleRows, Number(info.rows), JSON.stringify(info));
        assert.ok(info.right <= 20 && info.left <= 20, `the grid fills the page: ${JSON.stringify(info)}`);
      } finally { close(); }
    });

    await test('holding a key and dragging it onto another swaps them, saves the order, and never launches the app', async () => {
      const { page, close } = await open(411, 914);
      try {
        deck.model.calls.length = 0;
        await page.holdAndDrag('.tile[data-key="a:app0"]', '.tile[data-key="a:app3"]');
        await sleep(600);
        const save = posts(deck, '/api/layout')[0];
        assert.ok(save, 'POST /api/layout was not called');
        assert.strictEqual(save.body.page, 'apps');
        assert.deepStrictEqual(save.body.order.slice(0, 4), ['a:app3', 'a:app1', 'a:app2', 'a:app0']);
        assert.ok(!deck.model.calls.some((c) => c.path.startsWith('/api/launch')), 'the drag launched an app');
        const order = await page.eval(`[...document.querySelectorAll('.page[data-section="apps"] .tile[data-key]')].map((t) => t.dataset.key)`);
        assert.deepStrictEqual(order.slice(0, 4), ['a:app3', 'a:app1', 'a:app2', 'a:app0'], 'the keys follow the new order');
        assert.strictEqual(await page.eval(`document.querySelectorAll('.tile.lifting, .tile.drop-target, .slot.drop-target').length`), 0, 'nothing stays marked');
        assert.strictEqual(await page.eval(`document.getElementById('pager').classList.contains('arranging')`), false);
      } finally {
        deck.model.layout = { apps: [], shortcuts: [] };
        close();
      }
    });

    await test('holding a key without moving does nothing, and dropping on an empty slot sends the key to the end', async () => {
      const { page, close } = await open(411, 914);
      try {
        deck.model.calls.length = 0;
        const c = await page.center('.tile[data-key="a:app2"]');
        await page.touch('touchStart', c.x, c.y);
        await sleep(800);
        await page.touch('touchEnd', c.x, c.y);
        await sleep(500);
        assert.strictEqual(posts(deck, '/api/layout').length, 0, 'a hold without a move saved something');
        assert.ok(!deck.model.calls.some((x) => x.path.startsWith('/api/launch')), 'the end of a lift counted as a tap');
        await page.holdAndDrag('.tile[data-key="a:app1"]', '.slot');
        await sleep(600);
        const save = posts(deck, '/api/layout')[0];
        assert.ok(save, 'POST /api/layout was not called');
        assert.deepStrictEqual(save.body.order, ['a:app0', 'a:app2', 'a:app3', 'a:app4', 'a:app5', 'c:camera', 'a:app1']);
      } finally {
        deck.model.layout = { apps: [], shortcuts: [] };
        close();
      }
    });

    await test('a saved order is how the keys come back, and keys that are not in it follow after', async () => {
      deck.model.layout = { apps: ['a:app5', 'a:app0'], shortcuts: [] };
      const { page, close } = await open(411, 914);
      try {
        const order = await page.eval(`[...document.querySelectorAll('.page[data-section="apps"] .tile[data-key]')].map((t) => t.dataset.key)`);
        assert.deepStrictEqual(order, ['a:app5', 'a:app0', 'a:app1', 'a:app2', 'a:app3', 'a:app4', 'c:camera']);
      } finally { deck.model.layout = { apps: [], shortcuts: [] }; close(); }
    });

    await test('macros are keys: on Atalhos by default, on Apps when placed there; a tap runs them and says so', async () => {
      deck.model.macros = [{ id: 'foco', label: 'Foco', page: 'shortcuts', steps: 2 }, { id: 'jogo', label: 'Modo jogo', page: 'apps', steps: 1 }];
      const { page, close } = await open(411, 914);
      try {
        assert.strictEqual(await page.eval(`document.querySelector('.page[data-section="apps"] .tile[data-key="m:jogo"] small').textContent`), '1 passo');
        deck.model.calls.length = 0;
        await tapUntil(page, '.tile[data-key="m:jogo"]', `document.getElementById('toast').classList.contains('show') && /Modo jogo ✓/.test(document.getElementById('toast').textContent)`, 'the macro notice');
        assert.ok(posts(deck, '/api/macro/jogo').length >= 1);
        await tapTab(page, 'shortcuts');
        assert.strictEqual(await page.eval(`document.querySelector('.page[data-section="shortcuts"] .tile[data-key="m:foco"] small').textContent`), '2 passos');
        assert.deepStrictEqual(await page.eval(`[...document.querySelectorAll('.page[data-section="shortcuts"] .tile[data-key]')].map((t) => t.dataset.key)`), ['s:copy', 's:paste', 'm:foco']);
      } finally { deck.model.macros = []; close(); }
    });

    await test('empty pages: Atalhos says so; Apps always has the camera key, so it is never empty', async () => {
      deck.model.apps = [];
      deck.model.shortcuts = [];
      const { page, close } = await open(411, 914, `document.querySelector('.page[data-section="shortcuts"] .empty')`);
      try {
        assert.strictEqual(await page.eval(`document.querySelector('.page[data-section="shortcuts"] .empty').textContent`), 'Nenhum atalho configurado.');
        assert.deepStrictEqual(await page.eval(`[...document.querySelectorAll('.page[data-section="apps"] .tile[data-key]')].map((t) => t.dataset.key)`), ['c:camera']);
        assert.strictEqual(await page.eval(`document.querySelectorAll('#pager > .page').length`), 6);
      } finally { resetApps(); deck.model.shortcuts = SHORTCUTS; close(); }
    });

    await test('a new taskbar list on the PC (appsRev changed) is read again by itself', async () => {
      const { page, close } = await open(411, 914);
      try {
        deck.model.apps = [...DEFAULT_APPS, { id: 'app6', name: 'Novo app', hasIcon: false, iconVersion: '' }];
        deck.model.state = { ...deck.model.state, appsRev: 2 };
        await page.waitFor(`document.querySelector('.tile[data-key="a:app6"]')`, 'the new app on the page', 9000);
      } finally { resetApps(); deck.model.state = { ...deck.model.state, appsRev: 1 }; close(); }
    });

    for (const count of [24, 30]) {
      for (const [width, height] of [[836, 387], [740, 360], [411, 914], [360, 740], [844, 390], [390, 844]]) {
        await test(`Apps: ${count} apps ${width}x${height} are ALL on one page without scrolling, keys at least 44x60 with the icon and a one-line name`, async () => {
          setApps(count);
          const { page: big, close } = await open(width, height, `document.querySelectorAll('.tile[data-key^="a:big"]').length === ${count}`);
          try {
            const info = await big.eval(`(() => {
              const pages = [...document.querySelectorAll('.page[data-section="apps"]')];
              const page = pages[0];
              const p = page.getBoundingClientRect();
              const tiles = [...page.querySelectorAll('.tile[data-key]')].map((t) => t.getBoundingClientRect());
              const label = page.querySelector('.tile span');
              const icon = page.querySelector('.tile .fallback').getBoundingClientRect();
              return { count: pages.length, id: page.dataset.id, fits: page.scrollHeight <= page.clientHeight + 1, inside: tiles.every((r) => r.left >= p.left - 1 && r.right <= p.right + 1 && r.top >= p.top - 1 && r.bottom <= p.bottom + 1), minW: Math.round(Math.min(...tiles.map((r) => r.width))), minH: Math.round(Math.min(...tiles.map((r) => r.height))), icon: Math.round(icon.width), labelH: Math.round(label.getBoundingClientRect().height), labelFont: parseFloat(getComputedStyle(label).fontSize), cols: getComputedStyle(page.querySelector('.grid')).gridTemplateColumns.split(' ').length, dots: document.getElementById('page-dots').hidden };
            })()`);
            console.log(`       ${count} apps ${width}x${height}: key ${info.minW}x${info.minH}, icon ${info.icon}, ${info.cols} columns`);
            assert.strictEqual(info.count, 1);
            assert.strictEqual(info.id, 'apps-0');
            assert.strictEqual(info.fits, true, JSON.stringify(info));
            assert.strictEqual(info.inside, true, JSON.stringify(info));
            assert.ok(info.minW >= 36 && info.minH >= 60 && info.icon >= 24 && info.labelFont >= 10, JSON.stringify(info));
            assert.strictEqual(info.dots, true, 'a section with one page shows no page dots');
            // the last app can be tapped without scrolling
            deck.model.calls.length = 0;
            await big.tap(`.tile[data-key="a:big${count - 1}"]`);
            await sleep(300);
            assert.ok(posts(deck, `/api/launch/big${count - 1}`).length >= 1, 'the last key launches');
          } finally {
            resetApps();
            close();
          }
        });
      }
    }

    await test('Apps: 150 apps are too many to read on one screen, so the page falls back to vertical scrolling (keys keep their size); Back and tabs behave', async () => {
      setApps(150);
      const { page: big, close } = await open(412, 915, `document.querySelectorAll('.tile[data-key^="a:big"]').length === 150`);
      try {
        const info = await big.eval(`(() => { const page = document.querySelector('.page[data-section="apps"]'); const r = document.querySelector('.tile[data-key="a:big0"]').getBoundingClientRect(); return { overflowY: getComputedStyle(page).overflowY, scrolls: page.scrollHeight > page.clientHeight + 1, w: Math.round(r.width), h: Math.round(r.height), pages: document.querySelectorAll('.page[data-section="apps"]').length }; })()`);
        assert.deepStrictEqual({ overflowY: info.overflowY, scrolls: info.scrolls, pages: info.pages }, { overflowY: 'auto', scrolls: true, pages: 1 });
        assert.ok(info.w >= 40 && info.h >= 48, JSON.stringify(info));
        await tapTab(big, 'power');
        assert.strictEqual(await big.eval('Deck.back()'), true);
        await big.waitFor(`document.querySelector('#tabs .tab[aria-selected="true"]').dataset.section === 'apps'`, 'Apps after Back');
        assert.strictEqual(await big.eval('Deck.back()'), false);
      } finally { resetApps(); close(); }
    });

    await test('Atalhos: with more keys than a page holds it paginates, the dots show where you are, and the tab returns to where you were', async () => {
      deck.model.shortcuts = Array.from({ length: 60 }, (_, i) => ({ id: `sc${i}`, label: `Atalho ${i}`, keys: 'ctrl+c', display: 'Ctrl+C' }));
      const { page, close } = await open(411, 914);
      try {
        await tapTab(page, 'shortcuts');
        const info = await page.eval(`(() => ({ pages: [...document.querySelectorAll('.page[data-section="shortcuts"]')].map((p) => [p.dataset.id, p.dataset.part, p.querySelectorAll('.tile').length]), dots: document.getElementById('page-dots').hidden, dotCount: document.querySelectorAll('#page-dots i').length, on: [...document.querySelectorAll('#page-dots i')].findIndex((i) => i.classList.contains('on')) }))()`);
        assert.ok(info.pages.length >= 3, JSON.stringify(info));
        assert.deepStrictEqual(info.pages.map((p) => p[0]), info.pages.map((_, i) => `shortcuts-${i}`));
        assert.deepStrictEqual(info.pages.map((p) => p[1]), info.pages.map((_, i) => `${i + 1}/${info.pages.length}`));
        assert.strictEqual(info.pages.reduce((sum, p) => sum + p[2], 0), 60, 'every shortcut is on some page');
        assert.strictEqual(info.dots, false);
        assert.strictEqual(info.dotCount, info.pages.length);
        assert.strictEqual(info.on, 0);
        // swipe to the next page: the dot follows
        await page.eval(`document.getElementById('pager').scrollTo({ left: document.getElementById('pager').clientWidth * 2, behavior: 'instant' })`);
        await page.waitFor(`[...document.querySelectorAll('#page-dots i')].findIndex((i) => i.classList.contains('on')) === 1`, 'the dot on the second page');
        // another section and back: the page you left; the tab of the section you are in: its first page
        await tapTab(page, 'apps');
        assert.strictEqual(await page.eval(`document.getElementById('page-dots').hidden`), true, 'Apps has one page: no dots');
        await tapTab(page, 'shortcuts');
        await page.waitFor(`[...document.querySelectorAll('#page-dots i')].findIndex((i) => i.classList.contains('on')) === 1`, 'back on the page that was open');
        await page.tap('#tabs .tab[data-section="shortcuts"]');
        await page.waitFor(`[...document.querySelectorAll('#page-dots i')].findIndex((i) => i.classList.contains('on')) === 0`, 'the section tab returns to its first page');
      } finally { deck.model.shortcuts = SHORTCUTS; close(); }
    });

    await test('landscape pages are stacked and swipe up / down in the rail order; portrait stays sideways; rotating keeps the page', async () => {
      const { page: wide, close } = await open(836, 387, `document.querySelectorAll('#tabs .tab').length === 6 && document.querySelectorAll('.tile[data-key]').length >= 6`);
      try {
        const axes = () => wide.eval(`(() => { const p = document.getElementById('pager'); const cs = getComputedStyle(p); return { snap: cs.scrollSnapType, top: Math.round(p.scrollTop), left: Math.round(p.scrollLeft), section: document.querySelector('#tabs .tab[aria-selected="true"]').dataset.section, dots: getComputedStyle(document.getElementById('page-dots')).flexDirection }; })()`);
        let now = await axes();
        assert.match(now.snap, /^y /);
        assert.deepStrictEqual({ top: now.top, left: now.left, section: now.section }, { top: 0, left: 0, section: 'apps' });
        // the pages sit one under the other in the order of the rail, top to bottom
        const order = await wide.eval(`(() => { const tabs = [...document.querySelectorAll('#tabs .tab')].map((t) => t.dataset.section); const tops = tabs.map((id) => document.querySelector('.page[data-section="' + id + '"]').offsetTop); return { tabs, sorted: tops.every((v, i) => i === 0 || v > tops[i - 1]), x: [...document.querySelectorAll('.page')].every((p) => p.offsetLeft === 0) }; })()`);
        assert.deepStrictEqual(order.tabs, ['apps', 'shortcuts', 'windows', 'sound', 'pc', 'power']);
        assert.strictEqual(order.sorted && order.x, true);
        // a tab moves on Y only
        await tapTab(wide, 'sound');
        await sleep(600);
        now = await axes();
        assert.ok(now.top > 0 && now.left === 0, JSON.stringify(now));
        // a real swipe up on Apps goes to the next page in the rail order (Atalhos)
        await tapTab(wide, 'apps');
        await sleep(700);
        const from = await wide.eval(`(() => { const r = document.getElementById('pager').getBoundingClientRect(); return { x: r.left + 6, y: r.top + r.height * 0.85 }; })()`);
        await wide.touch('touchStart', from.x, from.y);
        for (let step = 1; step <= 10; step += 1) {
          await wide.touch('touchMove', from.x, from.y - step * 25);
          await sleep(25);
        }
        await wide.touch('touchEnd', from.x, from.y - 250);
        await wide.waitFor(`document.querySelector('#tabs .tab[aria-selected="true"]').dataset.section === 'shortcuts'`, 'the swipe to Atalhos', 4000);
        assert.strictEqual((await axes()).left, 0);
        // rotating keeps the page: portrait goes sideways on the same page
        await wide.setViewport(411, 914);
        await sleep(900);
        now = await axes();
        assert.match(now.snap, /^x /);
        assert.deepStrictEqual({ top: now.top, section: now.section }, { top: 0, section: 'shortcuts' });
        assert.ok(now.left > 0, JSON.stringify(now));
        await wide.setViewport(740, 360);
        await sleep(900);
        now = await axes();
        assert.match(now.snap, /^y /);
        assert.deepStrictEqual({ left: now.left, section: now.section }, { left: 0, section: 'shortcuts' });
        assert.ok(now.top > 0, JSON.stringify(now));
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
