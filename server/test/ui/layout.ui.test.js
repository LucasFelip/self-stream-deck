'use strict';

// "Nothing overlaps": at a landscape (836x387) and a portrait (411x914) viewport, on every destination, the navigation
// (a rail on the left in landscape, a bar at the bottom in portrait), the status light, the menu button and the live strip
// must not run past the viewport or sit on top of each other or of the pages, the navigation targets must be at least 48 px,
// and the body must not scroll sideways. Two passes per viewport: a game running with the microphone on ("normal"), and the
// worst case with every live control on at once (power pill, camera, microphone, FPS). A third pass checks that the
// live strip gives its height back when nothing is on (landscape) and stays as the top row in portrait.
//
// Phase 2C: the settings menu is measured when open (portrait: bottom sheets over the bar, never under it and never over it); a 360x740 portrait viewport joins
// the two usual ones for the worst case.
//
// Strict by default: any violation fails the run (LAYOUT_STRICT=0 turns it back into a list of warnings, handy while
// working on a layout). Each group (status, tabs, menu, live controls) must have at least one measured element, so the test
// cannot pass empty if a redesign renames or moves the navigation.
// Skipped, not failed, when no Chromium-based browser is installed (set CHROME_PATH).
const { fakeDeck, launchBrowser, findBrowser, sleep } = require('./harness');

const STRICT = process.env.LAYOUT_STRICT !== '0';
const VIEWPORTS = [
  { name: 'paisagem', width: 836, height: 387, landscape: true },
  { name: 'retrato', width: 411, height: 914, landscape: false },
  { name: 'retrato estreito', width: 360, height: 740, landscape: false },
];
const SECTIONS = ['apps', 'shortcuts', 'windows', 'sound', 'pc', 'power'];
const TOUCH = 48;
const LIVE_TOUCH = 44; // the live strip's buttons and the menu button

