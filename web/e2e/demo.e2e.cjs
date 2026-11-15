'use strict';

// The demo build (web/dist-demo, `npm run build:demo`): the real panel with no PC behind it, served from a sub-folder the way GitHub Pages does.
// Every page opens, the data comes from the recording, and the little bar's webhooks reach the panel. A real headless browser, like the other e2e files.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { launchBrowser, findBrowser } = require('./harness.cjs');
const { tapTab, tapUntil } = require('./support.cjs');

const DIST = path.join(__dirname, '..', 'dist-demo');
const BASE = '/self-stream-deck/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.map': 'application/json' };

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith(BASE)) { res.writeHead(404); res.end(); return; }
    const relative = decodeURIComponent(url.pathname.slice(BASE.length)) || 'index.html';
    const file = path.resolve(DIST, relative);
    if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  if (!findBrowser()) { console.log('skipped (no Chrome, Brave or Edge found; set CHROME_PATH)'); return; }
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.log('skipped (web/dist-demo is not built: npm run build:demo)'); return; }

  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}${BASE}`;
  const browser = await launchBrowser({ width: 411, height: 914 });
  try {
    const page = await browser.open(url);
    await page.waitFor(`document.body.dataset.state === 'online'`, 'online', 9000);

    await test('demo: the panel loads from a sub-folder with no PC and shows the keys', async () => {
      await page.waitFor(`document.querySelectorAll('.tile[data-key]').length >= 1`, 'the keys');
      assert.strictEqual(await page.eval(`document.querySelectorAll('#tabs .tab').length`), 6);
      assert.match(await page.eval(`document.body.textContent`), /Demonstração com dados de mentira/);
    });

    await test('demo: every page opens', async () => {
      for (const section of ['windows', 'sound', 'pc', 'power', 'shortcuts', 'apps']) {
        await tapTab(page, section);
        await page.waitFor(`document.querySelector('#tabs .tab[aria-selected="true"]').dataset.section === '${section}'`, `the ${section} page`);
      }
    });

    await test('demo: the webhooks of the little bar reach the panel (notice, page switch, value)', async () => {
      const press = (label) => page.eval(`[...document.querySelectorAll('div[role=note] button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
      await press('Webhook: aviso');
      await page.waitFor(`document.getElementById('toast').classList.contains('show') && document.getElementById('toast').textContent === '📣 CI: build verde'`, 'the notice');
      await press('Webhook: ir para Som');
      await page.waitFor(`document.querySelector('#tabs .tab[aria-selected="true"]').dataset.section === 'sound'`, 'the page switch', 6000);
      await press('Webhook: valor');
      await tapTab(page, 'pc');
      await page.waitFor(`[...document.querySelectorAll('.pc-page .seg-btn')].some((b) => b.textContent === 'Painel')`, 'the Painel pane');
      await tapUntil(page, '.pc-page .seg-btn[data-seg="push"]', `document.querySelector('.pc-page .seg-btn[data-seg="push"]').getAttribute('aria-selected') === 'true'`, 'the Painel pane');
      assert.ok((await page.eval(`[...document.querySelectorAll('.push-pane dt')].map((d) => d.textContent)`)).includes('temp.sala'));
    });

    await test('demo: no error reached the console', async () => assert.deepStrictEqual(page.errors, []));
  } finally {
    browser.close();
    server.close();
  }
  console.log(`${passed} passed`);
})().catch((error) => { console.error(error); process.exit(1); });
