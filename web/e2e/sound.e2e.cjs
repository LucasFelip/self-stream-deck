'use strict';

// The Som page of the new interface in a real headless browser against the fake deck server. The layout case is the old interface's
// (compact player, Saída / Entrada / Aplicativos, targets >= 44 px, nothing overlaps or is cut) in the same six viewports and three
// scenes; the others check what each control sends to the PC.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fakeDeck, launchBrowser, findBrowser, sleep } = require('./harness.cjs');
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
    const page = await browser.open(`${deck.url}/`);
    await page.waitFor(`document.body.dataset.state === 'online'`, 'online', 9000);
    await tapTab(page, 'sound');
    return page;
  };
  const audioReady = (page) => page.waitFor(`document.querySelectorAll('.audio-page .device').length === 4 && document.querySelectorAll('.mixer .vol-row').length >= 2`, 'the audio data');

  const SOUND_SCENES = {
    playing: () => {},
    vazio: () => { deck.model.media = { current: null, sessions: [] }; },
    muitos: () => { deck.model.audio.sessions = Array.from({ length: 14 }, (_, i) => ({ pid: 100 + i, system: false, label: `Aplicativo ${i} com nome comprido`, active: i % 2 === 0, level: 30 + i * 4, muted: i === 3 })); },
  };

  try {
    for (const scene of Object.keys(SOUND_SCENES)) {
      for (const [width, height] of [[836, 387], [740, 360], [411, 914], [360, 740], [844, 390], [390, 844]]) {
        await test(`Som (${scene}) ${width}x${height}: compact player, Saida / Entrada / Aplicativos in the same card language, targets >= 44 (slider 48), nothing overlaps or is cut`, async () => {
          const saved = JSON.stringify({ media: deck.model.media, audio: deck.model.audio });
          SOUND_SCENES[scene]();
          let snd;
          try {
            snd = await open(width, height);
            await audioReady(snd);
            await sleep(900);
            const landscape = width > height;
            const info = await snd.eval(`(() => {
              const page = document.querySelector('.sound-page');
              const p = page.getBoundingClientRect();
              const r = (e) => e.getBoundingClientRect();
              const small = (sel, min) => [...page.querySelectorAll(sel)].filter((e) => r(e).width > 0).filter((e) => r(e).width < min || r(e).height < min).map((e) => sel + ' ' + Math.round(r(e).width) + 'x' + Math.round(r(e).height));
              const cards = [...page.querySelectorAll(':scope > .card, .audio-page > .card')].filter((c) => r(c).width > 0);
              const hit = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
              const overlaps = [];
              for (let i = 0; i < cards.length; i += 1) for (let j = i + 1; j < cards.length; j += 1) if (hit(r(cards[i]), r(cards[j]))) overlaps.push(i + '/' + j);
              const cut = [...page.querySelectorAll('.card')].filter((c) => r(c).right > p.right + 1 || r(c).left < p.left - 1).length;
              const out = page.querySelector('.audio-out .vol-row .range');
              const media = page.querySelector('.sound-media');
              return {
                small: [...small('.transport button', 44), ...small('.audio-out .vol-row .icon-btn, .audio-in .vol-row .icon-btn', 44), ...small('.device', 44), ...small('.mixer .vol-row .icon-btn', 44)],
                sliderH: Math.round(r(out).height),
                overlaps, cut,
                pageScrolls: page.scrollHeight > page.clientHeight + 1,
                bottomOk: cards.every((c) => r(c).bottom <= p.bottom + 1),
                playerH: Math.round(r(media).height),
                empty: page.querySelector('.media-page').dataset.empty,
                mixerScrolls: (() => { const s = page.querySelector('.audio-mixer .scroll'); return s.scrollHeight > s.clientHeight + 1; })(),
                order: cards.map((c) => c.className.replace('card ', '')),
              };
            })()`);
            assert.deepStrictEqual(info.small, [], JSON.stringify(info));
            assert.ok(info.sliderH >= 48, JSON.stringify(info));
            assert.deepStrictEqual(info.overlaps, []);
            assert.strictEqual(info.cut, 0);
            assert.deepStrictEqual(info.order.slice(0, 4), ['sound-media', 'audio-out', 'audio-in', 'audio-mixer'], JSON.stringify(info));
            assert.strictEqual(info.empty, scene === 'vazio' ? 'true' : 'false');
            assert.ok(info.playerH <= (scene === 'vazio' ? 64 : landscape ? 100 : 180), `player too big: ${JSON.stringify(info)}`);
            if (landscape) {
              assert.strictEqual(info.pageScrolls, false, `landscape Som must not scroll: ${JSON.stringify(info)}`);
              assert.strictEqual(info.bottomOk, true);
              if (scene === 'muitos') assert.strictEqual(info.mixerScrolls, true, 'the mixer scrolls inside when there are many apps');
            }
          } finally {
            const back = JSON.parse(saved);
            deck.model.media = back.media;
            deck.model.audio = back.audio;
            if (snd) snd.close();
          }
        });
      }
    }

    const page = await open(411, 914);
    await audioReady(page);

    await test('Som: the output and input rows show the default device, its level and the devices as radio chips; the mixer names every app', async () => {
      const info = await page.eval(`(() => ({
        out: document.querySelector('.audio-out .vol-row .value').textContent,
        inp: document.querySelector('.audio-in .vol-row .value').textContent,
        checked: [...document.querySelectorAll('.audio-out .device')].map((d) => d.getAttribute('aria-checked')),
        names: [...document.querySelectorAll('.audio-out .device .name')].map((n) => n.firstChild.textContent),
        adapter: document.querySelector('.audio-out .device small').textContent,
        mixer: [...document.querySelectorAll('.mixer .vol-row .label')].map((l) => l.textContent),
        inactive: [...document.querySelectorAll('.mixer .vol-row')].map((r) => r.classList.contains('inactive')),
        slider: document.querySelector('.audio-out .range').value,
        radios: document.querySelectorAll('.audio-out .device-list[role="radiogroup"] > [role="radio"]').length,
      }))()`);
      assert.strictEqual(info.out, '40%');
      assert.strictEqual(info.inp, '80%');
      assert.deepStrictEqual(info.checked, ['true', 'false']);
      assert.deepStrictEqual(info.names, ['Alto-falantes (Realtek)', 'Fone Bluetooth']);
      assert.strictEqual(info.adapter, 'Realtek');
      assert.deepStrictEqual(info.mixer, ['Sons do sistema', 'Navegador']);
      assert.deepStrictEqual(info.inactive, [true, false], 'an app that is not making sound is dimmed');
      assert.strictEqual(info.slider, '40');
      assert.strictEqual(info.radios, 2);
    });

    await test('Som: muting the output sends the default device id; the slider sends the level it reached, only the last of a quick run', async () => {
      deck.model.calls.length = 0;
      await tapUntil(page, '.audio-out .vol-row .icon-btn', `true`, 'the tap');
      await sleep(400);
      assert.deepStrictEqual(posts(deck, '/api/audio/device').map((c) => c.body), [{ id: 'out1', muted: true }]);
      deck.model.calls.length = 0;
      await setRange(page, '.audio-out .range', 55);
      await setRange(page, '.audio-out .range', 62);
      await setRange(page, '.audio-out .range', 70);
      assert.strictEqual(await page.eval(`document.querySelector('.audio-out .vol-row .value').textContent`), '70%', 'the value follows the finger');
      await sleep(500);
      const levels = posts(deck, '/api/audio/device').map((c) => c.body);
      assert.deepStrictEqual(levels[levels.length - 1], { id: 'out1', level: 70 });
      assert.ok(levels.length <= 3 && levels.every((b) => b.id === 'out1'), JSON.stringify(levels));
    });

    await test('Som: picking another output sends it, the lit one does nothing, and the input has its own list', async () => {
      deck.model.calls.length = 0;
      await tapUntil(page, '.audio-out .device[aria-checked="true"]', `true`, 'the tap');
      await sleep(300);
      assert.strictEqual(posts(deck, '/api/audio/default').length, 0, 'the default device is already lit');
      await tapUntil(page, '.audio-out .device[aria-checked="false"]', `true`, 'the tap');
      await sleep(400);
      assert.deepStrictEqual(posts(deck, '/api/audio/default').map((c) => c.body), [{ id: 'out2' }]);
      await page.waitFor(`document.getElementById('toast').classList.contains('show') && /Saída: Fone Bluetooth/.test(document.getElementById('toast').textContent)`, 'the notice');
      assert.strictEqual(await page.eval(`document.querySelectorAll('.audio-in .device').length`), 2);
    });

    await test('Som: the mixer sends an app by pid and the system sounds as system', async () => {
      deck.model.calls.length = 0;
      await setRange(page, '.mixer .vol-row:nth-child(2) .range', 33);
      await sleep(400);
      assert.deepStrictEqual(posts(deck, '/api/audio/session').map((c) => c.body).at(-1), { pid: 11, level: 33 });
      deck.model.calls.length = 0;
      await tapUntil(page, '.mixer .vol-row:nth-child(1) .icon-btn', `true`, 'the tap');
      await sleep(400);
      assert.deepStrictEqual(posts(deck, '/api/audio/session').map((c) => c.body), [{ system: true, muted: true }]);
    });

    await test('Som: the player shows the track, the source, the timeline and sends the transport commands', async () => {
      const info = await page.eval(`(() => ({
        title: document.querySelector('.track-title').textContent,
        artist: document.querySelector('.track-artist').textContent,
        source: document.querySelector('.track-source > .chip').textContent,
        timelineHidden: document.querySelector('.timeline').hidden,
        total: document.querySelector('.timeline span:last-child').textContent,
        empty: document.querySelector('.media-page').dataset.empty,
      }))()`);
      assert.match(info.title, /^Uma faixa com um nome bem comprido/);
      assert.strictEqual(info.artist, 'Banda · Disco');
      assert.strictEqual(info.source, 'Spotify');
      assert.strictEqual(info.timelineHidden, false);
      assert.strictEqual(info.total, '3:35');
      assert.strictEqual(info.empty, 'false');
      deck.model.calls.length = 0;
      await tapUntil(page, '.transport .primary', `true`, 'the tap');
      await page.waitFor(`/pausado/.test(document.querySelector('.track-source > .chip').textContent)`, 'the pause shown at once');
      await tapUntil(page, '.transport button[aria-label="Próxima faixa"]', `true`, 'the tap');
      await tapUntil(page, '.transport button[aria-label="Faixa anterior"]', `true`, 'the tap');
      await sleep(400);
      assert.deepStrictEqual(posts(deck, '/api/media/control').map((c) => c.body), [{ session: 's1', action: 'toggle' }, { session: 's1', action: 'next' }, { session: 's1', action: 'previous' }]);
    });

    await test('Som: a tap on the timeline seeks to that point of the track', async () => {
      deck.model.calls.length = 0;
      const box = await page.eval(`(() => { const r = document.querySelector('.timeline .range').getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.top + r.height / 2 }; })()`);
      await page.touch('touchStart', box.x, box.y);
      await page.touch('touchEnd', box.x, box.y);
      await sleep(500);
      const seeks = posts(deck, '/api/media/control').map((c) => c.body).filter((b) => b.action === 'seek');
      assert.strictEqual(seeks.length, 1, JSON.stringify(seeks));
      assert.strictEqual(seeks[0].session, 's1');
      assert.ok(seeks[0].position > 90 && seeks[0].position < 125, `about half of 215 s: ${seeks[0].position}`);
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
