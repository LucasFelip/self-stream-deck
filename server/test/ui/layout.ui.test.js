'use strict';

// "Nothing overlaps": at a landscape (836x387) and a portrait (411x914) viewport, on every destination, the bar elements
// must not run past the viewport or sit on top of each other, the FPS pill (in the header's actions) must show outside Desempenho, and the body must not scroll sideways. A game is faked (already running at load) so the pill is on screen.
//
// Strict by default: any violation fails the run (LAYOUT_STRICT=0 turns it back into a list of warnings, handy while
// working on a layout). Each header group (host, tabs, actions) must also have at least one measured element, so the test
// cannot pass empty if a redesign renames or moves the navigation.
// Skipped, not failed, when no Chromium-based browser is installed (set CHROME_PATH).
const { fakeDeck, launchBrowser, findBrowser, sleep } = require('./harness');

const STRICT = process.env.LAYOUT_STRICT !== '0';
const VIEWPORTS = [
  { name: 'paisagem', width: 836, height: 387 },
  { name: 'retrato', width: 411, height: 914 },
];
const SECTIONS = ['apps', 'shortcuts', 'sound', 'monitor', 'power', 'processes'];

// runs in the page: returns a list of violation strings for the destination currently on screen
const probe = (section) => `(() => {
  const out = [];
  const box = (el) => el.getBoundingClientRect();
  const shown = (el) => { const r = box(el); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const name = (el) => { const cls = (el.getAttribute('class') || '').trim(); return el.id ? '#' + el.id : el.tagName.toLowerCase() + (cls ? '.' + cls.split(' ').join('.') : ''); };
  const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

  // (a) the bar: nothing past the viewport, and siblings do not overlap
  const bar = ['header', '#tabs', '.actions', '.host'].map((s) => document.querySelector(s)).filter((el) => el && shown(el));
  for (const el of bar) {
    const r = box(el);
    if (r.right > innerWidth + 1 || r.left < -1) out.push('bar: ' + name(el) + ' sai da largura (' + Math.round(r.left) + '..' + Math.round(r.right) + ' de ' + innerWidth + ')');
  }
  const row = ['.host', '#tabs', '.actions'].map((s) => document.querySelector(s)).filter((el) => el && shown(el));
  for (let i = 0; i < row.length; i += 1) for (let j = i + 1; j < row.length; j += 1) {
    if (hit(box(row[i]), box(row[j]))) out.push('bar: ' + name(row[i]) + ' sobrepoe ' + name(row[j]));
  }
  // the bar's children, by group: a child that spills out of its own box (the .host column shrinks to 1px in portrait and
  // its glyph/status overflow onto the tabs) is invisible to the box checks above, so measure the children themselves
  const pick = (sel) => [...document.querySelectorAll(sel)].filter(shown);
  const groups = [
    ['host', [...pick('.host .glyph'), ...pick('#status'), ...pick('.host .host-name')]],
    ['abas', pick('#tabs .tab')],
    ['acoes', pick('.actions .icon-btn, .actions .pill, .actions .fps-float')],
  ];
  for (const [group, members] of groups) if (!members.length) out.push('bar: grupo ' + group + ' sem nenhum elemento medido');
  const label = (el) => name(el) + (el.classList.contains('tab') && el.textContent.trim() ? ' "' + el.textContent.trim().slice(0, 12) + '"' : '');
  const hostEl = document.querySelector('.host');
  if (hostEl && shown(hostEl)) {
    const hb = box(hostEl);
    for (const el of groups[0][1]) if (box(el).right > hb.right + 1) out.push('bar: ' + name(el) + ' sai da caixa de .host (' + Math.round(box(el).left) + '..' + Math.round(box(el).right) + ' de ' + Math.round(hb.left) + '..' + Math.round(hb.right) + ')');
  }
  for (let gi = 0; gi < groups.length; gi += 1) for (let gj = gi + 1; gj < groups.length; gj += 1) {
    for (const a of groups[gi][1]) for (const b of groups[gj][1]) {
      if (hit(box(a), box(b))) out.push('bar: ' + label(a) + ' sobrepoe ' + label(b));
    }
  }

  // (b) the FPS pill lives in the header's actions (so the group check above covers it); it must be there outside Desempenho
  const pill = document.querySelector('#fps');
  if (${JSON.stringify(section)} !== 'monitor' && !(pill && !pill.hidden && shown(pill))) out.push('fps: pilula nao apareceu');

  // (c) no sideways scroll
  if (document.body.scrollWidth > document.body.clientWidth) out.push('body: scrollWidth ' + document.body.scrollWidth + ' > clientWidth ' + document.body.clientWidth);
  return out;
})()`;

(async () => {
  if (!findBrowser()) {
    console.log('skipped (no Chrome, Brave or Edge found; set CHROME_PATH)');
    return;
  }
  const violations = [];
  const deck = await fakeDeck();
  try {
    for (const viewport of VIEWPORTS) {
      deck.model.fps = { fps: 60, frameMs: 16.6, app: 'Jogo' };
      const browser = await launchBrowser({ width: viewport.width, height: viewport.height });
      try {
        const page = await browser.open(`${deck.url}/`);
        await page.waitFor(`document.querySelectorAll('#tabs .tab').length >= ${SECTIONS.length}`, 'the tabs');
        // the game is already running when the page opens: the FPS may arrive before the pages exist (that race is handled by game.js)
        await page.waitFor(`document.querySelector('#fps b').textContent === '60'`, 'the fps from the fake game');
        await page.waitFor("document.querySelector('#tabs .tab[data-section=monitor]').getAttribute('aria-selected') === 'true'", 'the deck to slide to Desempenho');
        await sleep(500);
        for (const section of SECTIONS) {
          // the game slides the deck to Desempenho by itself; give that a moment, then go where we want
          await page.eval(`document.querySelector('#tabs .tab[data-section="${section}"]').click()`);
          await page.waitFor(`document.querySelector('#tabs .tab[data-section="${section}"]').getAttribute('aria-selected') === 'true'`, `${section} tab selected`);
          await sleep(900); // the slide, and the page's first render
          if (section !== 'monitor') await page.waitFor("!document.querySelector('#fps').hidden", 'the fps pill', 3000).catch(() => {}); // missing pill is reported by the probe
          const found = await page.eval(probe(section));
          for (const message of found) violations.push(`${viewport.name} ${viewport.width}x${viewport.height} / ${section}: ${message}`);
          console.log(`${found.length ? 'viol  ' : 'ok    '} ${viewport.name} / ${section}`);
        }
      } finally {
        browser.close();
      }
    }
  } finally {
    deck.close();
  }
  if (violations.length) {
    console.log(`\n${violations.length} violation(s):`);
    for (const v of violations) console.log(`  - ${v}`);
    if (STRICT) process.exit(1);
    console.log('(warning only: LAYOUT_STRICT=0)');
  } else {
    console.log('no overlaps');
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
