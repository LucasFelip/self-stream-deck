'use strict';

// The PC page of the new interface in a real headless browser against the fake deck server: the old interface's layout cases (three
// scenes in six viewports: Desempenho fits its cards and nothing overlaps or is cut),
// the rule that only the visible pane subscribes to / asks the PC for data, and what each pane shows.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fakeDeck, launchBrowser, findBrowser, sleep } = require('./harness.cjs');
const { tapTab } = require('./support.cjs');

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
    await tapTab(page, 'pc');
    return page;
  };
  // waits (polling, not a fixed pause: a CI runner is slower than a PC) until `check()` holds, and gives back its value
  const until = async (check, what, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
      await sleep(100);
    }
  };
  // what the page subscribed to on its push stream the last time it changed (every pane change reconnects with its own topics)
  const topicsNow = () => {
    const opened = deck.model.calls.filter((c) => c.path === '/api/events');
    return opened.length ? opened[opened.length - 1].topics.split(',') : null;
  };
  const infoCalls = () => deck.model.calls.filter((c) => c.method === 'GET' && c.path === '/api/monitor/info').length;

  const PC_SCENES = {
    normal: () => {},
    'muitos discos': () => { deck.model.drives = Array.from({ length: 8 }, (_, i) => ({ name: `${String.fromCharCode(67 + i)}:`, label: `Volume ${i}`, totalGB: 500, freeGB: 100 + i * 30 })); },
    'sem GPU': () => { deck.model.noGpu = true; },
  };
  const DEFAULT_DRIVES = ['C:', 'D:', 'E:'].map((name, i) => ({ name, label: ['Sistema', 'Laika', 'Strelka'][i], totalGB: [500, 730, 466][i], freeGB: [200, 195, 408][i] }));

  try {
    const page = await open(411, 914);

    await test('PC: with nothing pushed there is no selector, only Desempenho shows and it is the only pane subscribing to / asking the PC for data', async () => {
      assert.strictEqual(await page.eval(`document.querySelectorAll('.pc-page .seg-btn').length`), 0, 'no selector with a single pane');
      await page.waitFor(`document.querySelector('.c-cpu .big').textContent.startsWith('23')`, 'the sample drawn');
      const topics = await until(() => { const now = topicsNow(); return now && now.includes('monitor') ? now : null; }, 'the page subscribed to monitor');
      assert.ok(topics.includes('monitor'), `topics ${topics}`);
      assert.ok(!topics.includes('processes'), `topics ${topics}`);
      assert.strictEqual(infoCalls(), 0, '/api/monitor/info is never asked');
      const shown = await page.eval(`[...document.querySelectorAll('.pc-page > .pc-pane')].filter((p) => p.getBoundingClientRect().width > 0).map((p) => p.className.split(' ')[0])`);
      assert.strictEqual(shown.length, 1, `${shown}`);
    });

    await test('PC: leaving the page drops the subscription it had', async () => {
      const before = await until(() => { const now = topicsNow(); return now && now.includes('monitor') ? now : null; }, 'subscribed');
      deck.model.calls.length = 0;
      await tapTab(page, 'apps');
      const away = await until(() => { const now = topicsNow(); return now && !now.includes('monitor') && !now.includes('processes') ? now : null; }, 'the subscription dropped');
      assert.ok(before.includes('monitor') && away, `before ${before}, away ${away}`);
      await tapTab(page, 'pc');
    });

    await test('PC > Desempenho: the cards show the sample (levels, per-core bars, GPU name, drives, network)', async () => {
      await page.waitFor(`document.querySelector('.c-cpu .big').textContent.startsWith('23')`, 'the sample drawn');
      const info = await page.eval(`(() => {
        const t = (s) => document.querySelector(s).textContent;
        return {
          cards: document.querySelectorAll('.perf-grid > .card').length,
          cpu: t('.c-cpu .big'), cpuLevel: document.querySelector('.c-cpu .big').dataset.level,
          cpuStats: [...document.querySelectorAll('.c-cpu .stats > div')].map((d) => d.textContent),
          cores: [...document.querySelectorAll('.c-cpu .cores > i')].filter((i) => i.style.visibility === 'visible').map((i) => i.firstChild.style.height),
          cpuTitle: document.querySelector('.c-cpu .stats > div:nth-child(2)').title,
          mem: t('.c-mem .big'), memStats: [...document.querySelectorAll('.c-mem .stats > div')].map((d) => d.textContent),
          gpuSub: t('.c-gpu .sub'), gpu: t('.c-gpu .big'), gpuStats: [...document.querySelectorAll('.c-gpu .stats > div')].map((d) => d.textContent),
          drives: [...document.querySelectorAll('.c-dsk .drive')].map((d) => d.textContent),
          netSub: t('.c-net .sub'), net: t('.c-net .big'),
          sparks: document.querySelectorAll('.perf-grid .spark path.line').length,
          fps: [t('.c-fps .sub'), t('.c-fps .big'), t('.c-fps .stats')],
        };
      })()`);
      assert.strictEqual(info.cards, 6);
      assert.strictEqual(info.cpu, '23%');
      assert.strictEqual(info.cpuLevel, 'ok');
      assert.deepStrictEqual(info.cpuStats, ['Clock4.20 GHz', 'Temp.51 °C', 'Potência40 W', 'Tarefas210 · 3100']);
      assert.deepStrictEqual(info.cores, ['10%', '20%', '30%', '40%']);
      assert.match(info.cpuTitle, /Fonte: fake/);
      assert.strictEqual(info.mem, '48%');
      assert.deepStrictEqual(info.memStats, ['Em uso14.6 / 31.3 GB', 'Livre16.6 GB', 'Commit19.5 / 39.1 GB']);
      assert.strictEqual(info.gpuSub, 'RTX 4070');
      assert.strictEqual(info.gpu, '35%');
      assert.deepStrictEqual(info.gpuStats, ['VRAM3.9 / 11.7 GB', 'Temp.60 °C', 'Potência120 / 200 W', 'Fan40%', 'Clock2100 MHz']);
      assert.deepStrictEqual(info.drives, ['C: Sistema200 GB livres', 'D: Laika195 GB livres', 'E: Strelka408 GB livres']);
      assert.strictEqual(info.netSub, 'Ethernet');
      assert.strictEqual(info.net, '↓ 4.9 KB/s');
      assert.strictEqual(info.sparks, 5, 'CPU, memory, GPU, network and frame rate each have a chart');
      assert.deepStrictEqual(info.fps, ['nenhum jogo', '–', 'Quadro–'], 'the frame-rate card has nothing to show without a game');
    });

    await test('PC > Desempenho: a game shows its frame rate in the FPS card', async () => {
      const wide = await open(836, 387);
      try {
        deck.model.fps = { fps: 142, frameMs: 7, app: 'Jogo Teste', source: 'RTSS' };
        // a new answer arrives with the next push or poll: reopen the page so the sample carries the game
        await tapTab(wide, 'apps');
        await tapTab(wide, 'pc');
        await wide.waitFor(`document.querySelector('.c-fps .big').textContent === '142'`, 'the frame rate', 8000);
        const card = await wide.eval(`(() => ({ game: document.querySelector('.c-fps .sub').textContent, title: document.querySelector('.c-fps .stats > div').title, frame: document.querySelector('.c-fps .stats > div').textContent, big: document.querySelector('.c-fps .big').textContent, gaming: document.querySelector('.monitor-page').classList.contains('gaming') }))()`);
        assert.deepStrictEqual(card, { game: 'Jogo Teste', title: 'Fonte: RTSS', frame: 'Quadro7 ms', big: '142', gaming: true });
      } finally {
        delete deck.model.fps;
      }
    });

    for (const scene of Object.keys(PC_SCENES)) {
      for (const [width, height] of [[836, 387], [740, 360], [411, 914], [360, 740], [844, 390], [390, 844]]) {
        await test(`PC (${scene}) ${width}x${height}: Desempenho fits its cards and nothing overlaps or is cut`, async () => {
          PC_SCENES[scene]();
          let pcp;
          const landscape = width > height;
          try {
            pcp = await open(width, height);
            await pcp.waitFor(`document.querySelector('.c-cpu .big').textContent.startsWith('23')`, 'the sample drawn');
            await sleep(400);
            const measure = (name) => pcp.eval(`(() => {
              const root = document.querySelector('.${name}');
              const rect = (e) => e.getBoundingClientRect();
              const shown = (e) => rect(e).width > 0 && rect(e).height > 0;
              const cards = [...root.querySelectorAll('.card')].filter(shown);
              const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
              const overlaps = [];
              for (let i = 0; i < cards.length; i += 1) for (let j = i + 1; j < cards.length; j += 1) if (hit(rect(cards[i]), rect(cards[j]))) overlaps.push(i + '/' + j);
              const cut = cards.filter((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).map((c) => (c.querySelector('h3') || c).textContent.slice(0, 20));
              const text = [...root.querySelectorAll('.stats span, .kv dd, .kv dt, .big, .proc .name, .proc .val, .drive .row span, .drive .row b')].filter(shown).filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent.slice(0, 24));
              const page = document.querySelector('.pc-page').getBoundingClientRect();
              const outside = cards.filter((c) => rect(c).right > page.right + 1 || rect(c).left < page.left - 1).length;
              return { cards: cards.length, overlaps, cut, text, outside, rootScrolls: root.scrollHeight > root.clientHeight + 1 };
            })()`);
            // Desempenho
            let info = await measure('monitor-page');
            assert.strictEqual(info.cards, 6, JSON.stringify(info));
            assert.deepStrictEqual({ o: info.overlaps, c: info.cut, t: info.text, out: info.outside }, { o: [], c: [], t: [], out: 0 }, JSON.stringify(info));
            if (landscape) assert.strictEqual(info.rootScrolls, false, `landscape Desempenho must not scroll: ${JSON.stringify(info)}`);
            const kinds = await pcp.eval(`(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { sizes: [...new Set([...document.querySelectorAll('.perf-grid > .card')].map((c) => Math.round(c.getBoundingClientRect().width) + "x" + Math.round(c.getBoundingClientRect().height)))], cols: getComputedStyle(document.querySelector('.perf-grid')).gridTemplateColumns.split(' ').length }; })()`);
            assert.strictEqual(kinds.cols, landscape ? 3 : 2);
            assert.strictEqual(kinds.sizes.length, 1, `the cards are not all the same size: ${JSON.stringify(kinds)}`);
          } finally {
            deck.model.drives = DEFAULT_DRIVES;
            deck.model.noGpu = false;
            if (pcp) pcp.close();
          }
        });
      }
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
