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
      assert.deepStrictEqual(tabs.slice(0, 2), ['apps', 'shortcuts']);
      assert.strictEqual(await page.eval(`document.querySelectorAll('#tabs .tab[aria-selected="true"]').length`), 1);
      assert.strictEqual(await page.eval(`document.getElementById('host').textContent`), 'PC-TESTE');
    });

    await test('the tabs are plain: the section name only, no page counter and no dots inside them, and the strip lives outside the navigation', async () => {
      const labels = await page.eval(`[...document.querySelectorAll('#tabs .tab')].map((t) => t.textContent.trim())`);
      assert.deepStrictEqual(labels, ['Apps', 'Atalhos', 'Som', 'Desempenho', 'Energia', 'Processos']);
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

    await test('the volume strip shows the level and sends a new one when the slider moves', async () => {
      await page.tap('#tabs .tab[data-section="shortcuts"]');
      await page.waitFor(`document.getElementById('vol').value === '40'`, 'the volume level from the PC');
      assert.strictEqual(await page.eval(`document.getElementById('vol-value').textContent`), '40%');
      deck.model.calls.length = 0;
      await page.eval(`(() => { const s = document.getElementById('vol'); s.value = 75; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(300);
      assert.ok(deck.model.calls.some((c) => c.path === '/api/volume' && c.body.level === 75), JSON.stringify(deck.model.calls));
    });

    await test('a running app shows its dot, and a scheduled shutdown shows the pill', async () => {
      assert.ok(await page.eval(`document.querySelector('.tile[data-app-id="app0"]').classList.contains('running')`));
      deck.model.state.scheduled = { action: 'shutdown', inSec: 600 };
      await page.waitFor(`!document.getElementById('power-pill').hidden`, 'the power pill');
      assert.match(await page.eval(`document.getElementById('power-pill').textContent`), /^Desliga em /);
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

    await test('Deck.back() closes the sheet, then the menu, then the newest overlay, then goes to Apps, and says false on Apps', async () => {
      await page.eval(`document.querySelector('#tabs .tab[data-section="power"]').click()`);
      await page.waitFor(`document.querySelector('#tabs .tab[data-section="power"]').getAttribute('aria-selected') === 'true'`, 'the Energia tab');
      // all three at once: a confirmation sheet (the real one: Suspender), the menu and the camera overlay
      await page.waitFor(`document.querySelector('.power-page .badge')`, 'the power state');
      await page.eval(`[...document.querySelectorAll('.power-page .act')].find((t) => t.textContent.includes('Suspender')).click()`);
      await page.eval(`Deck.camera.openSheet(); document.getElementById('menu-pop').hidden = false`);
      const state = () => page.eval(`JSON.stringify({ sheets: document.getElementById('modal-root').childElementCount, menu: !document.getElementById('menu-pop').hidden, overlay: !document.querySelector('.camera-page').closest('.overlay').hidden, section: Deck.pager.currentSection() })`).then(JSON.parse);
      assert.deepStrictEqual(await state(), { sheets: 1, menu: true, overlay: true, section: 'power' });
      assert.strictEqual(await page.eval('Deck.back()'), true);
      assert.deepStrictEqual(await state(), { sheets: 0, menu: true, overlay: true, section: 'power' });
      assert.strictEqual(await page.eval('Deck.back()'), true);
      assert.deepStrictEqual(await state(), { sheets: 0, menu: false, overlay: true, section: 'power' });
      assert.strictEqual(await page.eval('Deck.back()'), true);
      assert.deepStrictEqual(await state(), { sheets: 0, menu: false, overlay: false, section: 'power' });
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

    await test('the page raised no script errors', () => {
      assert.deepStrictEqual(page.errors, []);
    });

    await test('a game already running at load: the FPS arrives before the pages exist and the pill still ends up in the live strip', async () => {
      deck.model.fps = { fps: 72, frameMs: 13.9, app: 'Jogo' };
      const second = await browser.open(`${deck.url}/`);
      // slides to Desempenho once the pages exist (the pill hides there), then shows on any other page
      await second.waitFor(`document.querySelector('#tabs .tab[data-section="monitor"]')?.getAttribute('aria-selected') === 'true'`, 'the slide to Desempenho');
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
