'use strict';

// Edit mode and the button editor of the new interface in a real headless browser against the fake deck server: the old interface's edit mode
// cases (tap edits instead of launching, the "+" slots, "Concluir", the first-time tip, Back) plus the editor's forms, which the old tests only
// reached through the entry: a shortcut, a macro with steps, hiding apps, testing an item, deleting with two taps.
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
  const open = async (width, height, script) => {
    const browser = await launchBrowser({ width, height });
    extra.push(browser);
    const page = await browser.open(`${deck.url}/`, script ? { script } : {});
    await page.waitFor(`document.querySelectorAll('.tile[data-key]').length >= 6`, 'the apps grid');
    await page.waitFor(`document.body.dataset.state === 'online'`, 'online', 9000);
    await sleep(400);
    return { page, close: () => browser.close() };
  };
  const SHORTCUTS = deck.model.shortcuts;
  const menuEdit = async (page) => {
    await tapUntil(page, '#menu', `!document.getElementById('menu-pop').hidden`, 'the menu');
    await sleep(300);
    await page.eval(`[...document.querySelectorAll('#menu-pop button')].find((b) => b.textContent.trim() === 'Editar botões').click()`);
    await page.waitFor(`document.body.classList.contains('editing')`, 'edit mode on');
  };
  const editorOpen = (page) => page.eval(`!document.querySelector('.editor-page').closest('.overlay').hidden`);
  const closeEditor = async (page) => {
    await page.eval('Deck.back()');
    await page.waitFor(`document.querySelector('.editor-page').closest('.overlay').hidden`, 'the editor closed');
  };
  const editorTab = (page) => page.eval(`document.querySelector('.ed-tabs [aria-pressed="true"]')?.textContent`);
  // the form re-renders as the working copy changes: type through the same event a keyboard would
  const typeInto = (page, selector, text) => page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const chooseOption = (page, selector, value) => page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  try {
    await test('edit mode: the menu turns it on, a tap on a key opens the editor on that key and does not launch the app, Back closes the editor and then ends the mode', async () => {
      const { page, close } = await open(411, 914);
      try {
        assert.strictEqual(await page.eval(`document.getElementById('edit-bar').hidden`), true, 'no bar outside edit mode');
        await menuEdit(page);
        assert.strictEqual(await page.eval(`document.getElementById('edit-bar').hidden`), false);
        assert.strictEqual(await editorOpen(page), false, 'the mode starts on the deck, not in the editor sheet');
        deck.model.calls.length = 0;
        await tapUntil(page, '.tile[data-key="a:app0"]', `!document.querySelector('.editor-page').closest('.overlay').hidden`, 'the editor');
        assert.strictEqual(deck.model.calls.some((call) => call.path.startsWith('/api/launch')), false, 'a tap in edit mode must not launch the app');
        await page.waitFor(`document.querySelector('.ed-tabs [aria-pressed="true"]')?.textContent === 'Apps'`, 'the Apps tab of the editor');
        // Back closes the sheet first and the mode stays; the next Back ends the mode; then Back is the usual "already on Apps"
        assert.strictEqual(await page.eval('Deck.back()'), true);
        await page.waitFor(`document.querySelector('.editor-page').closest('.overlay').hidden`, 'the editor closed');
        assert.strictEqual(await page.eval(`document.body.classList.contains('editing')`), true);
        assert.strictEqual(await page.eval('Deck.back()'), true);
        await page.waitFor(`!document.body.classList.contains('editing') && document.getElementById('edit-bar').hidden`, 'the mode ended');
        assert.strictEqual(await page.eval('Deck.back()'), false);
        // outside the mode a tap launches again
        await tapUntil(page, '.tile[data-key="a:app0"]', `true`, 'the tap');
        await sleep(300);
        assert.ok(posts(deck, '/api/launch/app0').length >= 1, 'a tap outside edit mode launches');
      } finally { close(); }
    });

    await test('edit mode: a shortcut key opens the editor on its own row, 3 touches from the gear', async () => {
      const { page, close } = await open(411, 914);
      try {
        await tapTab(page, 'shortcuts');
        await menuEdit(page); // touches 1 (gear) and 2 (Editar botões)
        assert.strictEqual(await page.eval(`document.querySelector('#tabs .tab[aria-selected="true"]').dataset.section`), 'shortcuts', 'the mode works on the Atalhos page too');
        deck.model.calls.length = 0;
        await tapUntil(page, '.tile[data-key="s:paste"]', `!document.querySelector('.editor-page').closest('.overlay').hidden`, 'the editor'); // touch 3
        await page.waitFor(`document.querySelector('.ed-form input.ed-input')?.value === 'Colar'`, 'the form of the tapped shortcut');
        assert.strictEqual(await editorTab(page), 'Atalhos');
        assert.strictEqual(await page.eval(`document.querySelector('.ed-list .ed-row[aria-pressed="true"] b').textContent`), 'Colar');
        assert.ok(!deck.model.calls.some((call) => call.path === '/api/shortcut/paste'), 'not fired');
        await closeEditor(page);
      } finally { close(); }
    });

    await test('edit mode: empty slots become "+" and open the editor with a new item for that page; outside the mode they are plain', async () => {
      const { page, close } = await open(411, 914);
      try {
        assert.strictEqual(await page.eval(`document.querySelectorAll('.slot[role="button"]').length`), 0, 'plain slots outside the mode');
        await menuEdit(page);
        assert.ok(await page.eval(`document.querySelectorAll('.page[data-section="apps"] .slot[role="button"]').length`) > 0, 'slots are buttons now');
        assert.strictEqual(await page.eval(`getComputedStyle(document.querySelector('.page[data-section="apps"] .slot'), '::before').content`), '"+"');
        const size = await page.eval(`(() => { const r = document.querySelector('.page[data-section="apps"] .slot').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
        assert.ok(size.w >= 48 && size.h >= 48, JSON.stringify(size));
        await tapUntil(page, '.page[data-section="apps"] .slot', `!document.querySelector('.editor-page').closest('.overlay').hidden`, 'the editor');
        await page.waitFor(`document.querySelector('.ed-form input.ed-input')`, 'the new item form');
        assert.strictEqual(await editorTab(page), 'Macros');
        assert.strictEqual(await page.eval(`document.querySelector('.ed-form input.ed-input').value`), '');
        assert.strictEqual(await page.eval(`document.querySelector('.ed-form .chips [aria-pressed="true"]').textContent`), 'Apps', 'the new macro is for the Apps page');
        await closeEditor(page);
        // and on the Atalhos page the new item is a shortcut
        await tapTab(page, 'shortcuts');
        await tapUntil(page, '.page[data-section="shortcuts"] .slot', `!document.querySelector('.editor-page').closest('.overlay').hidden`, 'the editor');
        await page.waitFor(`document.querySelector('.ed-tabs [aria-pressed="true"]')?.textContent === 'Atalhos'`, 'the Atalhos tab');
        assert.strictEqual(await page.eval(`document.querySelector('.ed-form input.ed-input').value`), '');
        await closeEditor(page);
        await page.tap('#edit-done');
        await page.waitFor(`document.querySelectorAll('.slot[role="button"]').length === 0`, 'slots plain again');
      } finally { close(); }
    });

    for (const [width, height] of [[836, 387], [740, 360], [411, 914], [360, 740], [844, 390], [390, 844]]) {
      await test(`edit mode ${width}x${height}: "Concluir" is at least 48 px, overlaps neither the bar nor the keys, and ends the mode`, async () => {
        const { page, close } = await open(width, height);
        try {
          await menuEdit(page);
          await sleep(500); // the pager shrinks
          await page.waitFor(`document.querySelectorAll('.page[data-section="apps"] .tile[data-key]').length >= 6`, 'the keys again');
          const box = await page.eval(`(() => {
            const r = (sel) => { const e = document.querySelector(sel).getBoundingClientRect(); return { l: e.left, t: e.top, r: e.right, b: e.bottom, w: e.width, h: e.height }; };
            const hit = (a, b) => a.l < b.r - 0.5 && a.r > b.l + 0.5 && a.t < b.b - 0.5 && a.b > b.t + 0.5;
            const done = r('#edit-done');
            const others = { nav: r('nav.nav'), pager: r('#pager'), menu: r('#menu') };
            const tiles = [...document.querySelectorAll('.tile')].filter((t) => t.getBoundingClientRect().width > 0 && t.getBoundingClientRect().left >= 0 && t.getBoundingClientRect().right <= innerWidth);
            return { done, overlaps: Object.keys(others).filter((k) => hit(done, others[k])), tileHit: tiles.some((t) => { const e = t.getBoundingClientRect(); return hit(done, { l: e.left, t: e.top, r: e.right, b: e.bottom }); }), inside: done.l >= 0 && done.r <= innerWidth && done.t >= 0 && done.b <= innerHeight, hint: r('.edit-hint') };
          })()`);
          assert.ok(box.done.h >= 48 && box.done.w >= 48, JSON.stringify(box.done));
          assert.deepStrictEqual(box.overlaps, [], 'Concluir overlaps');
          assert.strictEqual(box.tileHit, false, 'Concluir covers a key');
          assert.strictEqual(box.inside, true, 'Concluir leaves the screen');
          assert.ok(box.hint.w > 40 && box.hint.r <= box.done.l + 1, `the hint is squeezed: ${JSON.stringify(box.hint)}`);
          await page.tap('#edit-done');
          await page.waitFor(`!document.body.classList.contains('editing') && document.getElementById('edit-bar').hidden`, 'the mode ended');
        } finally { close(); }
      });
    }

    await test('edit mode ends when you leave Apps / Atalhos for another section, and the menu entry brings you back', async () => {
      const { page, close } = await open(411, 914);
      try {
        await menuEdit(page);
        await tapTab(page, 'windows');
        await page.waitFor(`!document.body.classList.contains('editing')`, 'the mode ended');
        await menuEdit(page);
        await page.waitFor(`document.querySelector('#tabs .tab[aria-selected="true"]').dataset.section === 'apps'`, 'back on Apps');
        assert.strictEqual(await page.eval(`document.body.classList.contains('editing')`), true);
      } finally { close(); }
    });

    await test('edit mode: the first-time tip shows once (kept in localStorage)', async () => {
      const { page, close } = await open(411, 914);
      try {
        assert.strictEqual(await page.eval(`localStorage.getItem('ssd.editHint')`), null);
        await menuEdit(page);
        await page.waitFor(`document.getElementById('toast').classList.contains('show')`, 'the tip');
        assert.match(await page.eval(`document.getElementById('toast').textContent`), /Toque numa tecla para editar/);
        assert.strictEqual(await page.eval(`localStorage.getItem('ssd.editHint')`), '1');
        await page.tap('#edit-done');
        await page.eval(`document.getElementById('toast').classList.remove('show')`);
        await menuEdit(page);
        await sleep(300);
        assert.strictEqual(await page.eval(`document.getElementById('toast').classList.contains('show')`), false, 'the tip must not come back');
      } finally { close(); }
    });

    await test('edit mode: with no usable storage the mode still works and the tip shows once per load', async () => {
      const broken = `Object.defineProperty(window, 'localStorage', { get() { throw new Error('no storage'); } });`;
      const { page, close } = await open(411, 914, broken);
      try {
        await menuEdit(page);
        await page.waitFor(`document.getElementById('toast').classList.contains('show')`, 'the tip');
        await page.tap('#edit-done');
        await page.eval(`document.getElementById('toast').classList.remove('show')`);
        await menuEdit(page);
        await sleep(300);
        assert.strictEqual(await page.eval(`document.getElementById('toast').classList.contains('show')`), false);
        await tapUntil(page, '.tile[data-key="a:app1"]', `!document.querySelector('.editor-page').closest('.overlay').hidden`, 'the editor opens without storage');
        assert.deepStrictEqual(page.errors, []);
      } finally { close(); }
    });

    await test('editor: a new shortcut is built from the modifier chips and a key, previewed, saved with the others, and shows on the deck', async () => {
      const { page, close } = await open(411, 914);
      try {
        await tapTab(page, 'shortcuts');
        await menuEdit(page);
        await tapUntil(page, '.tile[data-key="s:copy"]', `!document.querySelector('.editor-page').closest('.overlay').hidden`, 'the editor');
        await page.waitFor(`document.querySelector('.ed-form input.ed-input')`, 'the form');
        deck.model.calls.length = 0;
        await tapUntil(page, '.ed-add', `document.querySelectorAll('.ed-list .ed-row').length === 3`, 'a third row');
        assert.strictEqual(await page.eval(`document.querySelector('.ed-list .ed-row[aria-pressed="true"] b').textContent`), '(sem nome)');
        await typeInto(page, '.ed-form input.ed-input', 'Mutar');
        for (const mod of ['Ctrl', 'Shift']) {
          await page.eval(`[...document.querySelectorAll('.ed-keys .chip')].find((c) => c.textContent === ${JSON.stringify(mod)}).click()`);
          await page.waitFor(`[...document.querySelectorAll('.ed-keys .chip')].find((c) => c.textContent === ${JSON.stringify(mod)}).getAttribute('aria-pressed') === 'true'`, `${mod} on`);
        }
        await typeInto(page, '.ed-keys input.ed-input', 'M');
        await page.waitFor(`document.querySelector('.ed-preview').textContent === 'Aperta: Ctrl + Shift + M'`, 'the preview');
        assert.strictEqual(await page.eval(`document.querySelector('.ed-list .ed-row[aria-pressed="true"] small').textContent`), 'ctrl+shift+m');
        assert.strictEqual(await page.eval(`document.querySelector('.ed-save').dataset.dirty`), 'true');
        await tapUntil(page, '.ed-save', `document.getElementById('toast').textContent === 'Salvo'`, 'the saved notice');
        const body = posts(deck, '/api/editor/shortcuts')[0].body;
        assert.deepStrictEqual(body.items.map((item) => [item.id ?? null, item.label, item.keys]), [['copy', 'Copiar', 'ctrl+c'], ['paste', 'Colar', 'ctrl+v'], [null, 'Mutar', 'ctrl+shift+m']]);
        assert.strictEqual(await page.eval(`document.querySelector('.ed-save').dataset.dirty`), 'false');
        await closeEditor(page);
        await page.waitFor(`document.querySelectorAll('.page[data-section="shortcuts"] .tile[data-key^="s:"]').length === 3`, 'the new key on the deck');
      } finally { deck.model.shortcuts = SHORTCUTS; close(); }
    });

    await test('editor: Testar saves and then presses the shortcut; Excluir needs a second tap and saves the list without it', async () => {
      const { page, close } = await open(411, 914);
      try {
        await tapTab(page, 'shortcuts');
        await menuEdit(page);
        await tapUntil(page, '.tile[data-key="s:paste"]', `!document.querySelector('.editor-page').closest('.overlay').hidden`, 'the editor');
        await page.waitFor(`document.querySelector('.ed-form input.ed-input')?.value === 'Colar'`, 'the form');
        deck.model.calls.length = 0;
        await tapUntil(page, '.ed-test', `document.getElementById('toast').textContent.startsWith('Apertou')`, 'the test notice');
        assert.strictEqual(posts(deck, '/api/editor/shortcuts').length, 1, 'it saves first');
        assert.ok(posts(deck, '/api/shortcut/paste').length >= 1, 'then presses it');
        deck.model.calls.length = 0;
        await page.tap('.ed-delete');
        await page.waitFor(`document.querySelector('.ed-delete').dataset.armed === 'true' && document.querySelector('.ed-delete').textContent === 'Toque de novo'`, 'armed');
        assert.strictEqual(posts(deck, '/api/editor/shortcuts').length, 0, 'one tap does not delete');
        await page.waitFor(`document.querySelector('.ed-delete').dataset.armed === 'false'`, 'the arming wearing off', 6000);
        await page.tap('.ed-delete');
        await page.waitFor(`document.querySelector('.ed-delete').dataset.armed === 'true'`, 'armed again');
        await page.tap('.ed-delete');
        await sleep(500);
        const body = posts(deck, '/api/editor/shortcuts')[0].body;
        assert.deepStrictEqual(body.items.map((item) => item.id), ['copy']);
        assert.strictEqual(await page.eval(`document.querySelectorAll('.ed-list .ed-row').length`), 1);
      } finally { deck.model.shortcuts = SHORTCUTS; close(); }
    });

    await test('editor: a macro is a list of steps picked from fixed kinds, which can be added, moved and removed, and the page it shows on is chosen', async () => {
      const { page, close } = await open(411, 914);
      try {
        await menuEdit(page);
        await tapUntil(page, '.page[data-section="apps"] .slot', `!document.querySelector('.editor-page').closest('.overlay').hidden`, 'the editor');
        await page.waitFor(`document.querySelector('.ed-steps .ed-step')`, 'the first step');
        assert.strictEqual(await editorTab(page), 'Macros');
        assert.match(await page.eval(`document.querySelector('.ed-step b').textContent`), /1\. Abrir ou focar um app/);
        await typeInto(page, '.ed-form input.ed-input', 'Modo jogo');
        await chooseOption(page, '.ed-form > select.ed-select', 'wait');
        await page.waitFor(`document.querySelectorAll('.ed-step').length === 2`, 'the second step');
        await chooseOption(page, '.ed-form > select.ed-select', 'volume');
        await page.waitFor(`document.querySelectorAll('.ed-step').length === 3`, 'the third step');
        // move the volume step up, then remove the wait
        await page.eval(`document.querySelectorAll('.ed-step')[2].querySelector('button[aria-label="Subir"]').click()`);
        await page.waitFor(`/2\\. Definir o volume/.test(document.querySelectorAll('.ed-step b')[1].textContent)`, 'the volume step moved up');
        await page.eval(`document.querySelectorAll('.ed-step')[2].querySelector('button[aria-label="Remover passo"]').click()`);
        await page.waitFor(`document.querySelectorAll('.ed-step').length === 2`, 'the wait removed');
        await chooseOption(page, '.ed-step:nth-child(1) select.ed-select', 'app3');
        await page.eval(`[...document.querySelectorAll('.ed-form .chips .chip')].find((c) => c.textContent === 'Atalhos').click()`);
        assert.strictEqual(await page.eval(`document.querySelector('.ed-list .ed-row[aria-pressed="true"] small').textContent`), '2 passos · tela Atalhos');
        deck.model.calls.length = 0;
        await tapUntil(page, '.ed-save', `document.getElementById('toast').textContent === 'Salvo'`, 'the saved notice');
        const body = posts(deck, '/api/editor/macros')[0].body;
        assert.deepStrictEqual(body.items.map((item) => ({ id: item.id ?? null, label: item.label, page: item.page, steps: item.steps })), [
          { id: null, label: 'Modo jogo', page: 'shortcuts', steps: [{ type: 'launch', app: 'app3' }, { type: 'volume', level: 50 }] },
        ]);
        await closeEditor(page);
        await page.tap('#edit-done');
        await tapTab(page, 'shortcuts');
        await page.waitFor(`document.querySelector('.page[data-section="shortcuts"] .tile[data-key^="m:"] small')?.textContent === '2 passos'`, 'the macro key on the deck');
      } finally { deck.model.macros = []; close(); }
    });

    await test('editor: the Apps tab hides apps from the deck, and the editor says so when it is turned off in the config', async () => {
      const { page, close } = await open(411, 914);
      try {
        await menuEdit(page);
        await tapUntil(page, '.tile[data-key="a:app0"]', `!document.querySelector('.editor-page').closest('.overlay').hidden`, 'the editor');
        await page.waitFor(`document.querySelectorAll('.ed-list .ed-row').length === 6`, 'the six apps');
        assert.strictEqual(await page.eval(`document.querySelector('.ed-add').hidden`), true, 'nothing to add on the Apps tab');
        deck.model.calls.length = 0;
        await page.eval(`document.querySelector('.ed-list .ed-row button[aria-label="Ocultar"]').click()`);
        await page.waitFor(`document.querySelector('.ed-list .ed-row.off small').textContent === 'oculto'`, 'the first app marked hidden');
        await tapUntil(page, '.ed-save', `document.getElementById('toast').textContent === 'Salvo'`, 'the saved notice');
        assert.deepStrictEqual(posts(deck, '/api/editor/apps')[0].body, { hidden: ['app0'] });
        await closeEditor(page);
        await page.waitFor(`!document.querySelector('.tile[data-key="a:app0"]')`, 'the app gone from the deck');
        await page.tap('#edit-done');
      } finally { deck.model.hidden = []; close(); }
      deck.model.editorOff = true;
      const { page: off, close: closeOff } = await open(411, 914);
      try {
        await menuEdit(off);
        await tapUntil(off, '.tile[data-key="a:app0"]', `!document.querySelector('.editor-page').closest('.overlay').hidden`, 'the editor');
        await off.waitFor(`document.querySelector('.ed-form .ed-hint')?.textContent.includes('"editor": false')`, 'the explanation');
      } finally { deck.model.editorOff = false; closeOff(); }
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