// runs in the page: returns a list of violation strings for the destination currently on screen
const probe = (section, landscape, worst, narrow) => `(() => {
  const out = [];
  const box = (el) => el.getBoundingClientRect();
  const shown = (el) => { const r = box(el); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const name = (el) => { const cls = (el.getAttribute('class') || '').trim(); return el.id ? '#' + el.id : el.tagName.toLowerCase() + (cls ? '.' + cls.split(' ').join('.') : ''); };
  const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  const label = (el) => name(el) + (el.classList.contains('tab') && el.textContent.trim() ? ' "' + el.textContent.trim().slice(0, 12) + '"' : '');
  const pick = (sel) => [...document.querySelectorAll(sel)].filter(shown);
  const off = (r) => r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1 || r.top < -1;

  const nav = document.querySelector('nav.nav');
  const pager = document.getElementById('pager');
  const strip = document.getElementById('live-strip');
  const nb = box(nav);
  const pb = box(pager);

  // (a) the navigation, the strip and the pager stay inside the viewport
  for (const el of [nav, strip, pager, ...pick('.nav-status, .nav-end, #tabs')].filter((el) => el && shown(el))) {
    const r = box(el);
    if (off(r)) out.push('caixa: ' + name(el) + ' sai da tela (' + Math.round(r.left) + ',' + Math.round(r.top) + ' .. ' + Math.round(r.right) + ',' + Math.round(r.bottom) + ' em ' + innerWidth + 'x' + innerHeight + ')');
  }
  if (nav.scrollHeight > nav.clientHeight + 1 || nav.scrollWidth > nav.clientWidth + 1) out.push('nav: rola (' + nav.scrollWidth + 'x' + nav.scrollHeight + ' em ' + nav.clientWidth + 'x' + nav.clientHeight + ')');

  // (b) the groups: a child that spills out of its own box is invisible to the box checks above, so measure the children
  const groups = [
    ['status', pick('.nav-status .glyph, #status')],
    ['abas', pick('#tabs .tab')],
    ['menu', pick('#menu')],
    ['ativos', pick('#live-strip > *')],
  ];
  for (const [group, members] of groups) if (!members.length) out.push('nav: grupo ' + group + ' sem nenhum elemento medido');
  for (let gi = 0; gi < groups.length; gi += 1) for (let gj = gi + 1; gj < groups.length; gj += 1) {
    for (const a of groups[gi][1]) for (const b of groups[gj][1]) {
      if (hit(box(a), box(b))) out.push('nav: ' + label(a) + ' sobrepoe ' + label(b));
    }
  }
  for (const [, members] of groups) for (const el of members) {
    if (off(box(el))) out.push('nav: ' + label(el) + ' sai da tela');
  }
  // siblings inside a group (the strip's buttons, the tabs) must not touch each other either
  for (const [group, members] of groups) for (let i = 0; i < members.length; i += 1) for (let j = i + 1; j < members.length; j += 1) {
    if (hit(box(members[i]), box(members[j]))) out.push('nav: ' + group + ': ' + label(members[i]) + ' sobrepoe ' + label(members[j]));
  }
  // a label cut with "..." is a layout bug too (the rail is narrow)
  // (the power pill is the one thing that may give up text, with an ellipsis, in the narrowest screen's worst case; never its 44 px)
  for (const el of pick('.tab-label, #power-pill')) if (!(${narrow} && el.id === 'power-pill') && el.scrollWidth > el.clientWidth + 1) out.push('texto cortado: ' + label(el) + ' (' + el.scrollWidth + ' > ' + el.clientWidth + ')');

  // (c) the pages are not covered by the rail / bar / strip, and the navigation sits on the right side for the orientation
  if (hit(nb, pb)) out.push('conteudo: #pager sobrepoe a navegacao');
  if (shown(strip) && hit(box(strip), pb)) out.push('conteudo: #pager sobrepoe a faixa de ativos');
  if (${landscape}) {
    if (nb.left > 1 || pb.left < nb.right - 1) out.push('paisagem: a navegacao deveria ficar a esquerda (nav ' + Math.round(nb.left) + '..' + Math.round(nb.right) + ', pager.left ' + Math.round(pb.left) + ')');
  } else if (nb.bottom < innerHeight - 1 || pb.bottom > nb.top + 1) {
    out.push('retrato: a navegacao deveria ficar embaixo (nav.top ' + Math.round(nb.top) + ', nav.bottom ' + Math.round(nb.bottom) + ', pager.bottom ' + Math.round(pb.bottom) + ')');
  }

  // (d) touch targets of the destinations: at least ${TOUCH} px on both axes
  for (const tab of pick('#tabs .tab')) {
    const r = box(tab);
    if (Math.round(r.width) < ${TOUCH} || Math.round(r.height) < ${TOUCH}) out.push('alvo: ' + label(tab) + ' mede ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' (minimo ${TOUCH})');
  }

  // (d2) the live strip's buttons and the menu button: at least ${LIVE_TOUCH} px on both axes (the pills are buttons too: they
  // keep a smaller look, but the button itself, which is what takes the finger, is ${LIVE_TOUCH} px tall)
  for (const el of [...pick('#live-strip > button'), ...pick('#menu')]) {
    const r = box(el);
    if (Math.round(r.width) < ${LIVE_TOUCH} || Math.round(r.height) < ${LIVE_TOUCH}) out.push('alvo: ' + label(el) + ' mede ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' (minimo ${LIVE_TOUCH})');
  }

  // (d3) the volume button and panel are gone from every page
  if (document.getElementById('vol-btn') || document.getElementById('volume-panel')) out.push('volume: #vol-btn / #volume-panel nao deveriam existir');
  if (${worst} && ${narrow}) {
    const pill = document.getElementById('power-pill');
    if (pill && Math.round(box(pill).width) < 56) out.push('pior caso: a pilula de energia ficou menor que 56 px (' + Math.round(box(pill).width) + ')');
  }

  // (e) the FPS pill lives in the live strip (the group check covers it); it must be there outside PC > Desempenho
  const fps = document.querySelector('#fps');
  if (${JSON.stringify(section)} !== 'pc' &&!(fps && !fps.hidden && shown(fps))) out.push('fps: pilula nao apareceu');
  if (${worst}) {
    for (const id of ['power-pill', 'cam', 'mic', 'fps']) {
      const el = document.getElementById(id);
      if (!(el && !el.hidden && shown(el)) && !(id === 'fps' && ${JSON.stringify(section)} === 'pc')) out.push('pior caso: #' + id + ' nao esta visivel');
    }
  }

  // (e2) Energia: the actions are keys (>= 44 px, none on another, no label or status text cut) and the page does not scroll inside
  if (${JSON.stringify(section)} === 'power') {
    const page = document.querySelector('.power-page');
    const keys = [...page.querySelectorAll('.actions-grid > .tile')].filter(shown);
    if (keys.length !== 7) out.push('energia: esperava 7 teclas, ha ' + keys.length);
    for (const key of keys) {
      const r = box(key);
      if (Math.round(r.width) < ${LIVE_TOUCH} || Math.round(r.height) < ${LIVE_TOUCH}) out.push('energia: tecla "' + key.textContent.trim() + '" mede ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' (minimo ${LIVE_TOUCH})');
      const label = key.querySelector(':scope > span');
      if (label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1) out.push('texto cortado: tecla "' + label.textContent + '"');
      const icon = key.querySelector('.fallback').getBoundingClientRect();
      if (icon.bottom > r.bottom || icon.top < r.top || box(label).top < icon.bottom - 1) out.push('energia: icone e nome da tecla "' + label.textContent + '" nao cabem');
      const pb2 = box(page);
      if (r.bottom > pb2.bottom + 1 || r.right > pb2.right + 1) out.push('energia: tecla "' + label.textContent + '" sai da pagina');
    }
    const blocks = [...keys, ...page.querySelectorAll('.power-status, .schedule')].filter(shown);
    for (let i = 0; i < blocks.length; i += 1) for (let j = i + 1; j < blocks.length; j += 1) if (hit(box(blocks[i]), box(blocks[j]))) out.push('energia: ' + label(blocks[i]) + ' sobrepoe ' + label(blocks[j]));
    const status = page.querySelector('.power-status');
    if (status.scrollWidth > status.clientWidth + 1 || Math.round(box(status).height) > 44) out.push('energia: a linha de estado nao cabe numa linha (' + status.scrollWidth + ' > ' + status.clientWidth + ', h ' + Math.round(box(status).height) + ')');
    if (page.scrollHeight > page.clientHeight + 1 || page.scrollWidth > page.clientWidth + 1) out.push('energia: a pagina rola por dentro (' + page.scrollWidth + 'x' + page.scrollHeight + ' em ' + page.clientWidth + 'x' + page.clientHeight + ')');
    if (page.querySelector('.act')) out.push('energia: sobrou um cartao .act antigo');
  }

  // (f) no sideways scroll
  if (document.body.scrollWidth > document.body.clientWidth) out.push('body: scrollWidth ' + document.body.scrollWidth + ' > clientWidth ' + document.body.clientWidth);
  return out;
})()`;

