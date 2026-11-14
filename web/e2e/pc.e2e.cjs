'use strict';

// The PC page of the new interface in a real headless browser against the fake deck server: the old interface's layout cases (three
// scenes in six viewports: Desempenho, Processos and Sistema fit their cards, nothing overlaps or is cut, the selector is 48 px),
// the rule that only the visible pane subscribes to / asks the PC for data, and what each pane shows.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fakeDeck, launchBrowser, findBrowser, sleep } = require('./harness.cjs');
const { tapTab, tapUntil } = require('./support.cjs');

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
  const pane = (page) => page.eval(`document.querySelector('.pc-page .seg-btn[aria-selected="true"]')?.dataset.seg`);
  const openPane = async (page, name) => {
    await tapUntil(page, `.pc-page .seg-btn[data-seg="${name}"]`, `document.querySelector('.pc-page .seg-btn[data-seg="${name}"]').getAttribute('aria-selected') === 'true'`, `the ${name} pane`);
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

    await test('PC: the selector has three 48 px buttons and the panes switch, one shown at a time; only the active one subscribes to / asks the PC for data', async () => {
      assert.deepStrictEqual(await page.eval(`[...document.querySelectorAll('.pc-page .seg-btn')].map((b) => b.textContent)`), ['Desempenho', 'Processos', 'Sistema']);
      assert.ok(await page.eval(`[...document.querySelectorAll('.pc-page .seg-btn')].every((b) => b.getBoundingClientRect().height >= 48 && b.getBoundingClientRect().width >= 48)`));
      assert.strictEqual(await pane(page), 'monitor', 'it opens on Desempenho');
      const only = async (name, wanted) => {
        deck.model.calls.length = 0;
        await openPane(page, name);
        // the stream reconnects with the new topics
        const topics = await until(() => {
          const now = topicsNow();
          return now && ['monitor', 'processes'].every((topic) => now.includes(topic) === (topic === wanted)) ? now : null;
        }, `${name}: the page resubscribed with the topics of this pane`).catch(() => topicsNow());
        assert.ok(topics, `${name}: the page did not resubscribe`);
        for (const topic of ['monitor', 'processes']) assert.strictEqual(topics.includes(topic), topic === wanted, `${name}: topics ${topics}`);
        assert.strictEqual(infoCalls() > 0, name === 'system', `${name}: /api/monitor/info calls ${infoCalls()}`);
        const shown = await page.eval(`[...document.querySelectorAll('.pc-page > .pc-pane')].filter((p) => p.getBoundingClientRect().width > 0).map((p) => p.className.split(' ')[0])`);
        assert.strictEqual(shown.length, 1, `${name}: ${shown}`);
      };
      await page.waitFor(`document.querySelector('.c-cpu .big').textContent.startsWith('23')`, 'the sample drawn');
      await only('processes', 'processes');
      await page.waitFor(`document.querySelectorAll('.processes-page .proc').length === 12`, 'every row the PC sends is shown');
      await only('system', null);
      await page.waitFor(`document.querySelector('.system-page').textContent.includes('PC-TESTE')`, 'the system facts inline');
      await only('monitor', 'monitor');
    });

    await test('PC: leaving the page from each pane drops the subscription it had', async () => {
      for (const name of ['monitor', 'processes', 'system']) {
        await openPane(page, name);
        const before = await until(() => {
          const now = topicsNow();
          return name === 'system' ? now : now && now.includes(name) ? now : null;
        }, `${name}: subscribed`).catch(() => topicsNow());
        deck.model.calls.length = 0;
        await tapTab(page, 'apps');
        // leaving the page changes the subscription (the system pane has none to drop)
        const away = await until(() => {
          const now = topicsNow();
          return now && !now.includes('monitor') && !now.includes('processes') ? now : null;
        }, `${name}: the subscription dropped`, name === 'system' ? 1500 : 10000).catch(() => topicsNow());
        if (name !== 'system') {
          assert.ok(before && before.includes(name), `${name}: was subscribed before leaving (${before})`);
          assert.ok(away, `${name}: leaving the page did not change the subscription`);
        }
        assert.ok(!away || (!away.includes('monitor') && !away.includes('processes')), `${name} away: ${away}`);
        await tapTab(page, 'pc');
      }
      await openPane(page, 'monitor');
    });

    await test('PC > Desempenho: the five cards show the sample (levels, per-core bars, GPU name, drives, network)', async () => {
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
          fpsOn: document.querySelector('.c-fps').classList.contains('on'),
        };
      })()`);
      assert.strictEqual(info.cards, 5);
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
      assert.ok(info.sparks >= 2);
      assert.strictEqual(info.fpsOn, false, 'the frame-rate strip is hidden without a game');
    });

    await test('PC > Desempenho: a game shows its frame rate in the strip above the cards', async () => {
      const wide = await open(836, 387);
      try {
        deck.model.fps = { fps: 142, frameMs: 7, app: 'Jogo Teste', source: 'RTSS' };
        // a new answer arrives with the next push or poll: reopen the page so the sample carries the game
        await tapTab(wide, 'apps');
        await tapTab(wide, 'pc');
        await wide.waitFor(`document.querySelector('.c-fps').classList.contains('on')`, 'the strip', 8000);
        const strip = await wide.eval(`(() => ({ game: document.querySelector('.fps-game').textContent, title: document.querySelector('.fps-game').title, frame: document.querySelector('.fps-frame').textContent, big: document.querySelector('.c-fps .big').textContent, gaming: document.querySelector('.monitor-page').classList.contains('gaming') }))()`);
        assert.deepStrictEqual(strip, { game: 'Jogo Teste', title: 'Fonte: RTSS', frame: '7 ms', big: '142FPS', gaming: true });
      } finally {
        delete deck.model.fps;
      }
    });

    for (const scene of Object.keys(PC_SCENES)) {
      for (const [width, height] of [[836, 387], [740, 360], [411, 914], [360, 740], [844, 390], [390, 844]]) {
        await test(`PC (${scene}) ${width}x${height}: Desempenho, Processos and Sistema fit their cards, nothing overlaps or is cut, the selector is 48 px`, async () => {
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
              return { cards: cards.length, overlaps, cut, text, outside, rootScrolls: root.scrollHeight > root.clientHeight + 1, seg: Math.round(rect(document.querySelector('.pc-page .seg-btn')).height) };
            })()`);
            // Desempenho
            let info = await measure('monitor-page');
            assert.strictEqual(info.cards, 5, JSON.stringify(info));
            assert.deepStrictEqual({ o: info.overlaps, c: info.cut, t: info.text, out: info.outside }, { o: [], c: [], t: [], out: 0 }, JSON.stringify(info));
            assert.ok(info.seg >= 48, JSON.stringify(info));
            if (landscape) assert.strictEqual(info.rootScrolls, false, `landscape Desempenho must not scroll: ${JSON.stringify(info)}`);
            const kinds = await pcp.eval(`(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { cpuH: Math.round(r('.c-cpu').height), memH: Math.round(r('.c-mem').height), cols: getComputedStyle(document.querySelector('.perf-grid')).gridTemplateColumns.split(' ').length }; })()`);
            assert.strictEqual(kinds.cols, landscape ? 3 : 2);
            if (landscape) assert.ok(Math.abs(kinds.cpuH - kinds.memH) <= 2, `the CPU card is not the dominant one: ${JSON.stringify(kinds)}`);
            // Processos
            await openPane(pcp, 'processes');
            await pcp.waitFor(`document.querySelectorAll('.processes-page .proc').length === 12`, 'the processes');
            await sleep(300);
            info = await measure('processes-page');
            assert.deepStrictEqual({ o: info.overlaps, t: info.text, out: info.outside }, { o: [], t: [], out: 0 }, JSON.stringify(info));
            const rows = await pcp.eval(`[...document.querySelectorAll('.processes-page .proc')].map((e) => Math.round(e.getBoundingClientRect().height))`);
            assert.ok(rows.every((hh) => hh >= 40), JSON.stringify(rows));
            // Sistema
            await openPane(pcp, 'system');
            await pcp.waitFor(`document.querySelectorAll('.system-page .card').length === 8`, 'the system cards');
            await sleep(900);
            info = await measure('system-page');
            assert.deepStrictEqual({ o: info.overlaps, c: info.cut, out: info.outside }, { o: [], c: [], out: 0 }, `${scene} ${width}x${height} ${JSON.stringify(info)}`);
            if (landscape || height >= 900) assert.strictEqual(info.rootScrolls, false, `Sistema must not scroll here: ${JSON.stringify(info)}`);
            if (landscape) assert.strictEqual(await pcp.eval(`getComputedStyle(document.querySelector('.system-page')).gridTemplateColumns.split(' ').length`), 4);
          } finally {
            deck.model.drives = DEFAULT_DRIVES;
            deck.model.noGpu = false;
            if (pcp) pcp.close();
          }
        });
      }
    }

    await test('PC > Sistema: the facts are listed (uptime ticks, partitions under their disk) and, when the machine cannot be read, the pane says so', async () => {
      await openPane(page, 'system');
      await page.waitFor(`document.querySelectorAll('.system-page .card').length === 8`, 'the cards');
      const facts = await page.eval(`(() => ({
        titles: [...document.querySelectorAll('.system-page .card h3')].map((h) => h.textContent),
        windows: [...document.querySelectorAll('.system-page .kv')][0].textContent,
        uptime: [...document.querySelectorAll('.system-page .kv dt')].find((d) => d.textContent === 'Ligado há').nextSibling.textContent,
        disks: [...document.querySelectorAll('.system-page .disk')].map((d) => d.textContent),
      }))()`);
      assert.deepStrictEqual(facts.titles, ['Sistema', 'Monitores', 'Processador', 'Memória', 'Placa-mãe', 'Vídeo', 'Rede', 'Armazenamento']);
      assert.match(facts.windows, /ComputadorPC-TESTE/);
      assert.match(facts.windows, /Windows 11 Pro/);
      assert.match(facts.uptime, /min|h|d/);
      assert.strictEqual(facts.disks.length, 2, 'the physical disk, then one block for the partition without a known disk');
      assert.match(facts.disks[0], /NVMe de teste.*SSD · NVMe · 1 TB/);
      assert.match(facts.disks[1], /C: Sistema · NTFS/);
      deck.model.infoFails = true;
      const bad = await open(836, 387);
      try {
        await openPane(bad, 'system');
        await bad.waitFor(`document.querySelector('.system-page .loading')?.textContent.startsWith('Não foi possível')`, 'the error text');
      } finally {
        deck.model.infoFails = false;
        bad.close();
      }
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
