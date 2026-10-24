'use strict';

// The interface in a real (headless) browser against a fake deck server: tabs, the Apps grid, hold-and-drag reordering,
// the connection indicator. Skipped, not failed, when no Chromium-based browser is installed (set CHROME_PATH to point at one).
const assert = require('node:assert');
const { fakeDeck, launchBrowser, findBrowser, sleep } = require('./harness');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };

(async () => {
  if (!findBrowser()) {
    console.log('skipped (no Chrome, Brave or Edge found; set CHROME_PATH)');
    return;
  }
  const deck = await fakeDeck();
  const browser = await launchBrowser();
  // a second browser at a given size (the first one is a portrait phone)
  const extra = [];
  const browser2 = async (width, height) => {
    const other = await launchBrowser({ width, height });
    extra.push(other);
    return other.open(`${deck.url}/`);
  };
  try {
    const page = await browser.open(`${deck.url}/`);
    await page.waitFor(`document.querySelectorAll('.tile[data-key]').length >= 6`, 'the apps grid');

    await test('the Apps page shows one key per app, with its name', async () => {
      const names = await page.eval(`[...document.querySelectorAll('.tile[data-key^="a:"]')].map((t) => t.textContent.trim())`);
      for (const name of ['Navegador', 'Terminal', 'Editor', 'Chat', 'Música', 'Jogos']) assert.ok(names.some((n) => n.includes(name)), name);
    });

    await test('the tabs are there, one is selected, and the PC name shows in the page', async () => {
      const tabs = await page.eval(`[...document.querySelectorAll('#tabs .tab')].map((t) => t.dataset.section)`);
      assert.deepStrictEqual(tabs, ['apps', 'shortcuts', 'windows', 'sound', 'pc', 'power']);
      assert.strictEqual(await page.eval(`document.querySelectorAll('#tabs .tab[aria-selected="true"]').length`), 1);
      assert.strictEqual(await page.eval(`document.getElementById('host').textContent`), 'PC-TESTE');
    });

    await test('the tabs are plain: the section name only, no page counter and no dots inside them, and the strip lives outside the navigation', async () => {
      const labels = await page.eval(`[...document.querySelectorAll('#tabs .tab')].map((t) => t.textContent.trim())`);
      assert.deepStrictEqual(labels, ['Apps', 'Atalhos', 'Janelas', 'Som', 'PC', 'Energia']);
      assert.strictEqual(await page.eval(`document.querySelectorAll('.tab-dots').length`), 0);
      assert.strictEqual(await page.eval(`document.querySelectorAll('#tabs[role="tablist"] > .tab[role="tab"]').length`), 6);
      assert.strictEqual(await page.eval(`document.querySelector('nav.nav').contains(document.getElementById('menu')) && !document.querySelector('nav.nav').contains(document.getElementById('mic'))`), true);
      // only in the menu (which sits in the navigation but stays closed)
      assert.ok(!/PC-TESTE/.test(await page.eval(`[...document.querySelector('nav.nav').children].filter((el) => !el.contains(document.getElementById('menu-pop'))).map((el) => el.textContent).join('')`)), 'the PC name is not in the navigation');
    });

    await test('tapping a tab opens that section and selects it', async () => {
      await page.tap('#tabs .tab[data-section="shortcuts"]');
      await page.waitFor(`document.querySelector('#tabs .tab[data-section="shortcuts"]').getAttribute('aria-selected') === 'true'`, 'shortcuts tab selected');
      await page.waitFor(`[...document.querySelectorAll('.tile')].some((t) => t.textContent.includes('Copiar') && t.getBoundingClientRect().left >= 0 && t.getBoundingClientRect().right <= innerWidth + 1)`, 'the shortcuts page in view');
    });

    await test('tapping a shortcut sends it to the PC', async () => {
      deck.model.calls.length = 0;
      await page.tap('.tile[data-key="s:copy"]');
      await page.waitFor(`true`);
      await sleep(300);
      assert.ok(deck.model.calls.some((c) => c.method === 'POST' && c.path === '/api/shortcut/copy'), JSON.stringify(deck.model.calls));
    });

    await test('holding a key and dragging it onto another swaps them and saves the order', async () => {
      await page.tap('#tabs .tab[data-section="apps"]');
      await page.waitFor(`document.querySelector('.tile[data-key="a:app0"]').getBoundingClientRect().left >= 0`, 'the apps page in view');
      deck.model.calls.length = 0;
      await page.holdAndDrag('.tile[data-key="a:app0"]', '.tile[data-key="a:app3"]');
      await page.waitFor(`true`);
      await sleep(500);
      const save = deck.model.calls.find((c) => c.path === '/api/layout' && c.method === 'POST');
      assert.ok(save, 'POST /api/layout was not called');
      assert.strictEqual(save.body.page, 'apps');
      assert.ok(save.body.order.indexOf('a:app3') < save.body.order.indexOf('a:app0') || save.body.order.indexOf('a:app0') === 3, JSON.stringify(save.body.order));
      assert.ok(!deck.model.calls.some((c) => c.path.startsWith('/api/launch')), 'the drag launched an app');
    });

    await test('a plain tap on an app launches it', async () => {
      deck.model.calls.length = 0;
      await page.tap('.tile[data-key="a:app1"]');
      await sleep(300);
      assert.ok(deck.model.calls.some((c) => c.path === '/api/launch/app1'), JSON.stringify(deck.model.calls));
    });

    await test('the header shows the microphone and tapping it toggles it on the PC', async () => {
      await page.waitFor(`!document.getElementById('mic').hidden`, 'the microphone button');
      deck.model.calls.length = 0;
      await page.tap('#mic');
      await sleep(300);
      assert.ok(deck.model.calls.some((c) => c.method === 'POST' && c.path === '/api/mic' && c.body.muted === 'toggle'));
      assert.strictEqual(await page.eval(`document.getElementById('mic').dataset.muted`), 'true');
    });

    // --- volume: the button in the live strip and the panel it opens (phase 2C) ---
    const volState = () => page.eval(`JSON.stringify({ open: !document.getElementById('volume-panel').hidden, expanded: document.getElementById('vol-btn').getAttribute('aria-expanded'), scrim: !document.getElementById('scrim').hidden })`).then(JSON.parse);

    await test('#vol-btn is the first button of the live strip: 44 px, labelled, shows the PC level, panel closed', async () => {
      await page.waitFor(`document.getElementById('vol-pct').textContent === '40%'`, 'the level on the button');
      const info = await page.eval(`(() => { const b = document.getElementById('vol-btn'); const r = b.getBoundingClientRect(); return { first: document.getElementById('live-strip').firstElementChild === b, label: b.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height), muted: b.dataset.muted, panel: document.getElementById('volume').closest('#volume-panel') !== null, hidden: document.getElementById('volume-panel').hidden }; })()`);
      assert.deepStrictEqual(info, { first: true, label: 'Volume', w: info.w, h: info.h, muted: 'false', panel: true, hidden: true });
      assert.ok(info.w >= 44 && info.h >= 44, JSON.stringify(info));
      assert.deepStrictEqual(await volState(), { open: false, expanded: 'false', scrim: false });
    });

    await test('the button opens the panel (slider, mute, media keys); dragging the slider sends the level and does not close the panel or swipe the page', async () => {
      await page.tap('#vol-btn');
      await page.waitFor(`!document.getElementById('volume-panel').hidden`, 'the volume panel');
      assert.deepStrictEqual(await volState(), { open: true, expanded: 'true', scrim: true });
      const shown = await page.eval(`(() => { const p = document.getElementById('volume-panel').getBoundingClientRect(); const ok = (id) => { const r = document.querySelector(id).getBoundingClientRect(); return r.width >= 44 && r.height >= 44 && r.left >= p.left - 1 && r.right <= p.right + 1 && r.top >= p.top - 1 && r.bottom <= p.bottom + 1; }; return { value: document.getElementById('vol-value').textContent, level: document.getElementById('vol').value, all: ['#mute', '#vol', '[data-media=prev]', '[data-media=playpause]', '[data-media=next]'].map(ok) }; })()`);
      assert.deepStrictEqual(shown, { value: '40%', level: '40', all: [true, true, true, true, true] });
      // a real touch drag along the slider (the thumb starts near 40 %)
      const scrollBefore = await page.eval(`document.getElementById('pager').scrollLeft`);
      const box = await page.eval(`(() => { const r = document.getElementById('vol').getBoundingClientRect(); return { l: r.left, w: r.width, y: r.top + r.height / 2 }; })()`);
      deck.model.calls.length = 0;
      await page.touch('touchStart', box.l + box.w * 0.4, box.y);
      for (let step = 1; step <= 8; step += 1) {
        await page.touch('touchMove', box.l + box.w * (0.4 + step * 0.05), box.y + (step % 2 ? 6 : -6));
        await sleep(40);
      }
      await page.touch('touchEnd', box.l + box.w * 0.8, box.y);
      await sleep(400);
      const sent = deck.model.calls.filter((c) => c.method === 'POST' && c.path === '/api/volume').map((c) => c.body.level);
      assert.ok(sent.length >= 1 && sent[sent.length - 1] >= 70, `the drag sent ${JSON.stringify(sent)}`);
      assert.strictEqual((await volState()).open, true, 'dragging the slider closed the panel');
      assert.strictEqual(await page.eval(`document.getElementById('pager').scrollLeft`), scrollBefore, 'the drag swiped the page');
      assert.match(await page.eval(`document.getElementById('vol-pct').textContent`), /^[7-9]\d%$/);
    });

    await test('mute in the panel paints the button red with "mudo"; the media keys send the global keys', async () => {
      deck.model.calls.length = 0;
      await page.tap('#mute');
      await page.waitFor(`document.getElementById('vol-btn').dataset.muted === 'true'`, 'the muted button');
      assert.strictEqual(await page.eval(`document.getElementById('vol-pct').textContent`), 'mudo');
      assert.ok(deck.model.calls.some((c) => c.path === '/api/volume' && c.body.muted === 'toggle'));
      await page.tap('#mute');
      await page.waitFor(`document.getElementById('vol-btn').dataset.muted === 'false'`, 'unmuted');
      await page.tap('[data-media=playpause]');
      await sleep(200);
      assert.ok(deck.model.calls.some((c) => c.path === '/api/mediakey/playpause'));
    });

    await test('the button again closes the panel; a tap outside closes it without touching the key below', async () => {
      await page.tap('#vol-btn');
      await page.waitFor(`document.getElementById('volume-panel').hidden`, 'closed by the button');
      assert.deepStrictEqual(await volState(), { open: false, expanded: 'false', scrim: false });
      await page.tap('#vol-btn');
      await page.waitFor(`!document.getElementById('volume-panel').hidden`, 'open again');
      await sleep(300); // the panel slides up in portrait: a tap during the slide would land on it
      await page.tap('#tabs .tab[data-section="apps"]'); // over the scrim: the panel closes, the tab itself is not pressed
      await page.waitFor(`document.getElementById('volume-panel').hidden`, 'closed by a tap outside');
      await page.tap('#vol-btn');
      await page.waitFor(`!document.getElementById('volume-panel').hidden`, 'open once more');
      await sleep(300);
      const key = await page.eval(`(() => { const r = document.querySelector('.tile[data-key="a:app1"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      deck.model.calls.length = 0;
      await page.touch('touchStart', key.x, key.y);
      await page.touch('touchEnd', key.x, key.y);
      await page.waitFor(`document.getElementById('volume-panel').hidden`, 'closed by a tap on a key');
      await sleep(300);
      assert.ok(!deck.model.calls.some((c) => c.path.startsWith('/api/launch')), 'the dismissing tap launched an app');
    });

    await test('a running app shows its dot, and a scheduled shutdown shows the pill', async () => {
      assert.ok(await page.eval(`document.querySelector('.tile[data-app-id="app0"]').classList.contains('running')`));
      deck.model.state.scheduled = { action: 'shutdown', inSec: 600 };
      await page.waitFor(`!document.getElementById('power-pill').hidden`, 'the power pill');
      assert.match(await page.eval(`document.getElementById('power-pill').textContent`), /^Desliga (em )?\d/);
      deck.model.state.scheduled = null;
      await page.waitFor(`document.getElementById('power-pill').hidden`, 'the pill to go away');
    });

    await test('losing the PC shows the offline indicator, and it comes back by itself', async () => {
      assert.strictEqual(await page.eval(`document.getElementById('status').dataset.state`), 'online');
      deck.model.down = true;
      await page.waitFor(`document.getElementById('status').dataset.state === 'offline'`, 'the offline indicator', 9000);
      assert.strictEqual(await page.eval(`document.getElementById('status').textContent`), 'sem conexão');
      deck.model.down = false;
      await page.waitFor(`document.getElementById('status').dataset.state === 'online'`, 'the online indicator', 9000);
    });

    // the offline notice, in both orientations: real text and a button that asks the PC again
    for (const [label, width, height] of [['landscape', 836, 387], ['portrait', 411, 914]]) {
      await test(`offline shows the notice with text and a retry button (${label}), and the button checks again`, async () => {
        const offlinePage = await browser2(width, height);
        try {
          await offlinePage.waitFor(`document.getElementById('status').dataset.state === 'online'`, 'online first');
          assert.strictEqual(await offlinePage.eval(`getComputedStyle(document.getElementById('offline')).display`), 'none');
          deck.model.down = true;
          await offlinePage.waitFor(`document.body.dataset.state === 'offline'`, 'the offline state', 9000);
          const box = await offlinePage.eval(`(() => { const o = document.getElementById('offline').getBoundingClientRect(); const p = document.getElementById('pager').getBoundingClientRect(); const b = document.getElementById('offline-retry').getBoundingClientRect(); return { text: document.getElementById('offline-text').textContent, oBottom: o.bottom, pTop: p.top, w: o.width, bw: b.width, bh: b.height, right: b.right }; })()`);
          assert.strictEqual(box.text, 'PC desconectado');
          assert.ok(box.bw > 0 && box.bh > 0 && box.right <= width, JSON.stringify(box));
          assert.ok(box.pTop >= box.oBottom - 1, `the pager sits under the notice: ${JSON.stringify(box)}`);
          deck.model.calls.length = 0;
          deck.model.down = false;
          await offlinePage.tap('#offline-retry');
          await offlinePage.waitFor(`document.body.dataset.state === 'online'`, 'back online after Tentar agora', 3000);
          assert.ok(deck.model.calls.some((c) => c.path === '/api/state'), 'the retry asked the PC');
        } finally {
          deck.model.down = false;
          offlinePage.close();
        }
      });
    }

    await test('Energia: no open-windows chips or note, Hibernar hidden while hibernation is off, and the grid has no hole', async () => {
      // the deck redraws its pages right after coming back online and a tap during that is undone: tap again until it sticks
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await sleep(500);
        await page.tap('#tabs .tab[data-section="power"]');
        if (await page.waitFor(`document.querySelector('#tabs .tab[data-section="power"]').getAttribute('aria-selected') === 'true'`, 'the Energia tab', 1500).then(() => true, () => false)) break;
      }
      await page.waitFor(`document.querySelector('.power-page .badge')`, 'the power state');
      const power = await page.eval(`(() => {
        const page = document.querySelector('.power-page');
        const tiles = [...page.querySelectorAll('.act')];
        const shown = tiles.filter((t) => t.getBoundingClientRect().width > 0);
        const last = shown[shown.length - 1].getBoundingClientRect();
        const grid = page.querySelector('.actions-grid').getBoundingClientRect();
        return { chips: page.querySelectorAll('.power-side .chip').length, text: page.querySelector('.power-side').textContent, hibernateHidden: tiles.find((t) => t.textContent.includes('Hibernar')).hidden, shown: shown.length, lastRight: last.right, gridRight: grid.right };
      })()`);
      assert.strictEqual(power.chips, 0);
      assert.ok(!/Janelas abertas|Podem ter trabalho/.test(power.text), power.text);
      assert.ok(power.text.includes('Hibernação'), 'the state card still explains hibernation');
      assert.strictEqual(power.hibernateHidden, true);
      assert.strictEqual(power.shown, 7);
      assert.ok(Math.abs(power.lastRight - power.gridRight) < 2, `the last tile reaches the grid edge: ${JSON.stringify(power)}`);
      await page.tap('#tabs .tab[data-section="apps"]');
    });

    await test('Câmera do celular: opening the sheet does not ask for the camera; "Ver prévia" and "Transmitir ao PC" do', async () => {
      await page.eval(`(() => { window.__gum = 0; navigator.mediaDevices.getUserMedia = async () => { window.__gum += 1; throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' }); }; })()`);
      await page.tap('#menu');
      await page.waitFor(`!document.getElementById('menu-pop').hidden`, 'the menu');
      await page.eval(`[...document.querySelectorAll('#menu-pop button')].find((b) => b.textContent.includes('Câmera do celular')).click()`);
      await page.waitFor(`document.querySelector('.camera-page') && !document.querySelector('.camera-page').closest('.overlay').hidden`, 'the camera sheet');
      await sleep(400);
      assert.strictEqual(await page.eval('window.__gum'), 0, 'opening the sheet asked for the camera');
      assert.strictEqual(await page.eval(`document.querySelector('.cam-placeholder button').hidden`), false, 'the Ver prévia button is there');
      assert.strictEqual(await page.eval(`getComputedStyle(document.querySelector('.cam-video')).visibility`), 'hidden', 'the empty video (WebView play poster) is hidden while there is no stream');
      await page.tap('.cam-placeholder button');
      await page.waitFor('window.__gum === 1', 'getUserMedia after Ver prévia');
      await page.tap('.cam-send');
      await page.waitFor('window.__gum === 2', 'getUserMedia after Transmitir ao PC');
      await page.eval(`document.querySelector('.camera-page').closest('.overlay').querySelector('.overlay-close').click()`);
    });

    await test('Câmera do celular: the preview video shows once there is a stream, mirrored for the front camera, and hides again on close', async () => {
      await page.eval(`(() => { navigator.mediaDevices.getUserMedia = async () => document.createElement('canvas').captureStream(5); })()`);
      await page.eval(`Deck.camera.openSheet()`);
      await page.waitFor(`!document.querySelector('.camera-page').closest('.overlay').hidden`, 'the camera sheet');
      const visibility = () => page.eval(`getComputedStyle(document.querySelector('.cam-video')).visibility`);
      assert.strictEqual(await visibility(), 'hidden', 'hidden before Ver prévia');
      await page.tap('.cam-placeholder button');
      await page.waitFor(`document.querySelector('.cam-video').dataset.live === 'true'`, 'the preview going live');
      assert.strictEqual(await visibility(), 'visible', 'visible with a stream');
      assert.strictEqual(await page.eval(`document.querySelector('.cam-video').dataset.mirror`), 'true', 'the front camera is mirrored');
      await page.eval(`document.querySelector('.camera-page').closest('.overlay').querySelector('.overlay-close').click()`);
      await page.waitFor(`document.querySelector('.cam-video').dataset.live === 'false'`, 'the preview stopping');
      assert.strictEqual(await visibility(), 'hidden', 'hidden again after closing');
    });

    await test('Deck.back() closes the sheet, then the volume panel, then the menu, then the newest overlay, then goes to Apps, and says false on Apps', async () => {
      await page.eval(`document.querySelector('#tabs .tab[data-section="power"]').click()`);
      await page.waitFor(`document.querySelector('#tabs .tab[data-section="power"]').getAttribute('aria-selected') === 'true'`, 'the Energia tab');
      // all four at once: a confirmation sheet (the real one: Suspender), the volume panel, the menu and the camera overlay
      await page.waitFor(`document.querySelector('.power-page .badge')`, 'the power state');
      await page.eval(`[...document.querySelectorAll('.power-page .act')].find((t) => t.textContent.includes('Suspender')).click()`);
      await page.eval(`Deck.camera.openSheet(); document.getElementById('menu-pop').hidden = false; document.getElementById('volume-panel').hidden = false`);
      const state = () => page.eval(`JSON.stringify({ sheets: document.getElementById('modal-root').childElementCount, volume: !document.getElementById('volume-panel').hidden, menu: !document.getElementById('menu-pop').hidden, overlay: !document.querySelector('.camera-page').closest('.overlay').hidden, section: Deck.pager.currentSection() })`).then(JSON.parse);
      const want = (sheets, volume, menu, overlay) => ({ sheets, volume, menu, overlay, section: 'power' });
      assert.deepStrictEqual(await state(), want(1, true, true, true));
      for (const next of [want(0, true, true, true), want(0, false, true, true), want(0, false, false, true), want(0, false, false, false)]) {
        assert.strictEqual(await page.eval('Deck.back()'), true);
        assert.deepStrictEqual(await state(), next);
      }
      assert.strictEqual(await page.eval('Deck.back()'), true, 'with nothing open, Back leaves the page');
      await page.waitFor(`Deck.pager.currentSection() === 'apps'`, 'Apps after Back');
      assert.strictEqual(await page.eval('Deck.back()'), false, 'on Apps with nothing open there is nothing to undo');
    });

    await test('a section with several pages: page dots (only then), a plain tab, the last page remembered, and the active tab goes back to the start', async () => {
      deck.model.apps = Array.from({ length: 30 }, (_, i) => ({ id: `big${i}`, name: `App ${i}`, hasIcon: false, iconVersion: 0 }));
      const big = await browser2(412, 915);
      try {
        await big.waitFor(`document.querySelectorAll('.tile[data-key^="a:big"]').length >= 20`, 'many apps');
        await big.waitFor(`document.getElementById('status').dataset.state === 'online'`, 'online');
        await sleep(500);
        const dotsOn = () => big.eval(`[...document.querySelectorAll('#page-dots i')].map((i) => i.classList.contains('on'))`);
        const label = (section) => big.eval(`document.querySelector('#tabs .tab[data-section="${section}"]').textContent.trim()`);
        const tabTo = async (section) => {
          await big.tap(`#tabs .tab[data-section="${section}"]`);
          await big.waitFor(`document.querySelector('#tabs .tab[data-section="${section}"]').getAttribute('aria-selected') === 'true'`, `${section} tab selected`);
          await sleep(500);
        };
        // starts on Apps, which now has two pages
        await tabTo('apps');
        assert.deepStrictEqual(await dotsOn(), [true, false]);
        assert.strictEqual(await big.eval(`document.getElementById('page-dots').hidden`), false);
        assert.strictEqual(await big.eval(`getComputedStyle(document.getElementById('page-dots')).pointerEvents`), 'none');
        // out of the layout: the dots sit on top of the pager and do not shrink it
        assert.ok(await big.eval(`(() => { const d = document.getElementById('page-dots').getBoundingClientRect(); const p = document.getElementById('pager').getBoundingClientRect(); return d.bottom <= p.bottom + 1 && d.top >= p.top; })()`), 'the dots are inside the pager box');
        // second page: the tab still just says Apps, the second dot is on
        assert.strictEqual(await big.eval(`Deck.goTo('apps-1')`), true);
        await big.waitFor(`document.querySelectorAll('#page-dots i')[1].classList.contains('on')`, 'the second dot');
        assert.strictEqual(await label('apps'), 'Apps');
        // another section with a single page: no indicator at all; coming back lands on the page we left
        await tabTo('shortcuts');
        assert.strictEqual(await big.eval(`document.getElementById('page-dots').hidden`), true);
        assert.strictEqual(await big.eval(`document.querySelectorAll('#page-dots i').length`), 0);
        await tabTo('apps');
        assert.deepStrictEqual(await dotsOn(), [false, true], 'the second page of Apps was remembered');
        // tapping the active tab goes back to the first page; once there, it does nothing
        await big.tap('#tabs .tab[data-section="apps"]');
        await big.waitFor(`document.querySelectorAll('#page-dots i')[0].classList.contains('on')`, 'back to the first page');
        await sleep(600); // the slide ends
        const left = await big.eval(`document.getElementById('pager').scrollLeft`);
        assert.strictEqual(left, 0);
        await big.tap('#tabs .tab[data-section="apps"]');
        await sleep(500);
        assert.strictEqual(await big.eval(`document.getElementById('pager').scrollLeft`), left);
        assert.deepStrictEqual(await dotsOn(), [true, false]);
        assert.strictEqual(await big.eval(`Deck.back()`), false, 'Back on the first page of Apps still has nothing to undo');
        // Back goes to Apps from any other section, as before (the first Apps page is not "somewhere else")
        await tabTo('power');
        assert.strictEqual(await big.eval(`Deck.back()`), true);
        await big.waitFor(`Deck.pager.currentSection() === 'apps'`, 'Apps after Back');
      } finally {
        deck.model.apps = ['Navegador', 'Terminal', 'Editor', 'Chat', 'Música', 'Jogos'].map((name, i) => ({ id: `app${i}`, name, hasIcon: false, iconVersion: 0 }));
        big.close();
      }
    });

    // --- Janelas, PC and Atalhos (phase 2B) ---------------------------------------------------------------------------
    const go = async (target, check = page) => {
      // a click while the deck redraws its pages (just after loading / coming back online) is undone: click again until it sticks
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await check.eval(`document.querySelector('#tabs .tab[data-section="${target}"]').click()`);
        const ok = await check.waitFor(`document.querySelector('#tabs .tab[data-section="${target}"]').getAttribute('aria-selected') === 'true'`, `${target} tab selected`, 1500).then(() => true, () => false);
        if (ok) break;
        if (attempt === 3) throw new Error(`the ${target} tab never got selected`);
      }
      await sleep(700); // the slide, and the page's first render
    };
    const visibleBox = (check, selector) => check.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const r = e ? e.getBoundingClientRect() : { width: 0, height: 0 }; return r.width > 0 && r.height > 0; })()`);
    const actionCalled = (handle, action) => deck.model.calls.some((c) => c.path === '/api/windows/action' && c.body.handle === handle && c.body.action === action);

    await test('Janelas: the list shows every window with its two buttons (48 px), and tapping a row or a button sends the right action', async () => {
      await go('windows');
      await page.waitFor(`document.querySelectorAll('.wrow').length === 3`, 'the three windows of the fake PC');
      const rows = await page.eval(`[...document.querySelectorAll('.wrow')].map((r) => ({ app: r.querySelector('.wtitle b').textContent, buttons: r.querySelectorAll('button').length, label: [...r.querySelectorAll('.wbtn')].map((b) => b.getAttribute('aria-label')), min: Math.min(...[...r.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().height))), wbtn: Math.min(...[...r.querySelectorAll('.wbtn')].map((b) => Math.round(b.getBoundingClientRect().width))) }))`);
      assert.deepStrictEqual(rows.map((r) => r.app), ['Editor', 'Navegador', 'Terminal']);
      for (const row of rows) {
        assert.strictEqual(row.buttons, 3);
        assert.ok(row.min >= 48 && row.wbtn >= 48, `targets of ${row.app}: ${JSON.stringify(row)}`);
      }
      assert.deepStrictEqual(rows.map((r) => r.label), [['Minimizar', 'Maximizar'], ['Minimizar', 'Restaurar'], ['Restaurar', 'Maximizar']]);

      deck.model.calls.length = 0;
      await page.tap('.wrow[data-handle="101"] .wmain');
      await sleep(300);
      assert.ok(actionCalled(101, 'focus'), JSON.stringify(deck.model.calls));
      deck.model.calls.length = 0;
      await page.tap('.wrow[data-handle="101"] .wbtn:last-child');
      await sleep(300);
      assert.ok(actionCalled(101, 'maximize'), JSON.stringify(deck.model.calls));
      deck.model.calls.length = 0;
      await page.tap('.wrow[data-handle="102"] .wbtn:nth-child(2)');
      await sleep(300);
      assert.ok(actionCalled(102, 'minimize'), JSON.stringify(deck.model.calls));
    });

    await test('Janelas (portrait): the Lista | Mapa selector shows one pane at a time and remembers the choice', async () => {
      // the actions above left a window selected: start from a clean list
      await page.eval(`document.querySelector('.windows-page').dataset.pane = 'list'`);
      assert.ok(await visibleBox(page, '.wpane-list'));
      assert.ok(!(await visibleBox(page, '.wpane-map')), 'the map is hidden while the list shows');
      const seg = await page.eval(`[...document.querySelectorAll('.windows-page .seg-btn')].map((b) => ({ id: b.dataset.seg, h: Math.round(b.getBoundingClientRect().height), w: Math.round(b.getBoundingClientRect().width), on: b.getAttribute('aria-selected') }))`);
      assert.deepStrictEqual(seg.map((b) => b.id), ['list', 'map']);
      assert.ok(seg.every((b) => b.h >= 48 && b.w >= 48), JSON.stringify(seg));
      assert.deepStrictEqual(seg.map((b) => b.on), ['true', 'false']);
      await page.tap('.windows-page .seg-btn[data-seg="map"]');
      await page.waitFor(`document.querySelector('.windows-page').dataset.pane === 'map'`, 'the map pane');
      assert.ok(await visibleBox(page, '.wpane-map'));
      assert.ok(!(await visibleBox(page, '.wpane-list')), 'the list is hidden while the map shows');
      await page.waitFor(`document.querySelectorAll('.map .mon').length === 1 && document.querySelectorAll('.map .mwin').length === 2`, 'the screen and the two visible windows drawn');
      assert.ok(await visibleBox(page, '.map .mwin'), 'the map was drawn with a real size');
      // the choice survives leaving and coming back
      await go('apps');
      await go('windows');
      assert.strictEqual(await page.eval(`document.querySelector('.windows-page').dataset.pane`), 'map');
      await page.tap('.windows-page .seg-btn[data-seg="list"]');
      await page.waitFor(`document.querySelector('.windows-page').dataset.pane === 'list'`, 'back to the list');
    });

    await test('Janelas: selecting a window in the list selects it on the map and shows its actions', async () => {
      await page.eval(`document.querySelector('.mwin.sel')?.classList.remove('sel'); document.querySelector('.win-panel').hidden = true`);
      await page.tap('.wrow[data-handle="101"] .wmain');
      await page.waitFor(`document.querySelector('.mwin[data-handle="101"]')?.classList.contains('sel') && !document.querySelector('.win-panel').hidden`, 'the same window selected on the map, with its panel');
      assert.ok(await page.eval(`document.querySelector('.wrow[data-handle="101"]').classList.contains('sel')`));
      await page.tap('.windows-page .seg-btn[data-seg="map"]');
      await page.waitFor(`document.querySelector('.windows-page').dataset.pane === 'map'`, 'the map pane');
      assert.ok(await visibleBox(page, '.win-panel'), 'the panel is on screen without a second tap');
      assert.match(await page.eval(`document.querySelector('.win-panel .panel-title b').textContent`), /Documento/);
      await page.tap('.windows-page .seg-btn[data-seg="list"]');
      await go('apps');
    });

    await test('Janelas (landscape): the list and the map are side by side and there is no selector', async () => {
      const wide = await browser2(836, 387);
      try {
        await wide.waitFor(`document.querySelectorAll('#tabs .tab').length === 6`, 'the tabs');
        await go('windows', wide);
        await wide.waitFor(`document.querySelectorAll('.wrow').length === 3 && document.querySelectorAll('.map .mwin').length === 2`, 'the list and the map');
        const boxes = await wide.eval(`(() => { const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width, h: b.height }; }; return { list: r('.wpane-list'), map: r('.wpane-map'), seg: document.querySelector('.windows-page .seg').getBoundingClientRect().width }; })()`);
        assert.ok(boxes.list.w > 0 && boxes.map.w > 0 && boxes.list.r <= boxes.map.l + 1, JSON.stringify(boxes));
        assert.strictEqual(boxes.seg, 0, 'the selector is for portrait');
        // the map is the point of the tab: big enough to drag with a finger, and the Telas row sits under it, whole
        const map = await wide.eval(`(() => {
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
      } finally {
        wide.close();
      }
    });

    // Touching a window on the map: it is selected, its panel shows, and NOTHING redraws the map (a resize in the middle of the
    // gesture used to empty it). Same in both orientations.
    const mapTouch = async (check, label) => {
      await check.waitFor(`document.querySelectorAll('.map .mwin').length === 2`, `${label}: the windows on the map`);
      await sleep(400);
      const snap = () => check.eval(`(() => { const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }; return { mon: r(document.querySelector('.map .mon')), map: r(document.querySelector('.map')), wrap: r(document.querySelector('.map-wrap')), wins: document.querySelectorAll('.map .mwin').length, sel: document.querySelectorAll('.map .mwin.sel').length, panel: !document.querySelector('.win-panel').hidden }; })()`);
      const before = await snap();
      assert.strictEqual(before.sel, 0, label);
      await check.tap('.mwin[data-handle="101"]');
      await check.waitFor(`document.querySelector('.mwin[data-handle="101"]')?.classList.contains('sel')`, `${label}: the window selected`);
      await sleep(1500); // a rebuild caused by the panel replacing the Telas row would show up by now
      const after = await snap();
      assert.strictEqual(after.wins, 2, `${label}: the windows vanished from the map ${JSON.stringify(after)}`);
      assert.deepStrictEqual([after.mon, after.map, after.wrap], [before.mon, before.map, before.wrap], `${label}: selecting resized the map`);
      assert.ok(after.sel === 1 && after.panel, `${label}: ${JSON.stringify(after)}`);
      // the empty part of the map clears the selection and the windows stay
      const empty = await check.eval(`(() => { const b = document.querySelector('.map-wrap').getBoundingClientRect(); return { x: Math.round(b.left + 4), y: Math.round(b.top + 4) }; })()`);
      await check.touch('touchStart', empty.x, empty.y);
      await check.touch('touchEnd', empty.x, empty.y);
      await check.waitFor(`document.querySelectorAll('.map .mwin.sel').length === 0 && document.querySelector('.win-panel').hidden`, `${label}: the selection cleared`);
      await sleep(800);
      const cleared = await snap();
      assert.strictEqual(cleared.wins, 2, `${label}: ${JSON.stringify(cleared)}`);
      assert.deepStrictEqual([cleared.mon, cleared.map], [before.mon, before.map], `${label}: clearing resized the map`);
    };

    await test('Janelas (landscape): touching a window on the map selects it without resizing the map or emptying it; touching the empty map clears it', async () => {
      const wide = await browser2(836, 387);
      try {
        await wide.waitFor(`document.querySelectorAll('#tabs .tab').length === 6`, 'the tabs');
        await go('windows', wide);
        await mapTouch(wide, 'landscape');
      } finally {
        wide.close();
      }
    });

    await test('Janelas (portrait): touching a window on the map selects it without resizing or emptying the map', async () => {
      const tall = await browser2(410, 914);
      try {
        await tall.waitFor(`document.querySelectorAll('#tabs .tab').length === 6`, 'the tabs');
        await go('windows', tall);
        await tall.tap('.windows-page .seg-btn[data-seg="map"]');
        await tall.waitFor(`document.querySelector('.windows-page').dataset.pane === 'map'`, 'the map pane');
        await mapTouch(tall, 'portrait');
      } finally {
        tall.close();
      }
    });

    await test('Janelas: dragging a window on the map moves it, ends the gesture and the map draws again; a resize during the drag does not strand it', async () => {
      const wide = await browser2(836, 387);
      const saved = JSON.stringify(deck.model.windows);
      try {
        await wide.waitFor(`document.querySelectorAll('#tabs .tab').length === 6`, 'the tabs');
        await go('windows', wide);
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
        // the page is resized in the middle of the drag (the map would be rebuilt): the window under the finger must survive
        await wide.setViewport(836, 380);
        await sleep(400);
        await wide.touch('touchEnd', monBox.x, monBox.y + 20);
        await wide.waitFor(`!document.querySelector('.mwin.dragging')`, 'the drag to end');
        await sleep(300);
        assert.ok(deck.model.calls.some((c) => c.path === '/api/windows/place' && c.body.handle === 101), `the move was sent: ${JSON.stringify(deck.model.calls.map((c) => c.path))}`);
        assert.strictEqual(await wide.eval(`document.querySelectorAll('.map .mwin').length`), 2, 'the windows are still on the map');
        // drawing is not blocked: a change on the PC shows on the map
        deck.model.windows[0] = { ...deck.model.windows[0], x: 900, y: 300 };
        await wide.waitFor(`document.querySelector('.mwin[data-handle="101"]').style.left !== ${JSON.stringify(await left())}`, 'the map following the PC after the drag');
        assert.notStrictEqual(await left(), startLeft);
      } finally {
        deck.model.windows = JSON.parse(saved);
        wide.close();
      }
    });

    // what the page subscribed to on its push stream the last time it changed (every pane change reconnects with its own topics)
    const topicsNow = () => {
      const opened = deck.model.calls.filter((c) => c.path === '/api/events');
      return opened.length ? opened[opened.length - 1].topics.split(',') : null;
    };
    const infoCalls = () => deck.model.calls.filter((c) => c.method === 'GET' && c.path === '/api/monitor/info').length;
    await test('PC: the selector switches panes and only the active one subscribes to / asks the PC for data', async () => {
      deck.model.calls.length = 0;
      await go('pc'); // Desempenho is the pane it opens on
      assert.deepStrictEqual(await page.eval(`[...document.querySelectorAll('.pc-page .seg-btn')].map((b) => b.textContent)`), ['Desempenho', 'Processos', 'Sistema']);
      assert.ok(await page.eval(`[...document.querySelectorAll('.pc-page .seg-btn')].every((b) => b.getBoundingClientRect().height >= 48 && b.getBoundingClientRect().width >= 48)`));
      const only = async (name, wanted, fresh = true) => {
        if (fresh) {
          deck.model.calls.length = 0;
          await page.tap(`.pc-page .seg-btn[data-seg="${name}"]`);
        }
        await page.waitFor(`Deck.perf.pane === '${name}'`, `${name} pane`);
        await sleep(700); // the stream reconnects with the new topics
        const topics = topicsNow();
        assert.ok(topics, `${name}: the page did not resubscribe`);
        for (const topic of ['monitor', 'processes']) assert.strictEqual(topics.includes(topic), topic === wanted, `${name}: topics ${topics}`);
        assert.strictEqual(infoCalls() > 0, name === 'system', `${name}: /api/monitor/info calls ${infoCalls()}`);
        const shown = await page.eval(`[...document.querySelectorAll('.pc-page > .pc-pane')].filter((p) => p.getBoundingClientRect().width > 0).map((p) => p.className.split(' ')[0])`);
        assert.strictEqual(shown.length, 1, `${name}: ${shown}`);
      };
      await only('monitor', 'monitor', false);
      await page.waitFor(`document.querySelector('.c-cpu .big').textContent.startsWith('23')`, 'the sample drawn');
      await only('processes', 'processes');
      await page.waitFor(`document.querySelectorAll('.processes-page .proc').length === 12`, 'every row the PC sends is shown');
      await only('system', null);
      await page.waitFor(`document.querySelector('.system-page').textContent.includes('PC-TESTE')`, 'the system facts inline');
      assert.strictEqual(await page.eval(`document.querySelectorAll('.overlay:not([hidden])').length`), 0, 'no overlay');
      // leaving the page from each pane: Desempenho and Processos must drop their subscription (they had one), Sistema had none
      for (const name of ['monitor', 'processes', 'system']) {
        await page.eval(`Deck.perf.showPane('${name}')`);
        await sleep(700);
        const before = topicsNow();
        deck.model.calls.length = 0;
        await go('apps');
        await sleep(500);
        const away = topicsNow();
        if (name !== 'system') {
          assert.ok(before && before.includes(name), `${name}: was subscribed before leaving (${before})`);
          assert.ok(away, `${name}: leaving the page did not change the subscription`);
        }
        assert.ok(!away || (!away.includes('monitor') && !away.includes('processes')), `${name} away: ${away}`);
        await go('pc');
      }
      await page.eval(`Deck.perf.showPane('monitor')`);
    });

    await test('Janelas: leaving the page drops the windows subscription', async () => {
      await go('windows');
      await sleep(500);
      deck.model.calls.length = 0;
      await go('apps');
      await sleep(500);
      const away = topicsNow();
      assert.ok(away, 'leaving did not change the subscription');
      assert.ok(!away.includes('windows'), `still subscribed to windows: ${away}`);
      await go('windows');
      await sleep(500);
      assert.ok(topicsNow().includes('windows'), 'coming back subscribes again');
      await go('apps');
    });

    await test('PC (portrait): Desempenho cards keep their natural height (no clipping, a usable sparkline), and the System cards do not overlap', async () => {
      const tall = await browser2(411, 914);
      try {
        await tall.waitFor(`document.querySelectorAll('#tabs .tab').length === 6`, 'the tabs');
        await go('pc', tall);
        await tall.waitFor(`document.querySelector('.c-cpu .big').textContent.startsWith('23')`, 'the sample drawn');
        const cards = await tall.eval(`(() => {
          const pane = document.querySelector('.monitor-page').getBoundingClientRect();
          const cpu = document.querySelector('.c-cpu');
          const rect = (e) => e.getBoundingClientRect();
          const rows = [...cpu.querySelectorAll('.stats > div')].map((d) => ({ h: rect(d).height, inside: rect(d).bottom <= rect(cpu).bottom && rect(d).top >= rect(cpu).top }));
          return {
            clipped: [...document.querySelectorAll('.monitor-page .card')].filter((c) => rect(c).width > 0 && c.scrollHeight > c.clientHeight + 1).map((c) => c.className),
            spark: rect(cpu.querySelector('.spark')).height,
            rows,
            cores: rect(cpu.querySelector('.cores')).height,
            cpuH: rect(cpu).height,
            paneW: pane.width,
          };
        })()`);
        assert.deepStrictEqual(cards.clipped, [], JSON.stringify(cards));
        assert.ok(cards.spark >= 60, `the CPU sparkline is squashed: ${JSON.stringify(cards)}`);
        assert.strictEqual(cards.rows.length, 4, 'Clock, Temperatura, Potência and Processos');
        assert.ok(cards.rows.every((row) => row.h > 0 && row.inside), `a CPU stat is hidden: ${JSON.stringify(cards)}`);
        assert.ok(cards.cores > 10, `the per-core bars are squashed: ${JSON.stringify(cards)}`);

        await tall.tap('.pc-page .seg-btn[data-seg="system"]');
        await tall.waitFor(`document.querySelectorAll('.system-page .card').length >= 6`, 'the system cards');
        await sleep(300);
        const overlaps = await tall.eval(`(() => {
          const cards = [...document.querySelectorAll('.system-page .card')].map((c) => ({ name: c.querySelector('h3').textContent, r: c.getBoundingClientRect() }));
          const out = [];
          for (let i = 0; i < cards.length; i += 1) for (let j = i + 1; j < cards.length; j += 1) {
            const a = cards[i].r; const b = cards[j].r;
            if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(cards[i].name + ' x ' + cards[j].name);
          }
          const clipped = cards.filter((c, i) => document.querySelectorAll('.system-page .card')[i].scrollHeight > document.querySelectorAll('.system-page .card')[i].clientHeight + 1).map((c) => c.name);
          return { out, clipped };
        })()`);
        assert.deepStrictEqual(overlaps, { out: [], clipped: [] });
      } finally {
        tall.close();
      }
    });

    await test('PC (landscape): Desempenho shows every card whole, including three drives, and nothing scrolls inside', async () => {
      const wide = await browser2(836, 387);
      try {
        await wide.waitFor(`document.querySelectorAll('#tabs .tab').length === 6`, 'the tabs');
        await go('pc', wide);
        await wide.waitFor(`document.querySelectorAll('.c-dsk .drive').length === 3`, 'three drives');
        await sleep(300);
        const info = await wide.eval(`(() => {
          const rect = (e) => e.getBoundingClientRect();
          const dsk = document.querySelector('.c-dsk');
          const list = dsk.querySelector('.scroll');
          return {
            clipped: [...document.querySelectorAll('.monitor-page .card')].filter((c) => rect(c).width > 0 && (c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1)).map((c) => c.className),
            listScrolls: list.scrollHeight > list.clientHeight + 1,
            drivesInside: [...dsk.querySelectorAll('.drive')].every((d) => rect(d).bottom <= rect(dsk).bottom - 1),
            seg: rect(document.querySelector('.pc-page .seg-btn')).height,
          };
        })()`);
        assert.deepStrictEqual(info.clipped, [], JSON.stringify(info));
        assert.strictEqual(info.listScrolls, false, 'the drive list scrolls inside the Disco card');
        assert.ok(info.drivesInside, 'a drive row runs past the bottom of the card');
        assert.ok(info.seg >= 48);
      } finally {
        wide.close();
      }
    });

    await test('the old page ids are gone, and a game starting opens PC > Desempenho even from another pane', async () => {
      assert.strictEqual(await page.eval(`Deck.goTo('monitor')`), false);
      assert.strictEqual(await page.eval(`Deck.goTo('processes')`), false);
      assert.strictEqual(await page.eval(`Deck.pager.goToId('monitor')`), false);
      assert.strictEqual(await page.eval(`document.querySelectorAll('#tabs .tab[data-section="monitor"], #tabs .tab[data-section="processes"]').length`), 0);
      await page.eval(`Deck.perf.showPane('processes')`);
      deck.model.fps = { fps: 90, frameMs: 11.1, app: 'Jogo' };
      deck.model.pushGame();
      await page.waitFor(`document.querySelector('#tabs .tab[data-section="pc"]').getAttribute('aria-selected') === 'true' && Deck.perf.pane === 'monitor'`, 'PC > Desempenho for the game', 8000);
      assert.strictEqual(await page.eval(`document.getElementById('fps').hidden`), true, 'the pill hides on Desempenho');
      // the pill on another page takes you back there
      await go('apps');
      await page.eval(`Deck.perf.showPane('system')`);
      await page.waitFor(`!document.getElementById('fps').hidden`, 'the pill outside Desempenho');
      await page.tap('#fps');
      await page.waitFor(`document.querySelector('#tabs .tab[data-section="pc"]').getAttribute('aria-selected') === 'true' && Deck.perf.pane === 'monitor'`, 'the pill opens PC > Desempenho');
      deck.model.fps = null;
      deck.model.pushGame();
      await page.waitFor(`document.getElementById('fps').hidden`, 'the game ending', 9000);
      await go('apps');
    });

    await test('the menu has no "Sobre este PC" any more', async () => {
      await page.tap('#menu');
      await page.waitFor(`!document.getElementById('menu-pop').hidden`, 'the menu');
      const items = await page.eval(`[...document.querySelectorAll('#menu-pop button')].map((b) => b.textContent.trim())`);
      assert.ok(!items.some((item) => /Sobre/.test(item)), JSON.stringify(items));
      assert.ok(items.some((item) => item.includes('Editar botões')), JSON.stringify(items));
      await page.eval(`Deck.back()`);
    });

    await test('Atalhos: the first page uses the whole grid (every row of keys), has no volume strip at the end, and Apps has the same grid', async () => {
      await go('shortcuts');
      const info = await page.eval(`(() => {
        const page = document.querySelector('.page[data-id="shortcuts-0"]');
        const grid = page.querySelector('.grid');
        const apps = document.querySelector('.page[data-id="apps-0"] .grid');
        const g = grid.getBoundingClientRect();
        const p = page.getBoundingClientRect();
        const cells = [...grid.children];
        const rows = new Set(cells.map((c) => Math.round(c.getBoundingClientRect().top))).size;
        return { split: page.querySelectorAll('.split, .wlist').length, volume: Boolean(page.querySelector('#volume, #vol, .volume-bar')), inPanel: document.getElementById('volume').closest('#volume-panel') !== null, cols: grid.style.getPropertyValue('--cols'), rows: grid.style.getPropertyValue('--rows'), appsCols: apps.style.getPropertyValue('--cols'), appsRows: apps.style.getPropertyValue('--rows'), cells: cells.length, visibleRows: rows, right: Math.round(p.right - g.right), left: Math.round(g.left - p.left) };
      })()`);
      assert.strictEqual(info.split, 0);
      assert.strictEqual(info.volume, false, 'the volume strip is gone from the shortcuts page');
      assert.ok(info.inPanel, 'the volume strip lives in the panel');
      assert.strictEqual(info.cols, info.appsCols, 'the same number of columns as Apps');
      assert.strictEqual(info.rows, info.appsRows, 'the same number of rows as Apps: the last row is keys, not the volume bar');
      assert.strictEqual(info.cells, Number(info.cols) * Number(info.rows), 'tiles and slots fill the whole grid');
      assert.strictEqual(info.visibleRows, Number(info.rows), JSON.stringify(info));
      assert.ok(info.right <= 20 && info.left <= 20, `the grid fills the page: ${JSON.stringify(info)}`);
      await go('apps');
    });

    await test('the page raised no script errors', () => {
      assert.deepStrictEqual(page.errors, []);
    });

    await test('a game already running at load: the FPS arrives before the pages exist and the pill still ends up in the live strip', async () => {
      deck.model.fps = { fps: 72, frameMs: 13.9, app: 'Jogo' };
      const second = await browser.open(`${deck.url}/`);
      // slides to Desempenho once the pages exist (the pill hides there), then shows on any other page
      await second.waitFor(`document.querySelector('#tabs .tab[data-section="pc"]')?.getAttribute('aria-selected') === 'true' && Deck.perf.pane === 'monitor'`, 'the slide to PC > Desempenho');
      await second.tap('#tabs .tab[data-section="apps"]');
      await second.waitFor(`!document.getElementById('fps').hidden && document.querySelector('#live-strip #fps b').textContent === '72'`, 'the FPS pill inside the live strip');
      deck.model.fps = null;
      second.close();
    });
  } finally {
    browser.close();
    extra.forEach((other) => other.close());
    deck.close();
  }
  console.log(`${passed} passed`);
  process.exit(0); // the page's open event stream would keep the fake server (and so the process) alive
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
