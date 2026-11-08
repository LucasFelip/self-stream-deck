'use strict';

// The new interface (web/dist, served at /v2/) in a real headless browser against the fake deck server of the old interface's
// tests (same CDP harness, same canned answers, which tools/contract-test checks against contracts/openapi.yaml). The cases
// are the old ones, ported: the DOM and the class names are kept on purpose so both interfaces answer to the same selectors.
// Skipped, not failed, when no Chromium-based browser is installed (CHROME_PATH) or web/dist is not built (npm run build).
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fakeDeck, launchBrowser, findBrowser, sleep } = require('../../legacy/server/test/ui/harness');

const DIST = path.join(__dirname, '..', 'dist', 'index.html');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };

(async () => {
  if (!findBrowser()) { console.log('skipped (no Chrome, Brave or Edge found; set CHROME_PATH)'); return; }
  if (!fs.existsSync(DIST)) { console.log('skipped (web/dist is not built: npm run build)'); return; }

  const deck = await fakeDeck();
  const browser = await launchBrowser(); // a portrait phone, 412x915
  const extra = [];
  const browser2 = async (width, height) => {
    const other = await launchBrowser({ width, height });
    extra.push(other);
    return other.open(`${deck.url}/v2/`);
  };
  const tapTab = async (page, section) => {
    // the page redraws right after coming online and a tap during that is undone: tap again until it sticks
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await sleep(300);
      await page.tap(`#tabs .tab[data-section="${section}"]`);
      if (await page.waitFor(`document.querySelector('#tabs .tab[data-section="${section}"]').getAttribute('aria-selected') === 'true'`, `the ${section} tab`, 1500).then(() => true, () => false)) return;
    }
    throw new Error(`could not open ${section}`);
  };
  // a tap that lands while the page is redrawing (right after an answer arrived) is undone: tap again until `done` holds
  const tapUntil = async (page, selector, done, what) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await sleep(300);
      await page.tap(selector);
      if (await page.waitFor(done, what, 1500).then(() => true, () => false)) return;
    }
    const where = await page.eval(`JSON.stringify({ section: document.querySelector('#tabs .tab[aria-selected="true"]')?.dataset.section, sheets: document.getElementById('modal-root').innerHTML.slice(0, 160), disabled: [...document.querySelectorAll('.act-tile')].map((t) => t.disabled) })`).catch(() => '?');
    throw new Error(`timed out waiting for: ${what} (${where})`);
  };
  const hold = async (page, selector, ms = 1400) => {
    const { x, y } = await page.center(selector);
    await page.touch('touchStart', x, y);
    await sleep(ms);
    await page.touch('touchEnd', x, y);
  };

  try {
    const page = await browser.open(`${deck.url}/v2/`);
    await page.waitFor(`document.body.dataset.state === 'online'`, 'online', 9000);

    await test('the navigation: six tabs in order, one selected, a gear, the PC name only in the menu', async () => {
      const tabs = await page.eval(`[...document.querySelectorAll('#tabs .tab')].map((t) => t.dataset.section)`);
      assert.deepStrictEqual(tabs, ['apps', 'shortcuts', 'windows', 'sound', 'pc', 'power']);
      assert.deepStrictEqual(await page.eval(`[...document.querySelectorAll('#tabs .tab')].map((t) => t.textContent.trim())`), ['Apps', 'Atalhos', 'Janelas', 'Som', 'PC', 'Energia']);
      assert.strictEqual(await page.eval(`document.querySelectorAll('#tabs .tab[aria-selected="true"]').length`), 1);
      assert.strictEqual(await page.eval(`document.querySelectorAll('#tabs[role="tablist"] > .tab[role="tab"]').length`), 6);
      assert.strictEqual(await page.eval(`document.querySelector('nav.nav').contains(document.getElementById('menu'))`), true);
      assert.strictEqual(await page.eval(`document.getElementById('host').textContent`), 'PC-TESTE');
      assert.ok(!/PC-TESTE/.test(await page.eval(`[...document.querySelector('nav.nav').children].filter((el) => !el.contains(document.getElementById('menu-pop'))).map((el) => el.textContent).join('')`)), 'the PC name is not in the navigation');
    });

    await test('there is one page per section in the pager, and a tab opens its page', async () => {
      assert.strictEqual(await page.eval(`document.querySelectorAll('#pager > .page').length`), 6);
      await tapTab(page, 'windows');
      assert.strictEqual(await page.eval(`document.querySelector('#tabs .tab[aria-selected="true"]').dataset.section`), 'windows');
      await tapTab(page, 'apps');
    });

    await test('losing the PC shows the offline notice, and it comes back by itself', async () => {
      assert.strictEqual(await page.eval(`document.body.dataset.state`), 'online');
      deck.model.down = true;
      await page.waitFor(`document.body.dataset.state === 'offline' && getComputedStyle(document.getElementById('offline')).display !== 'none'`, 'the offline notice', 9000);
      assert.strictEqual(await page.eval(`document.getElementById('offline-text').textContent`), 'PC desconectado');
      deck.model.down = false;
      await page.waitFor(`document.body.dataset.state === 'online'`, 'the online indicator', 9000);
    });

    for (const [label, width, height] of [['landscape', 836, 387], ['portrait', 411, 914]]) {
      await test(`offline shows the notice with text and a retry button (${label}), and the button checks again`, async () => {
        const offlinePage = await browser2(width, height);
        try {
          await offlinePage.waitFor(`document.body.dataset.state === 'online'`, 'online first', 9000);
          assert.strictEqual(await offlinePage.eval(`getComputedStyle(document.getElementById('offline')).display`), 'none');
          deck.model.down = true;
          await offlinePage.waitFor(`document.body.dataset.state === 'offline'`, 'the offline state', 9000);
          const box = await offlinePage.eval(`(() => { const o = document.getElementById('offline').getBoundingClientRect(); const p = document.getElementById('pager').getBoundingClientRect(); const b = document.getElementById('offline-retry').getBoundingClientRect(); return { text: document.getElementById('offline-text').textContent, oBottom: o.bottom, pTop: p.top, bw: b.width, bh: b.height, right: b.right }; })()`);
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

    await test('Energia: keys (icon + name, no description text), Hibernar hidden while hibernation is off, one status line, and no key reaches the PC without the confirmation', async () => {
      await tapTab(page, 'power');
      await page.waitFor(`document.querySelector('.power-status')?.textContent.includes('Desativada')`, 'the power state');
      const power = await page.eval(`(() => {
        const page = document.querySelector('.power-page');
        const tiles = [...page.querySelectorAll('.actions-grid > .tile')];
        const shown = tiles.filter((t) => t.getBoundingClientRect().width > 0);
        const grid = page.querySelector('.actions-grid');
        const last = shown[shown.length - 1].getBoundingClientRect();
        return {
          names: shown.map((t) => t.querySelector(':scope > span').textContent),
          texts: shown.map((t) => t.textContent.trim()),
          small: page.querySelectorAll('.actions-grid small').length,
          label: tiles.find((t) => t.textContent.includes('Suspender')).getAttribute('aria-label'),
          title: tiles.find((t) => t.textContent.includes('Suspender')).title,
          hibernateHidden: tiles.find((t) => t.textContent.includes('Hibernar')).hidden,
          status: page.querySelector('.power-status').textContent,
          statusH: Math.round(page.querySelector('.power-status').getBoundingClientRect().height),
          cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
          lastRight: Math.round(last.right), gridRight: Math.round(grid.getBoundingClientRect().right),
        };
      })()`);
      assert.deepStrictEqual(power.names, ['Bloquear', 'Suspender', 'Sair da conta', 'Reiniciar', 'Desligar', 'Reiniciar p/ BIOS', 'Modo avançado']);
      assert.deepStrictEqual(power.texts, power.names, 'a key has its name and nothing else (the description is not in the button)');
      assert.strictEqual(power.small, 0);
      assert.match(power.label, /^Suspender\. Baixo consumo/, 'the description is the accessible name');
      assert.match(power.title, /^Baixo consumo/);
      assert.strictEqual(power.hibernateHidden, true);
      assert.match(power.status, /Ligado há .*Reinício pendente .*Hibernação Desativada/);
      assert.ok(power.statusH < 48, `the state is one line: ${JSON.stringify(power)}`);
      assert.strictEqual(power.cols, 2, 'portrait: two columns');
      assert.ok(Math.abs(power.lastRight - power.gridRight) < 2, `with seven keys the last one takes the row: ${JSON.stringify(power)}`);

      // a key opens the confirmation with the full description and the open-windows warning; Cancelar closes it; nothing is sent
      deck.model.calls.length = 0;
      await tapUntil(page, '.actions-grid > .tile[data-tone="danger"]', `document.querySelector('#modal-root .sheet')`, 'the confirmation sheet'); // Reiniciar
      const sheet = await page.eval(`document.querySelector('#modal-root .sheet').textContent`);
      assert.match(sheet, /Reiniciar o PC\?/);
      assert.match(sheet, /Todos os apps são fechados e o Windows reinicia/, 'the full description is in the sheet');
      assert.match(sheet, /Janelas abertas: Navegador, Editor/, 'the open-windows warning');
      assert.match(sheet, /Segure para reiniciar/);
      await page.tap('#modal-root .sheet-actions button:not(.hold)');
      await page.waitFor(`document.getElementById('modal-root').childElementCount === 0`, 'the sheet closed by Cancelar');
      await sleep(300);
      assert.strictEqual(deck.model.calls.filter((c) => c.method === 'POST' && c.path === '/api/power').length, 0, 'a power action reached the PC');
    });

    await test('Energia: a tap that is not held does nothing; holding Suspender sends it once, confirmed', async () => {
      deck.model.calls.length = 0;
      await tapUntil(page, '.actions-grid > .tile[aria-label^="Suspender"]', `document.querySelector('#modal-root .sheet')`, 'the sheet');
      await page.tap('#modal-root .hold'); // a tap is not a hold
      await sleep(300);
      assert.strictEqual(deck.model.calls.filter((c) => c.path === '/api/power' && c.method === 'POST').length, 0);
      await hold(page, '#modal-root .hold');
      await page.waitFor(`document.getElementById('modal-root').childElementCount === 0`, 'the sheet closed after the hold');
      await sleep(300);
      const posts = deck.model.calls.filter((c) => c.path === '/api/power' && c.method === 'POST');
      assert.strictEqual(posts.length, 1);
      assert.deepStrictEqual(posts[0].body, { action: 'sleep', confirm: true });
      // the sheet went away under the finger: the touch that ends the hold must not click the tab of the bar that is beneath it
      await sleep(600);
      assert.strictEqual(await page.eval(`document.querySelector('#tabs .tab[aria-selected="true"]').dataset.section`), 'power', 'the page stayed on Energia');
    });

    await test('Energia: a delayed restart goes with the delay and forced apps; the countdown shows and Cancelar sends cancel', async () => {
      deck.model.calls.length = 0;
      await tapUntil(page, '.actions-grid > .tile[aria-label^="Reiniciar. "]', `document.querySelector('#modal-root .sheet .chips')`, 'the delay chips');
      await page.eval(`[...document.querySelectorAll('#modal-root .chip')].find((c) => c.textContent === '1 min').click()`);
      await page.waitFor(`document.querySelector('#modal-root .switch').getAttribute('aria-checked') === 'true' && document.querySelector('#modal-root .switch').disabled`, 'the forced switch locked on');
      assert.match(await page.eval(`document.querySelector('#modal-root .sheet .muted').textContent`), /Reiniciar em 1 min \(dá para cancelar até lá\), fechando os apps à força/);
      deck.model.power.scheduled = { action: 'restart', at: Date.now() + 60_000, force: true, inSec: 60 };
      await hold(page, '#modal-root .hold');
      await page.waitFor(`document.getElementById('modal-root').childElementCount === 0`, 'the sheet closed');
      await sleep(400);
      const posts = deck.model.calls.filter((c) => c.path === '/api/power' && c.method === 'POST');
      assert.deepStrictEqual(posts.map((c) => c.body), [{ action: 'restart', confirm: true, delaySec: 60, force: true }]);
      await page.waitFor(`!document.querySelector('.schedule').hidden && /Reinício em/.test(document.querySelector('.schedule').textContent)`, 'the countdown');
      deck.model.calls.length = 0;
      deck.model.power.scheduled = null;
      await page.tap('.schedule button');
      await sleep(300);
      assert.deepStrictEqual(deck.model.calls.filter((c) => c.path === '/api/power' && c.method === 'POST').map((c) => c.body), [{ action: 'cancel' }]);
      await page.waitFor(`document.querySelector('.schedule').hidden`, 'the countdown gone');
    });

    await test('Deck.back() closes the sheet, then the menu, then goes to Apps, and says false on Apps', async () => {
      await tapTab(page, 'power');
      await page.eval(`[...document.querySelectorAll('.power-page .actions-grid > .tile')].find((t) => t.textContent.includes('Suspender')).click()`);
      await page.waitFor(`document.getElementById('modal-root').childElementCount === 1`, 'the sheet');
      await page.eval(`document.getElementById('menu').click()`);
      await page.waitFor(`!document.getElementById('menu-pop').hidden`, 'the menu');
      // React draws the change right after Back returns, not inside the call
      const state = () => sleep(150).then(() => page.eval(`JSON.stringify({ sheets: document.getElementById('modal-root').childElementCount, menu: !document.getElementById('menu-pop').hidden })`)).then(JSON.parse);
      assert.deepStrictEqual(await state(), { sheets: 1, menu: true });
      // the newest first: the menu was opened last, then the sheet
      assert.strictEqual(await page.eval('Deck.back()'), true);
      assert.deepStrictEqual(await state(), { sheets: 1, menu: false });
      assert.strictEqual(await page.eval('Deck.back()'), true);
      assert.deepStrictEqual(await state(), { sheets: 0, menu: false });
      assert.strictEqual(await page.eval('Deck.back()'), true, 'with nothing open, Back leaves the page');
      await page.waitFor(`document.querySelector('#tabs .tab[aria-selected="true"]').dataset.section === 'apps'`, 'Apps after Back');
      assert.strictEqual(await page.eval('Deck.back()'), false, 'on Apps with nothing open there is nothing to undo');
    });

    await test('the gear opens the menu (PC name, Atualizar) and a tap on the scrim closes it without reaching the page', async () => {
      await page.tap('#menu');
      await page.waitFor(`!document.getElementById('menu-pop').hidden && !document.getElementById('scrim').hidden`, 'the menu and its scrim');
      assert.strictEqual(await page.eval(`document.getElementById('menu').getAttribute('aria-expanded')`), 'true');
      assert.ok((await page.eval(`[...document.querySelectorAll('#menu-pop button')].map((b) => b.textContent.trim())`)).includes('Atualizar'));
      deck.model.calls.length = 0;
      await page.eval(`document.getElementById('scrim').click()`);
      await page.waitFor(`document.getElementById('menu-pop').hidden && document.getElementById('scrim').hidden`, 'the menu closed');
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
