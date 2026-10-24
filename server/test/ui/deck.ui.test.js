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

    await test('the page raised no script errors', () => {
      assert.deepStrictEqual(page.errors, []);
    });

    await test('a game already running at load: the FPS arrives before the pages exist and the pill still ends up in the header', async () => {
      deck.model.fps = { fps: 72, frameMs: 13.9, app: 'Jogo' };
      const second = await browser.open(`${deck.url}/`);
      // slides to Desempenho once the pages exist (the pill hides there), then shows on any other page
      await second.waitFor(`document.querySelector('#tabs .tab[data-section="monitor"]')?.getAttribute('aria-selected') === 'true'`, 'the slide to Desempenho');
      await second.tap('#tabs .tab[data-section="apps"]');
      await second.waitFor(`!document.getElementById('fps').hidden && document.querySelector('.actions #fps b').textContent === '72'`, 'the FPS pill inside .actions');
      deck.model.fps = null;
      second.close();
    });
  } finally {
    browser.close();
    deck.close();
  }
  console.log(`${passed} passed`);
  process.exit(0); // the page's open event stream would keep the fake server (and so the process) alive
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
