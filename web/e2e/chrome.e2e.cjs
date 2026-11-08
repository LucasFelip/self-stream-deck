'use strict';

// The chrome of the new interface in a real headless browser against the fake deck server: the settings menu (a bottom sheet in portrait, a
// popover in landscape), the overlays (camera / dimmer / editor sheets), the confirmation sheet, and the "last element ends above the bar"
// matrix. These are the old interface's cases, kept with the same numbers.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fakeDeck, launchBrowser, findBrowser, sleep } = require('./harness.cjs');
const { tapTab, tapUntil } = require('./support.cjs');

const DIST = path.join(__dirname, '..', 'dist', 'index.html');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };

const ANDROID = 'window.Android = { openSettings() { window.__settingsOpened = (window.__settingsOpened || 0) + 1; }, vibrate() {} };';

const rectOf = (check, selector) => check.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
const dragDown = async (check, from, distance, steps = 8) => {
  await check.touch('touchStart', from.x, from.y);
  for (let step = 1; step <= steps; step += 1) {
    await check.touch('touchMove', from.x, from.y + (distance * step) / steps);
    await sleep(25);
  }
  await check.touch('touchEnd', from.x, from.y + distance);
};

// A drag only closes a sheet when it starts on its handle (bar / grabber / PC name), never on the content: synthetic pointer events
// (6 moves of 40 px = 240 px, well past the threshold) on the body must change nothing, on the handle they close.
const synthDrag = (check, selector) => check.eval(`(async () => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const r = el.getBoundingClientRect();
  const x = r.left + Math.min(40, r.width / 2);
  const y = r.top + Math.min(20, r.height / 2);
  const fire = (type, dy) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', clientX: x, clientY: y + dy }));
  fire('pointerdown', 0);
  for (let i = 1; i <= 6; i += 1) { fire('pointermove', i * 40); await new Promise((resolve) => setTimeout(resolve, 20)); }
  fire('pointerup', 240);
  await new Promise((resolve) => setTimeout(resolve, 400));
  return true;
})()`);