// the open menu: a popover beside the rail (8 px from the edges) in landscape, a bottom sheet right over the bar in portrait; rows of 48 px
const menuProbe = (landscape) => `(async () => {
  const out = [];
  document.getElementById('menu').click();
  await new Promise((resolve) => setTimeout(resolve, 350));
  const pop = document.getElementById('menu-pop');
  const nav = document.querySelector('nav.nav').getBoundingClientRect();
  const r = pop.getBoundingClientRect();
  const where = Math.round(r.left) + ',' + Math.round(r.top) + ' .. ' + Math.round(r.right) + ',' + Math.round(r.bottom) + ' em ' + innerWidth + 'x' + innerHeight;
  if (pop.hidden || !r.width) out.push('menu: nao abriu');
  else if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) out.push('menu: #menu-pop sai da tela (' + where + ')');
  else if (${landscape}) {
    if (innerHeight - r.bottom < 8 || innerWidth - r.right < 8 || r.top < 8) out.push('menu: #menu-pop colado na borda (folga minima 8 px; ' + where + ')');
    if (r.left < nav.right - 1) out.push('menu: #menu-pop cobre o trilho (' + where + ')');
  } else {
    if (r.left > 1 || r.right < innerWidth - 1) out.push('menu: em retrato deveria ocupar a largura toda (' + where + ')');
    if (Math.abs(r.bottom - nav.top) > 1) out.push('menu: em retrato deveria ficar logo acima da barra (bottom ' + Math.round(r.bottom) + ', barra.top ' + Math.round(nav.top) + ')');
    if (getComputedStyle(pop).borderTopLeftRadius === '0px') out.push('menu: o sheet deveria ter os cantos de cima arredondados');
    if (getComputedStyle(pop.querySelector('.grip')).display === 'none') out.push('menu: o sheet deveria ter a alca');
  }
  const rows = [...pop.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().height > 0);
  if (rows.length < 2) out.push('menu: poucos itens medidos (' + rows.length + ')');
  for (const row of rows) if (Math.round(row.getBoundingClientRect().height) < 48) out.push('menu: item "' + row.textContent.trim() + '" mede ' + Math.round(row.getBoundingClientRect().height) + ' px (minimo 48)');
  if (document.getElementById('menu').getAttribute('aria-label') !== 'Configurações') out.push('menu: o botao deveria se chamar Configurações');
  document.getElementById('menu').click();
  return out;
})()`;

