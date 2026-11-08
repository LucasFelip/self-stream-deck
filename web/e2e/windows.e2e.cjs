'use strict';

// The Janelas page of the new interface in a real headless browser against the fake deck server: the old interface's cases (the list
// and its 48 px buttons, the Lista | Mapa selector, the shared selection, landscape side by side, touching the map without redrawing
// it, dragging a window with a resize in the middle, the panel's buttons) plus what each control sends to the PC.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fakeDeck, launchBrowser, findBrowser, sleep } = require('../../legacy/server/test/ui/harness');
const { tapTab, tapUntil, posts, setRange } = require('./support.cjs');

const DIST = path.join(__dirname, '..', 'dist', 'index.html');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };

(async () => {
  if (!findBrowser()) { console.log('skipped (no Chrome, Brave or Edge found; set CHROME_PATH)'); return; }
  if (!fs.existsSync(DIST)) { console.log('skipped (web/dist is not built: npm run build)'); return; }

  const deck = await fakeDeck();
  const extra = [];
  const open = async (width, height) => {
    const browser = await launchBrowser({ width, height });
    extra.push(browser);
    const page = await browser.open(`${deck.url}/v2/`);
    await page.waitFor(`document.body.dataset.state === 'online'`, 'online', 9000);
    await tapTab(page, 'windows');
    return { page, close: () => browser.close() };
  };
  const visibleBox = (page, selector) => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const r = e ? e.getBoundingClientRect() : { width: 0, height: 0 }; return r.width > 0 && r.height > 0; })()`);
  const rectOf = (page, selector) => page.eval(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })()`);
  const actions = () => posts(deck, '/api/windows/action').map((c) => c.body);
  const dragTo = async (page, selector, target, steps = 8) => {
    const from = await page.center(selector);
    await page.touch('touchStart', from.x, from.y);
    for (let step = 1; step <= steps; step += 1) {
      await page.touch('touchMove', from.x + ((target.x - from.x) * step) / steps, from.y + ((target.y - from.y) * step) / steps);
      await sleep(30);
    }
    await page.touch('touchEnd', target.x, target.y);
    return from;
  };
  const withTwoScreens = async (fn) => {
    const saved = JSON.stringify(deck.model.screens);
    deck.model.screens.push({ device: 'DISPLAY2', left: 1920, top: 0, width: 1920, height: 1080, primary: false, brightness: 60 });
    try { await fn(); } finally { deck.model.screens = JSON.parse(saved); }
  };
  const windowsReady = (page) => page.waitFor(`document.querySelectorAll('.wrow').length === 3`, 'the three windows of the fake PC');

  try {
    await test('Janelas: the list shows every window with its two buttons (48 px), and tapping a row or a button sends the right action', async () => {
      const { page, close } = await open(411, 914);
      try {
        await windowsReady(page);
        const rows = await page.eval(`[...document.querySelectorAll('.wrow')].map((r) => ({ app: r.querySelector('.wtitle b').textContent, buttons: r.querySelectorAll('button').length, label: [...r.querySelectorAll('.wbtn')].map((b) => b.getAttribute('aria-label')), min: Math.min(...[...r.querySelectorAll('button')].map((b) => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height))), wbtn: Math.min(...[...r.querySelectorAll('.wbtn')].map((b) => b.getBoundingClientRect().width)) }))`);
        assert.deepStrictEqual(rows.map((r) => r.app), ['Editor', 'Navegador', 'Terminal']);
        for (const row of rows) {
          assert.strictEqual(row.buttons, 3);
          assert.ok(row.min >= 48 && row.wbtn >= 48, `targets of ${row.app}: ${JSON.stringify(row)}`);
        }
        assert.deepStrictEqual(rows.map((r) => r.label), [['Minimizar', 'Maximizar'], ['Minimizar', 'Restaurar'], ['Restaurar', 'Maximizar']]);
        assert.strictEqual(await page.eval(`document.querySelectorAll('.wrow.front').length`), 1, 'one row is the frontmost window');
        assert.strictEqual(await page.eval(`document.querySelector('.wrow.dim').dataset.handle`), '103', 'the minimized one is dimmed');

        deck.model.calls.length = 0;
        await tapUntil(page, '.wrow[data-handle="101"] .wmain', `true`, 'the tap');
        await sleep(300);
        assert.deepStrictEqual(actions(), [{ handle: 101, action: 'focus' }]);
        deck.model.calls.length = 0;
        await tapUntil(page, '.wrow[data-handle="101"] .wbtn:last-child', `true`, 'the tap');
        await sleep(300);
        assert.deepStrictEqual(actions(), [{ handle: 101, action: 'maximize' }]);
        deck.model.calls.length = 0;
        await tapUntil(page, '.wrow[data-handle="102"] .wbtn:nth-child(2)', `true`, 'the tap');
        await sleep(300);
        assert.deepStrictEqual(actions(), [{ handle: 102, action: 'minimize' }]);
      } finally { close(); }
    });

    await test('Janelas (portrait): the Lista | Mapa selector shows one pane at a time and remembers the choice', async () => {
      const { page, close } = await open(411, 914);
      try {
        await windowsReady(page);
        assert.ok(await visibleBox(page, '.wpane-list'));
        assert.ok(!(await visibleBox(page, '.wpane-map')), 'the map is hidden while the list shows');
        const seg = await page.eval(`[...document.querySelectorAll('.windows-page .seg-btn')].map((b) => ({ id: b.dataset.seg, h: Math.round(b.getBoundingClientRect().height), w: Math.round(b.getBoundingClientRect().width), on: b.getAttribute('aria-selected') }))`);
        assert.deepStrictEqual(seg.map((b) => b.id), ['list', 'map']);
        assert.ok(seg.every((b) => b.h >= 48 && b.w >= 48), JSON.stringify(seg));
        assert.deepStrictEqual(seg.map((b) => b.on), ['true', 'false']);
        await tapUntil(page, '.windows-page .seg-btn[data-seg="map"]', `document.querySelector('.windows-page').dataset.pane === 'map'`, 'the map pane');
        assert.ok(await visibleBox(page, '.wpane-map'));
        assert.ok(!(await visibleBox(page, '.wpane-list')), 'the list is hidden while the map shows');
        await page.waitFor(`document.querySelectorAll('.map .mon').length === 1 && document.querySelectorAll('.map .mwin').length === 2`, 'the screen and the two visible windows drawn');
        assert.ok(await visibleBox(page, '.map .mwin'), 'the map was drawn with a real size');
        // the choice survives leaving and coming back
        await tapTab(page, 'apps');
        await tapTab(page, 'windows');
        assert.strictEqual(await page.eval(`document.querySelector('.windows-page').dataset.pane`), 'map');
        await tapUntil(page, '.windows-page .seg-btn[data-seg="list"]', `document.querySelector('.windows-page').dataset.pane === 'list'`, 'back to the list');
      } finally { close(); }
    });

    await test('Janelas: selecting a window in the list selects it on the map and shows its actions', async () => {
      const { page, close } = await open(411, 914);
      try {
        await windowsReady(page);
        await tapUntil(page, '.wrow[data-handle="101"] .wmain', `document.querySelector('.wrow[data-handle="101"]').classList.contains('sel') && !document.querySelector('.win-panel').hidden`, 'the row selected, with the panel ready');
        await tapUntil(page, '.windows-page .seg-btn[data-seg="map"]', `document.querySelector('.windows-page').dataset.pane === 'map'`, 'the map pane');
        // the map had no size while it was hidden: it draws now, with the same window selected
        await page.waitFor(`document.querySelector('.mwin[data-handle="101"]')?.classList.contains('sel')`, 'the same window selected on the map');
        assert.ok(await visibleBox(page, '.win-panel'), 'the panel is on screen without a second tap');
        assert.match(await page.eval(`document.querySelector('.win-panel .panel-title b').textContent`), /Documento/);
        assert.match(await page.eval(`document.querySelector('.win-panel .panel-title .muted').textContent`), /Editor/);
      } finally { close(); }
    });

    await test('Janelas (landscape): the list and the map are side by side and there is no selector; the screens row sits under the map, whole', async () => {
      const { page, close } = await open(836, 387);
      try {
        await page.waitFor(`document.querySelectorAll('.wrow').length === 3 && document.querySelectorAll('.map .mwin').length === 2`, 'the list and the map');
        const boxes = await page.eval(`(() => { const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width, h: b.height }; }; return { list: r('.wpane-list'), map: r('.wpane-map'), seg: document.querySelector('.windows-page .seg').getBoundingClientRect().width }; })()`);
        assert.ok(boxes.list.w > 0 && boxes.map.w > 0 && boxes.list.r <= boxes.map.l + 1, JSON.stringify(boxes));
        assert.strictEqual(boxes.seg, 0, 'the selector is for portrait');
        await sleep(400);
        const map = await page.eval(`(() => {
          const r = (e) => e.getBoundingClientRect();
          const mon = r(document.querySelector('.map .mon'));
          const side = r(document.querySelector('.win-side'));
          const wrap = r(document.querySelector('.map-wrap'));
          const buttons = [...document.querySelectorAll('.screens-extra > *')].map((b) => ({ h: Math.round(r(b).height), w: Math.round(r(b).width), inside: r(b).right <= side.right + 1 && r(b).bottom <= innerHeight }));
          return { monW: Math.round(mon.width), monH: Math.round(mon.height), mapBottom: wrap.bottom, sideTop: side.top, sideBottom: side.bottom, buttons };
        })()`);
        assert.ok(map.monW >= 300 && map.monH >= 160, `the screen on the map is too small: ${JSON.stringify(map)}`);
        assert.ok(map.mapBottom <= map.sideTop + 1 && map.sideBottom <= 387, `the map and the Telas row overlap or run off the screen: ${JSON.stringify(map)}`);
        assert.ok(map.buttons.length === 5 && map.buttons.every((b) => b.h >= 48 && b.w >= 48 && b.inside), JSON.stringify(map));
      } finally { close(); }
    });

    // Touching a window on the map: it is selected, its panel shows, and NOTHING redraws the map. Same in both orientations.
    const mapTouch = async (page, label) => {
      await page.waitFor(`document.querySelectorAll('.map .mwin').length === 2`, `${label}: the windows on the map`);
      await sleep(400);
      const snap = () => page.eval(`(() => { const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }; return { mon: r(document.querySelector('.map .mon')), map: r(document.querySelector('.map')), wrap: r(document.querySelector('.map-wrap')), wins: document.querySelectorAll('.map .mwin').length, sel: document.querySelectorAll('.map .mwin.sel').length, panel: !document.querySelector('.win-panel').hidden }; })()`);
      const before = await snap();
      assert.strictEqual(before.sel, 0, label);
      await page.tap('.mwin[data-handle="101"]');
      await page.waitFor(`document.querySelector('.mwin[data-handle="101"]')?.classList.contains('sel')`, `${label}: the window selected`);
      await sleep(1500); // a rebuild caused by the panel replacing the Telas row would show up by now
      const after = await snap();
      assert.strictEqual(after.wins, 2, `${label}: the windows vanished from the map ${JSON.stringify(after)}`);
      assert.deepStrictEqual([after.mon, after.map, after.wrap], [before.mon, before.map, before.wrap], `${label}: selecting resized the map`);
      assert.ok(after.sel === 1 && after.panel, `${label}: ${JSON.stringify(after)}`);
      // the empty part of the map clears the selection and the windows stay
      const empty = await page.eval(`(() => { const b = document.querySelector('.map-wrap').getBoundingClientRect(); return { x: Math.round(b.left + 4), y: Math.round(b.top + 4) }; })()`);
      await page.touch('touchStart', empty.x, empty.y);
      await page.touch('touchEnd', empty.x, empty.y);
      await page.waitFor(`document.querySelectorAll('.map .mwin.sel').length === 0 && document.querySelector('.win-panel').hidden`, `${label}: the selection cleared`);
      await sleep(800);
      const cleared = await snap();
      assert.strictEqual(cleared.wins, 2, `${label}: ${JSON.stringify(cleared)}`);
      assert.deepStrictEqual([cleared.mon, cleared.map], [before.mon, before.map], `${label}: clearing resized the map`);
    };

    await test('Janelas (landscape): touching a window on the map selects it without resizing the map or emptying it; touching the empty map clears it', async () => {
      const { page, close } = await open(836, 387);
      try { await mapTouch(page, 'landscape'); } finally { close(); }
    });

    await test('Janelas (portrait): touching a window on the map selects it without resizing or emptying the map', async () => {
      const { page, close } = await open(410, 914);
      try {
        await tapUntil(page, '.windows-page .seg-btn[data-seg="map"]', `document.querySelector('.windows-page').dataset.pane === 'map'`, 'the map pane');
        await mapTouch(page, 'portrait');
      } finally { close(); }
    });

    await test('Janelas: dragging a window on the map moves it, ends the gesture and the map draws again; a resize during the drag does not strand it', async () => {
      const { page: wide, close } = await open(836, 387);
      const saved = JSON.stringify(deck.model.windows);
      try {
        await wide.waitFor(`document.querySelectorAll('.map .mwin').length === 2`, 'the windows on the map');
        await sleep(400);
        const left = () => wide.eval(`document.querySelector('.mwin[data-handle="101"]').style.left`);
        const startLeft = await left();
        const from = await wide.center('.mwin[data-handle="101"]');
        const monBox = await wide.eval(`(() => { const b = document.querySelector('.map .mon').getBoundingClientRect(); return { x: b.left + b.width * 0.5, y: b.top + b.height * 0.5 }; })()`);
        deck.model.calls.length = 0;
        await wide.touch('touchStart', from.x, from.y);
        for (let step = 1; step <= 8; step += 1) {
          await wide.touch('touchMove', from.x + ((monBox.x - from.x) * step) / 8, from.y + ((monBox.y + 20 - from.y) * step) / 8);
          await sleep(30);
        }
        assert.ok(await wide.eval(`document.querySelector('.mwin[data-handle="101"]').classList.contains('dragging')`), 'the window follows the finger');
        // the page is resized in the middle of the drag: the window under the finger must survive
        await wide.setViewport(826, 387);
        await sleep(400);
        const endBox = await wide.eval(`(() => { const b = document.querySelector('.map .mon').getBoundingClientRect(); return { x: b.left + b.width * 0.5, y: b.top + b.height * 0.5 }; })()`);
        await wide.touch('touchMove', endBox.x, endBox.y + 20);
        await wide.touch('touchEnd', endBox.x, endBox.y + 20);
        await wide.waitFor(`!document.querySelector('.mwin.dragging')`, 'the drag to end');
        await sleep(300);
        const placed = posts(deck, '/api/windows/place').map((c) => c.body);
        assert.ok(placed.some((body) => body.handle === 101), `the move was sent: ${JSON.stringify(deck.model.calls.map((c) => c.path))}`);
        assert.ok(Number.isInteger(placed[0].x) && Number.isInteger(placed[0].y), JSON.stringify(placed));
        assert.strictEqual(await wide.eval(`document.querySelectorAll('.map .mwin').length`), 2, 'the windows are still on the map');
        // drawing is not blocked: a change on the PC shows on the map
        deck.model.windows[0] = { ...deck.model.windows[0], x: 900, y: 300 };
        await wide.waitFor(`document.querySelector('.mwin[data-handle="101"]').style.left !== ${JSON.stringify(await left())}`, 'the map following the PC after the drag');
        assert.notStrictEqual(await left(), startLeft);
      } finally {
        deck.model.windows = JSON.parse(saved);
        close();
      }
    });

    await test('Janelas: dragging a window to a screen edge snaps it, to the top maximizes it, and a plain tap on it only selects and focuses', async () => {
      const { page, close } = await open(836, 387);
      try {
        await page.waitFor(`document.querySelectorAll('.map .mwin').length === 2`, 'the windows on the map');
        await sleep(400);
        const mon = await page.eval(`(() => { const b = document.querySelector('.map .mon').getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; })()`);
        deck.model.calls.length = 0;
        await dragTo(page, '.mwin[data-handle="101"]', { x: mon.l + mon.w * 0.05, y: mon.t + mon.h * 0.5 });
        await page.waitFor(`document.querySelector('.hint').style.display === 'none'`, 'the drop zone hint gone');
        await sleep(300);
        assert.deepStrictEqual(posts(deck, '/api/windows/snap').map((c) => c.body), [{ handle: 101, monitor: 0, zone: 'left' }]);
        deck.model.calls.length = 0;
        await dragTo(page, '.mwin[data-handle="101"]', { x: mon.l + mon.w * 0.5, y: mon.t + mon.h * 0.04 });
        await sleep(300);
        assert.deepStrictEqual(posts(deck, '/api/windows/snap').map((c) => c.body), [{ handle: 101, monitor: 0, zone: 'full' }]);
        deck.model.calls.length = 0;
        await page.tap('.mwin[data-handle="101"]'); // maximized by the drop above, so it covers the other one
        await sleep(300);
        assert.deepStrictEqual(actions(), [{ handle: 101, action: 'focus' }]);
        assert.strictEqual(posts(deck, '/api/windows/place').length, 0);
      } finally { close(); }
    });

    await test('Janelas: the panel sends maximize, snap and close (two taps), and the screens card sends its commands', async () => {
      const { page, close } = await open(836, 387);
      try {
        await page.waitFor(`document.querySelectorAll('.map .mwin').length === 2`, 'the windows on the map');
        await tapUntil(page, '.mwin[data-handle="101"]', `!document.querySelector('.win-panel').hidden`, 'the panel');
        deck.model.calls.length = 0;
        await tapUntil(page, '.win-panel .bigbtn[aria-label="Maximizar"]', `true`, 'the tap');
        await sleep(300);
        assert.deepStrictEqual(actions(), [{ handle: 101, action: 'maximize' }]);
        deck.model.calls.length = 0;
        await tapUntil(page, '.win-panel .bigbtn[aria-label="Esquerda"]', `true`, 'the tap');
        await sleep(300);
        assert.deepStrictEqual(posts(deck, '/api/windows/snap').map((c) => c.body), [{ handle: 101, monitor: 0, zone: 'left' }]);
        // Fechar needs a second tap, and the arming times out
        deck.model.calls.length = 0;
        await page.tap('.win-panel .bigbtn.danger');
        await page.waitFor(`document.querySelector('.win-panel .bigbtn.danger').dataset.armed === 'true' && /Toque de novo/.test(document.querySelector('.win-panel .bigbtn.danger').textContent)`, 'the close button armed');
        assert.strictEqual(actions().filter((a) => a.action === 'close').length, 0, 'one tap does not close');
        await page.waitFor(`!document.querySelector('.win-panel .bigbtn.danger').dataset.armed`, 'the arming wearing off', 5000);
        await page.tap('.win-panel .bigbtn.danger');
        await page.waitFor(`document.querySelector('.win-panel .bigbtn.danger').dataset.armed === 'true'`, 'armed again');
        await page.tap('.win-panel .bigbtn.danger');
        await sleep(300);
        assert.deepStrictEqual(actions().filter((a) => a.action === 'close'), [{ handle: 101, action: 'close' }]);
        // without a selection the same spot shows the screens card
        const empty = await page.eval(`(() => { const b = document.querySelector('.map-wrap').getBoundingClientRect(); return { x: Math.round(b.left + 4), y: Math.round(b.top + 4) }; })()`);
        await page.touch('touchStart', empty.x, empty.y);
        await page.touch('touchEnd', empty.x, empty.y);
        await page.waitFor(`document.querySelector('.win-panel').hidden`, 'the panel gone');
        deck.model.calls.length = 0;
        await tapUntil(page, '.screens-extra .chip:nth-child(2)', `true`, 'the tap');
        await tapUntil(page, '.screens-extra .chip:nth-child(3)', `true`, 'the tap');
        await tapUntil(page, '.screens-extra .chip:nth-child(1)', `true`, 'the tap');
        await sleep(400);
        assert.deepStrictEqual(posts(deck, '/api/screens/project').map((c) => c.body), [{ mode: 'extend', confirm: false }, { mode: 'clone', confirm: false }]);
        assert.strictEqual(posts(deck, '/api/screens/off').length, 1);
        // a single-screen mode needs the finger held
        deck.model.calls.length = 0;
        await page.tap('.screens-extra .hold');
        await sleep(300);
        assert.strictEqual(posts(deck, '/api/screens/project').length, 0, 'a tap does not switch to one screen');
        const hold = await page.center('.screens-extra .hold');
        await page.touch('touchStart', hold.x, hold.y);
        await sleep(1400);
        await page.touch('touchEnd', hold.x, hold.y);
        await sleep(400);
        assert.deepStrictEqual(posts(deck, '/api/screens/project').map((c) => c.body), [{ mode: 'first', confirm: true }]);
        // the brightness slider under the screen sends its device
        deck.model.calls.length = 0;
        await setRange(page, '.mon-bright .range', 35);
        await sleep(400);
        assert.deepStrictEqual(posts(deck, '/api/screens/brightness').map((c) => c.body).at(-1), { device: 'DISPLAY1', level: 35 });
        assert.strictEqual(await page.eval(`document.querySelector('.mon-bright .value').textContent`), '35%');
      } finally { close(); }
    });

    await test('Janelas (landscape): the selected window panel has buttons of at least 48 px (six with two screens) and the map keeps its size', async () => {
      await withTwoScreens(async () => {
        const { page: wide, close } = await open(836, 387);
        try {
          await wide.waitFor(`document.querySelectorAll('.map .mwin').length === 2`, 'the windows on the map');
          await sleep(400);
          const before = await rectOf(wide, '.map');
          const row = await rectOf(wide, '.wpane-map > .win-side');
          await wide.tap('.mwin[data-handle="101"]');
          await wide.waitFor(`!document.querySelector('.win-panel').hidden`, 'the panel');
          await sleep(500);
          const sizes = await wide.eval(`[...document.querySelectorAll('.win-panel .bigbtn')].map((b) => ({ n: b.getAttribute('aria-label'), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) }))`);
          assert.deepStrictEqual(sizes.map((b) => b.n), ['Minimizar', 'Maximizar', 'Esquerda', 'Direita', 'Outra tela', 'Fechar']);
          assert.ok(sizes.length === 6 && sizes.every((b) => b.w >= 48 && b.h >= 48), JSON.stringify(sizes));
          assert.deepStrictEqual(await rectOf(wide, '.map'), before, 'selecting resized the map');
          assert.strictEqual((await rectOf(wide, '.wpane-map > .win-side'))[3], row[3], 'the bottom row changed height');
          deck.model.calls.length = 0;
          await tapUntil(wide, '.win-panel .bigbtn[aria-label="Outra tela"]', `true`, 'the tap');
          await sleep(300);
          assert.deepStrictEqual(posts(deck, '/api/windows/move').map((c) => c.body), [{ handle: 101, monitor: 1 }]);
        } finally { close(); }
      });
    });

    await test('Janelas: leaving the page drops the windows subscription, and coming back subscribes again', async () => {
      const topicsNow = () => {
        const opened = deck.model.calls.filter((c) => c.path === '/api/events');
        return opened.length ? opened[opened.length - 1].topics.split(',') : null;
      };
      const { page, close } = await open(411, 914);
      try {
        await sleep(500);
        assert.ok(topicsNow().includes('windows'), `subscribed while on the page: ${topicsNow()}`);
        deck.model.calls.length = 0;
        await tapTab(page, 'apps');
        await sleep(500);
        const away = topicsNow();
        assert.ok(away, 'leaving did not change the subscription');
        assert.ok(!away.includes('windows'), `still subscribed to windows: ${away}`);
        await tapTab(page, 'windows');
        await sleep(500);
        assert.ok(topicsNow().includes('windows'), 'coming back subscribes again');
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