(async () => {
  if (!findBrowser()) { console.log('skipped (no Chrome, Brave or Edge found; set CHROME_PATH)'); return; }
  if (!fs.existsSync(DIST)) { console.log('skipped (web/dist is not built: npm run build)'); return; }

  const deck = await fakeDeck();
  const extra = [];
  const open = async (width = 411, height = 914, script) => {
    const browser = await launchBrowser({ width, height });
    extra.push(browser);
    const page = await browser.open(`${deck.url}/`, script ? { script } : undefined);
    await page.waitFor(`document.querySelectorAll('.tile[data-key]').length >= 6`, 'the apps grid');
    await page.waitFor(`document.querySelectorAll('#tabs .tab').length === 6`, 'the tabs');
    await page.waitFor(`document.body.dataset.state === 'online'`, 'online', 9000);
    await sleep(500);
    return { page, close: () => browser.close() };
  };
  const menuOpen = (page) => tapUntil(page, '#menu', `!document.getElementById('menu-pop').hidden`, 'the menu');
  const camera = (page) => page.eval(`!document.querySelector('.camera-page').closest('.overlay').hidden`);
  const openCamera = async (page) => {
    await menuOpen(page);
    await sleep(300);
    await page.eval(`[...document.querySelectorAll('#menu-pop button')].find((b) => b.textContent.trim() === 'Câmera do celular').click()`);
    await page.waitFor(`!document.querySelector('.camera-page').closest('.overlay').hidden`, 'the camera sheet');
    await sleep(400);
  };
  const section = (page) => page.eval(`document.querySelector('#tabs .tab[aria-selected="true"]').dataset.section`);

  try {
    await test('the tabs are plain: the section name only, no page counter and no dots inside them', async () => {
      const { page, close } = await open();
      try {
        assert.deepStrictEqual(await page.eval(`[...document.querySelectorAll('#tabs .tab')].map((t) => t.textContent.trim())`), ['Apps', 'Atalhos', 'Janelas', 'Som', 'PC', 'Energia']);
        assert.strictEqual(await page.eval(`document.querySelectorAll('.tab-dots').length`), 0);
        assert.strictEqual(await page.eval(`document.querySelectorAll('#tabs[role="tablist"] > .tab[role="tab"]').length`), 6);
        assert.strictEqual(await page.eval(`document.querySelector('nav.nav').contains(document.getElementById('menu'))`), true);
        assert.ok(!/PC-TESTE/.test(await page.eval(`[...document.querySelector('nav.nav').children].filter((el) => !el.contains(document.getElementById('menu-pop'))).map((el) => el.textContent).join('')`)), 'the PC name is not in the navigation');
      } finally { close(); }
    });

    await test('menu: a gear named Configurações, the PC name on top and the items of 48 px (no "Sobre este PC")', async () => {
      const { page, close } = await open();
      try {
        assert.strictEqual(await page.eval(`document.getElementById('menu').getAttribute('aria-label')`), 'Configurações');
        assert.strictEqual(await page.eval(`document.querySelectorAll('#menu svg circle').length`), 1, 'the gear has one centre circle');
        await menuOpen(page);
        await sleep(300);
        assert.strictEqual(await page.eval(`document.getElementById('menu').getAttribute('aria-expanded')`), 'true');
        const menu = await page.eval(`(() => { const pop = document.getElementById('menu-pop'); const rows = [...pop.querySelectorAll('button')].filter((b) => !b.hidden); return { host: pop.querySelector('.menu-host').textContent, items: rows.map((b) => b.textContent.trim()), heights: rows.map((b) => Math.round(b.getBoundingClientRect().height)) }; })()`);
        assert.match(menu.host, /PC-TESTE/);
        assert.deepStrictEqual(menu.items, ['Editar botões', 'Câmera do celular', 'Escurecer após…', 'Atualizar']);
        assert.ok(!menu.items.some((item) => /Sobre/.test(item)));
        assert.ok(menu.heights.every((height) => height >= 48), JSON.stringify(menu));
        assert.strictEqual(await page.eval('Deck.back()'), true);
        await page.waitFor(`document.getElementById('menu-pop').hidden`, 'Back closed the menu');
      } finally { close(); }
    });

    await test('menu (portrait): a bottom sheet over the bar, full width, rounded top with a grabber; dragging it down and a tap outside close it', async () => {
      const { page, close } = await open();
      try {
        await menuOpen(page);
        await sleep(300);
        const nav = await rectOf(page, 'nav.nav');
        const sheet = await rectOf(page, '#menu-pop');
        const width = await page.eval('innerWidth');
        assert.ok(sheet.l <= 1 && sheet.r >= width - 1 && Math.abs(sheet.b - nav.t) <= 1, JSON.stringify({ sheet, nav, width }));
        assert.notStrictEqual(await page.eval(`getComputedStyle(document.getElementById('menu-pop')).borderTopLeftRadius`), '0px');
        assert.notStrictEqual(await page.eval(`getComputedStyle(document.querySelector('#menu-pop .grip')).display`), 'none');
        // a short pull comes back, a long one closes
        await dragDown(page, await page.center('#menu-pop .grip'), 30);
        await sleep(350);
        assert.strictEqual(await page.eval(`document.getElementById('menu-pop').hidden`), false, 'a short pull must not close it');
        assert.strictEqual(await page.eval(`document.getElementById('menu-pop').style.transform`), '');
        const pagerLeft = await page.eval(`document.getElementById('pager').scrollLeft`);
        await dragDown(page, await page.center('#menu-pop .grip'), 160);
        await page.waitFor(`document.getElementById('menu-pop').hidden`, 'the menu closed by dragging');
        assert.strictEqual(await page.eval(`document.getElementById('pager').scrollLeft`), pagerLeft, 'the drag swiped the page');
        assert.strictEqual(await page.eval(`document.getElementById('menu-pop').style.transform`), '', 'the sheet is put back for the next time');
        // a tap outside (on the scrim over the keys) closes it and launches nothing
        await menuOpen(page);
        await sleep(300);
        deck.model.calls.length = 0;
        const key = await page.eval(`(() => { const r = document.querySelector('.tile[data-key="a:app1"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
        await page.touch('touchStart', key.x, key.y);
        await page.touch('touchEnd', key.x, key.y);
        await page.waitFor(`document.getElementById('menu-pop').hidden`, 'closed by a tap outside');
        await sleep(300);
        assert.ok(!deck.model.calls.some((c) => c.path.startsWith('/api/launch')), 'the tap outside launched an app');
      } finally { close(); }
    });

    await test('menu (Android shell): "Endereço do PC…" shows before Atualizar and opens the settings; landscape: a popover beside the rail', async () => {
      const { page, close } = await open(836, 387, ANDROID);
      try {
        await menuOpen(page);
        await sleep(300);
        assert.deepStrictEqual(await page.eval(`[...document.querySelectorAll('#menu-pop button')].filter((b) => !b.hidden).map((b) => b.textContent.trim())`), ['Editar botões', 'Câmera do celular', 'Escurecer após…', 'Endereço do PC…', 'Atualizar']);
        const nav = await rectOf(page, 'nav.nav');
        const menu = await rectOf(page, '#menu-pop');
        assert.ok(menu.l >= nav.r && 387 - menu.b >= 8 && menu.t >= 8 && menu.r < 836 - 8, JSON.stringify({ nav, menu }));
        assert.strictEqual(await page.eval(`getComputedStyle(document.querySelector('#menu-pop .grip')).display`), 'none', 'no grabber in landscape');
        await page.tap('#settings');
        await sleep(200);
        assert.strictEqual(await page.eval('window.__settingsOpened'), 1);
        assert.strictEqual(await page.eval(`document.getElementById('menu-pop').hidden`), true, 'an item closes the menu');
      } finally { close(); }
    });

    await test('overlay (portrait): a bottom sheet ~92 % high with a grabber; a short drag of its bar stays, a long one closes; scrolling the content and a tap on the dimmed strip behave', async () => {
      const { page, close } = await open();
      try {
        await openCamera(page);
        const height = await page.eval('innerHeight');
        const sheet = await rectOf(page, '.overlay:not([hidden])');
        assert.ok(sheet.t / height >= 0.04 && sheet.t / height <= 0.15 && sheet.h / height >= 0.85 && sheet.h / height <= 0.96 && sheet.b >= height - 1, `the sheet leaves a strip above: ${JSON.stringify({ sheet, height })}`);
        assert.notStrictEqual(await page.eval(`getComputedStyle(document.querySelector('.overlay:not([hidden])')).borderTopLeftRadius`), '0px');
        assert.notStrictEqual(await page.eval(`getComputedStyle(document.querySelector('.overlay:not([hidden]) .grabber')).display`), 'none');
        const closeBtn = await rectOf(page, '.overlay:not([hidden]) .overlay-close');
        assert.ok(closeBtn.w >= 48 && closeBtn.h >= 48, JSON.stringify(closeBtn));
        const where = await section(page);
        const pagerLeft = await page.eval(`document.getElementById('pager').scrollLeft`);
        // scrolling the content (a vertical swipe in the body) never closes it
        const body = await rectOf(page, '.overlay:not([hidden]) .overlay-body');
        await page.touch('touchStart', 200, body.t + 400);
        for (let step = 1; step <= 6; step += 1) { await page.touch('touchMove', 200, body.t + 400 + step * 30); await sleep(25); }
        await page.touch('touchEnd', 200, body.t + 580);
        await sleep(300);
        assert.strictEqual(await camera(page), true, 'scrolling the content closed the sheet');
        // the bar: a short drag stays, a long one closes
        const bar = await page.center('.overlay:not([hidden]) .overlay-bar');
        await dragDown(page, { x: 150, y: bar.y }, 30);
        await sleep(350);
        assert.strictEqual(await camera(page), true, 'a short drag closed the sheet');
        await dragDown(page, { x: 150, y: bar.y }, 220);
        await page.waitFor(`document.querySelector('.camera-page').closest('.overlay').hidden`, 'the sheet closed by dragging its bar');
        assert.strictEqual(await section(page), where, 'the drag changed the page');
        assert.strictEqual(await page.eval(`document.getElementById('pager').scrollLeft`), pagerLeft, 'the drag swiped the pager');
        assert.strictEqual(await page.eval(`document.querySelector('.camera-page').closest('.overlay').style.transform`), '', 'the sheet is put back for the next time');
        // opens again in place; the dimmed strip closes it and is never a tap on the deck underneath
        await openCamera(page);
        assert.strictEqual((await rectOf(page, '.overlay:not([hidden])')).t, sheet.t);
        deck.model.calls.length = 0;
        await page.touch('touchStart', 200, 12);
        await page.touch('touchEnd', 200, 12);
        await page.waitFor(`document.querySelector('.camera-page').closest('.overlay').hidden`, 'the sheet closed by the dimmed strip');
        assert.strictEqual(deck.model.calls.filter((c) => c.method === 'POST').length, 0, 'the tap on the strip reached the deck');
      } finally { close(); }
    });

    await test('dragging the CONTENT of a sheet never closes it; dragging its handle does (overlay bar, menu grip and PC name)', async () => {
      const { page, close } = await open();
      try {
        await openCamera(page);
        await synthDrag(page, '.overlay:not([hidden]) .overlay-body');
        assert.strictEqual(await camera(page), true, 'a drag on the overlay body closed it');
        assert.strictEqual(await page.eval(`document.querySelector('.overlay:not([hidden])').style.transform`), '', 'a drag on the body moved the sheet');
        await synthDrag(page, '.overlay:not([hidden]) .overlay-bar');
        assert.strictEqual(await camera(page), false, 'a drag on the overlay bar did not close it');

        const isMenuOpen = () => page.eval(`!document.getElementById('menu-pop').hidden`);
        await menuOpen(page);
        await sleep(300);
        await synthDrag(page, '#menu-pop button:not([hidden])'); // an item (the sheet's content)
        assert.strictEqual(await isMenuOpen(), true, 'a drag on a menu item closed the menu');
        assert.strictEqual(await page.eval(`document.getElementById('menu-pop').style.transform`), '');
        await synthDrag(page, '#menu-pop .grip');
        assert.strictEqual(await isMenuOpen(), false, 'a drag on the grip did not close the menu');
        await menuOpen(page);
        await sleep(300);
        await synthDrag(page, '#menu-pop .menu-host');
        assert.strictEqual(await isMenuOpen(), false, 'a drag on the PC name did not close the menu');
      } finally { close(); }
    });

    await test('a sheet taken away while a hold-to-confirm button is held never fires the action (Back during the hold)', async () => {
      const { page, close } = await open();
      try {
        await tapTab(page, 'power');
        await page.waitFor(`document.querySelector('.power-status')?.textContent.includes('Desativada')`, 'the power state');
        await page.eval(`[...document.querySelectorAll('.power-page .actions-grid > .tile')].find((t) => t.textContent.includes('Reiniciar') && !t.textContent.includes('BIOS')).click()`);
        await page.waitFor(`document.querySelector('#modal-root .hold')`, 'the confirmation sheet');
        await sleep(350);
        deck.model.calls.length = 0;
        const hold = await page.center('#modal-root .hold');
        await page.touch('touchStart', hold.x, hold.y);
        await sleep(300);
        assert.strictEqual(await page.eval('Deck.back()'), true, 'Back removed the sheet');
        await sleep(1600); // longer than the 1.2 s hold
        await page.touch('touchEnd', hold.x, hold.y);
        await sleep(300);
        assert.strictEqual(deck.model.calls.filter((c) => c.method === 'POST' && c.path === '/api/power').length, 0, 'the removed button still fired the power action');
      } finally { close(); }
    });

    await test('overlay (landscape): the full panel, a 48 px Fechar, no grabber and no dimmed strip', async () => {
      const { page, close } = await open(836, 387);
      try {
        await openCamera(page);
        const panel = await rectOf(page, '.overlay:not([hidden])');
        assert.deepStrictEqual([panel.l, panel.t, panel.w, panel.h], [0, 0, 836, 387]);
        const closeBtn = await rectOf(page, '.overlay:not([hidden]) .overlay-close');
        const bar = await rectOf(page, '.overlay:not([hidden]) .overlay-bar');
        assert.ok(closeBtn.w >= 48 && closeBtn.h >= 48 && bar.h >= closeBtn.h, JSON.stringify({ closeBtn, bar }));
        assert.strictEqual(await page.eval(`getComputedStyle(document.querySelector('.overlay:not([hidden]) .grabber')).display`), 'none');
        assert.strictEqual(await page.eval(`getComputedStyle(document.querySelector('.overlay-scrim')).display`), 'none');
        await page.tap('.overlay:not([hidden]) .overlay-close');
        await page.waitFor(`document.querySelector('.camera-page').closest('.overlay').hidden`, 'Fechar');
      } finally { close(); }
    });

    await test('the confirmation sheet sits at the bottom in portrait (full width, rounded top) and is centred in landscape; the backdrop still closes it', async () => {
      const openSuspend = (page) => page.eval(`[...document.querySelectorAll('.power-page .actions-grid > .tile')].find((t) => t.textContent.includes('Suspender')).click()`);
      const { page, close } = await open();
      try {
        await tapTab(page, 'power');
        await page.waitFor(`document.querySelector('.power-status')?.textContent.includes('Desativada')`, 'the power state');
        await openSuspend(page);
        await page.waitFor(`document.querySelector('#modal-root .sheet')`, 'the sheet');
        await sleep(350);
        const width = await page.eval('innerWidth');
        const height = await page.eval('innerHeight');
        const sheet = await rectOf(page, '#modal-root .sheet');
        assert.ok(sheet.l <= 1 && sheet.r >= width - 1 && sheet.b >= height - 1, `bottom aligned: ${JSON.stringify({ sheet, width, height })}`);
        assert.notStrictEqual(await page.eval(`getComputedStyle(document.querySelector('#modal-root .sheet')).borderTopLeftRadius`), '0px');
        assert.ok(await page.eval(`document.querySelector('#modal-root .hold') !== null`), 'the hold-to-confirm button is still there');
        await page.touch('touchStart', 200, 20); // on the backdrop, above the sheet
        await page.touch('touchEnd', 200, 20);
        await page.waitFor(`document.getElementById('modal-root').childElementCount === 0`, 'the backdrop closed the sheet');
      } finally { close(); }

      const wide = await open(836, 387);
      try {
        await tapTab(wide.page, 'power');
        await wide.page.waitFor(`document.querySelector('.power-status')?.textContent.includes('Desativada')`, 'the power state');
        await openSuspend(wide.page);
        await wide.page.waitFor(`document.querySelector('#modal-root .sheet')`, 'the sheet');
        await sleep(300);
        const centred = await rectOf(wide.page, '#modal-root .sheet');
        assert.ok(centred.w < 836 - 20 && Math.abs(centred.t - (387 - centred.b)) <= 4 && Math.abs(centred.l - (836 - centred.r)) <= 4, `centred: ${JSON.stringify(centred)}`);
      } finally { wide.close(); }
    });

    // In portrait the page scrolls inside; scrolled to the end, the last thing must end above the navigation bar (not hide behind it)
    for (const [width, height] of [[411, 914], [360, 740]]) {
      await test(`portrait ${width}x${height}: scrolled to the end, every page ends above the bar and its last element can be reached`, async () => {
        const { page, close } = await open(width, height);
        try {
          const segment = (page_, id) => `document.querySelector('.${page_}-page .seg-btn[data-seg="${id}"]').click()`;
          const checks = [['windows', segment('windows', 'map')], ['windows', segment('windows', 'list')], ['sound', ''], ['pc', segment('pc', 'monitor')], ['pc', segment('pc', 'processes')], ['pc', segment('pc', 'system')], ['power', '']];
          for (const [name, action] of checks) {
            await tapTab(page, name);
            if (action) { await page.eval(action); await sleep(600); }
            const result = await page.eval(`(() => {
              const nav = document.querySelector('nav.nav').getBoundingClientRect();
              const page = document.querySelector('.page[data-section="${name}"]');
              const scrollers = [page, ...page.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) && e.getBoundingClientRect().height > 0);
              for (const e of scrollers) e.scrollTop = e.scrollHeight;
              let lowest = 0; let label = '';
              for (const e of page.querySelectorAll('*')) {
                const r = e.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0 || getComputedStyle(e).visibility === 'hidden' || e.closest('[hidden], .page-dots') || e.closest('svg')) continue;
                if (r.bottom > lowest) { lowest = r.bottom; label = e.className || e.tagName; }
              }
              return { navTop: Math.round(nav.top), lowest: Math.round(lowest), name: String(label).slice(0, 40), scrollers: scrollers.length };
            })()`);
            // the panes that overflow in portrait really scroll (otherwise this check would prove nothing); Sistema's compact cards fit a tall screen whole
            if (action.includes('data-seg="map"') || (action.includes('"system"') && height < 900)) assert.ok(result.scrollers >= 1, `${name} (${action}) should scroll inside: ${JSON.stringify(result)}`);
            assert.ok(result.lowest <= result.navTop + 1, `${name} (${action || 'plain'}): the last element ends at ${result.lowest} but the bar starts at ${result.navTop} (${result.name})`);
          }
        } finally { close(); }
      });
    }
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