(async () => {
  if (!findBrowser()) {
    console.log('skipped (no Chrome, Brave or Edge found; set CHROME_PATH)');
    return;
  }
  const violations = [];
  const record = (viewport, pass, section, found) => {
    for (const message of found) violations.push(`${viewport.name} ${viewport.width}x${viewport.height} / ${pass} / ${section}: ${message}`);
    console.log(`${found.length ? 'viol  ' : 'ok    '} ${viewport.name} / ${pass} / ${section}`);
  };
  const deck = await fakeDeck();
  try {
    for (const viewport of VIEWPORTS) {
      const browser = await launchBrowser({ width: viewport.width, height: viewport.height });
      try {
        for (const worst of [false, true]) {
          const pass = worst ? 'pior caso' : 'normal';
          deck.model.fps = { fps: 60, frameMs: 16.6, app: 'Jogo' };
          deck.model.state.scheduled = worst ? { action: 'advanced', inSec: 5 * 3600 } : null;
          deck.model.state.playing = null;
          const page = await browser.open(`${deck.url}/`);
          await page.waitFor(`document.querySelectorAll('#tabs .tab').length >= ${SECTIONS.length}`, 'the tabs');
          // the game is already running when the page opens: the FPS may arrive before the pages exist (that race is handled by game.js)
          await page.waitFor(`document.querySelector('#fps b').textContent === '60'`, 'the fps from the fake game');
          await page.waitFor("document.querySelector('#tabs .tab[data-section=pc]').getAttribute('aria-selected') === 'true'", 'the deck to slide to PC > Desempenho');
          if (worst) {
            await page.waitFor(`!document.getElementById('power-pill').hidden `, 'the power pill');
            await page.eval(`document.getElementById('cam').hidden = false`); // the camera is only "live" while the phone sends it
          }
          await sleep(500);
          for (const section of SECTIONS) {
            // the game slides the deck to Desempenho by itself; give that a moment, then go where we want
            await page.eval(`document.querySelector('#tabs .tab[data-section="${section}"]').click()`);
            await page.waitFor(`document.querySelector('#tabs .tab[data-section="${section}"]').getAttribute('aria-selected') === 'true'`, `${section} tab selected`);
            await sleep(900); // the slide, and the page's first render
            if (section !== 'pc') await page.waitFor("!document.querySelector('#fps').hidden", 'the fps pill', 3000).catch(() => {}); // missing pill is reported by the probe
            record(viewport, pass, section, await page.eval(probe(section, viewport.landscape, worst, viewport.width < 400)));
          }
          record(viewport, pass, 'menu aberto', await page.eval(menuProbe(viewport.landscape)));
          page.close();
        }

        // the strip is always there (44 px): a live button showing / hiding (the microphone) must not change the pager's
        // height or rebuild the tiles (that blinks); a rotation must rebuild them (other cols x rows)
        if (viewport.landscape) {
          deck.model.fps = null;
          deck.model.state.scheduled = null;
          deck.model.state.playing = null;
          deck.model.state.mic = { available: true, muted: false };
          const stable = await browser.open(`${deck.url}/`);
          await stable.waitFor(`document.querySelectorAll('#tabs .tab').length >= ${SECTIONS.length} && document.querySelector('.tile') && !document.getElementById('mic').hidden`, 'the tiles and the mic');
          await sleep(600);
          await stable.eval(`window.__tile = document.querySelector('.tile'); window.__pagerH = document.getElementById('pager').getBoundingClientRect().height; window.__cols = document.querySelector('.grid').style.getPropertyValue('--cols'); true`);
          await stable.eval(`document.getElementById('mic').hidden = true`);
          await sleep(500); // the observer waits 120 ms
          const toggled = await stable.eval(`({ same: window.__tile === document.querySelector('.tile') && window.__tile.isConnected, grew: document.getElementById('pager').getBoundingClientRect().height - window.__pagerH })`);
          const hide = [];
          if (Math.abs(toggled.grew) > 1) hide.push(`faixa: ocultar o mic mudou a altura do pager (${JSON.stringify(toggled)}); a faixa agora e fixa`);
          if (!toggled.same) hide.push('faixa: ocultar o mic recriou os tiles (a grade piscaria)');
          await stable.eval(`document.getElementById('mic').hidden = false`);
          await sleep(500);
          if (!(await stable.eval(`window.__tile === document.querySelector('.tile') && window.__tile.isConnected`))) hide.push('faixa: mostrar o mic recriou os tiles (a grade piscaria)');
          await stable.setViewport(411, 914);
          await sleep(600);
          if (await stable.eval(`window.__tile === document.querySelector('.tile') && window.__tile.isConnected`)) hide.push('rotacao: mudou cols x rows mas os tiles nao foram refeitos');
          if (await stable.eval(`document.querySelector('.grid').style.getPropertyValue('--cols')`) === await stable.eval('window.__cols')) hide.push('rotacao: a grade continuou com as mesmas colunas');
          record(viewport, 'faixa x pager', 'apps', hide);
          stable.close();
        }

        // nothing on: the strip must not cost landscape any height; in portrait it stays as the row of the status light and the menu
        deck.model.fps = null;
        deck.model.state.scheduled = null;
        deck.model.state.playing = null;
        deck.model.state.mic = { available: false, muted: false };
        const bare = await browser.open(`${deck.url}/`);
        await bare.waitFor(`document.querySelectorAll('#tabs .tab').length >= ${SECTIONS.length}`, 'the tabs');
        await sleep(600);
        const strip = await bare.eval(`(() => { const s = document.getElementById('live-strip'); return { hidden: s.hidden, height: s.getBoundingClientRect().height, visible: [...s.children].filter((c) => c.getBoundingClientRect().width > 0).length, pagerTop: document.getElementById('pager').getBoundingClientRect().top }; })()`);
        const found = [];
        // nothing else on: the strip stays 44 px but empty, in both orientations
        if (strip.hidden) found.push('faixa de ativos: nao deveria estar hidden');
        if (Math.round(strip.height) !== 44) found.push(`faixa de ativos: deveria ter 44 px vazia (${JSON.stringify(strip)})`);
        if (strip.visible !== 0) found.push(`faixa de ativos: deveria estar vazia (${JSON.stringify(strip)})`);
        record(viewport, 'sem ativos', 'apps', found);
        deck.model.state.mic = { available: true, muted: false };
        bare.close();
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
