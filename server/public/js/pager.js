'use strict';

/**
 * The pager (swipe between pages), the generated Apps / Shortcuts pages that fit the real screen, the section tabs and
 * "which page am I on". The other pages live in js/*.js and register themselves with Deck.addPage().
 */
(() => {
  const { $, h } = Deck;

  const pager = $('pager');
  const tabs = $('tabs');
  const volumeHolder = $('volume-holder');
  const volumeBox = $('volume');

  const PAGE_PADDING_X = 16;
  const PAGE_PADDING_Y = 12;
  const GAP = 10;
  const MIN_TILE_H = 96;
  const TILE_ASPECT = 1.1; // keys are roughly square, like a real deck
  const TILE_CHROME = 50; // vertical space a tile spends on padding, gap and the two-line label

  // Fit a fixed grid to the real screen: as many rows as the height allows, then as many roughly
  // square columns as the width allows. Also returns how big the icons can be inside those tiles.
  // the camera cut-out / bars the pages keep clear of (style.css, --safe-*): the grid is fitted to what is left
  const safe = (name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;

  function measure() {
    const width = pager.clientWidth - 2 * PAGE_PADDING_X - safe('--safe-left') - safe('--safe-right');
    const height = pager.clientHeight - 2 * PAGE_PADDING_Y - safe('--safe-bottom');
    const rows = Math.max(1, Math.floor((height + GAP) / (MIN_TILE_H + GAP)));
    const tileH = (height - (rows - 1) * GAP) / rows;
    const cols = Math.max(2, Math.round((width + GAP) / (tileH * TILE_ASPECT + GAP)));
    const tileW = (width - (cols - 1) * GAP) / cols;
    const icon = Math.max(32, Math.min(64, tileW - 24, tileH - TILE_CHROME));
    return { cols, rows, icon };
  }

  function buildPage(id, title, part, sectionId) {
    const page = document.createElement('section');
    page.className = 'page generated';
    page.dataset.section = sectionId;
    page.dataset.id = id;
    page.dataset.title = title;
    if (part) page.dataset.part = part;
    return page;
  }

  function buildPages() {
    const { cols, rows, icon } = measure();
    const perPage = cols * rows;
    pager.style.setProperty('--icon', `${icon}px`);

    const pages = [];
    for (const [key, section] of Object.entries(Deck.tiles.sections)) {
      // The volume strip takes the last row of the first shortcuts page, so shortcuts and sound share one page.
      const footer = key === 'shortcuts' ? volumeBox : null;
      // the same page also carries the open windows: the last columns of its first page belong to that list
      const side = footer && Deck.windowsUi && cols >= 5 ? 2 : 0;
      const firstCols = cols - side;
      const firstPageCapacity = footer ? firstCols * (rows - 1) : perPage;

      if (section.items.length === 0 && !footer) {
        if (key === 'apps') {
          const page = buildPage(`${key}-0`, section.title, '', key);
          page.innerHTML = '<p class="empty">Nenhum app encontrado na barra de tarefas.</p>';
          pages.push(page);
        }
        continue;
      }

      const overflow = Math.max(0, section.items.length - firstPageCapacity);
      const count = 1 + Math.ceil(overflow / perPage);
      for (let index = 0; index < count; index += 1) {
        const start = index === 0 ? 0 : firstPageCapacity + (index - 1) * perPage;
        const capacity = index === 0 ? firstPageCapacity : perPage;
        const hasFooter = footer && index === 0;

        const title = hasFooter ? (side ? 'Atalhos' : 'Atalhos e som') : section.title;
        const page = buildPage(`${key}-${index}`, title, count > 1 ? `${index + 1}/${count}` : '', key);
        const grid = document.createElement('div');
        grid.className = 'grid';
        grid.style.setProperty('--cols', hasFooter ? firstCols : cols);
        grid.style.setProperty('--rows', rows);

        const tiles = section.items.slice(start, start + capacity).map(Deck.tiles.makeTile);
        // unused positions stay visible as faint slots, so every page keeps the same grid
        const slots = Array.from({ length: capacity - tiles.length }, () => Object.assign(document.createElement('div'), { className: 'slot' }));
        grid.append(...tiles, ...slots);
        if (hasFooter) grid.append(footer);

        if (hasFooter && side) {
          const split = document.createElement('div');
          split.className = 'split';
          split.style.setProperty('--total', cols);
          split.style.setProperty('--first', firstCols);
          split.style.setProperty('--side', side);
          split.append(grid, Deck.windowsUi.list);
          page.append(split);
        } else {
          page.append(grid);
        }
        pages.push(page);
      }
    }
    return pages;
  }

  // --- section tabs ---------------------------------------------------------------------------
  // The pager is one flat row of pages, but people think in a few places. A tab jumps straight to a place
  // (remembering the page you last had open there); tapping the active tab goes to its next page; the dots
  // under the active tab show where you are inside it. Swiping still walks through every page in order.

  const SECTIONS = [
    { id: 'apps', label: 'Apps', icon: 'grid' },
    { id: 'shortcuts', label: 'Atalhos', icon: 'keys' },
    { id: 'sound', label: 'Som', icon: 'speaker' },
    { id: 'monitor', label: 'Desempenho', icon: 'chip' },
    { id: 'power', label: 'Energia', icon: 'power' },
    { id: 'processes', label: 'Processos', icon: 'list' },
  ];
  const lastPageIn = {}; // section id -> id of the page last seen there

  // pages owned by modules: same pager, built once, kept alive across layout rebuilds
  function modulePages() {
    const order = (def) => SECTIONS.findIndex((section) => section.id === (def.section || def.id));
    return [...Deck.pages].sort((x, y) => order(x) - order(y)).map((def) => {
      def.el.classList.add('page');
      def.el.dataset.section = def.section || def.id;
      def.el.dataset.id = def.id;
      def.el.dataset.title = def.title;
      return def.el;
    });
  }

  const allPages = () => [...pager.querySelectorAll('.page')];
  const currentIndex = () => Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
  const pageId = (page) => page.dataset.id;
  const sectionOf = (page) => page.dataset.section;
  const pagesOf = (sectionId) => allPages().filter((page) => sectionOf(page) === sectionId);

  function goTo(index, smooth = true) {
    pager.scrollTo({ left: index * pager.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
  }

  // A jump asked for by id that has not arrived yet: a rebuild of the pages (render) in the middle of the slide must
  // aim at it, not at the page we were on, or it would cancel the slide.
  let pendingId = null;

  /** Returns false when there is no such page (yet), so a caller can try again later. */
  function goToId(id) {
    const index = allPages().findIndex((page) => page.dataset.id === id);
    if (index === -1) return false;
    pendingId = id;
    goTo(index);
    return true;
  }

  function openSection(sectionId) {
    const pages = pagesOf(sectionId);
    const current = allPages()[currentIndex()];
    const target = current && sectionOf(current) === sectionId
      ? pages[(pages.indexOf(current) + 1) % pages.length]
      : pages.find((page) => pageId(page) === lastPageIn[sectionId]) || pages[0];
    if (target) goTo(allPages().indexOf(target));
  }

  function renderTabs() {
    tabs.replaceChildren(
      ...SECTIONS.filter((section) => pagesOf(section.id).length).map((section) => h(
        'button',
        { type: 'button', class: 'tab', role: 'tab', 'aria-selected': 'false', data: { section: section.id }, on: { click: () => openSection(section.id) } },
        Deck.icon(section.icon),
        h('span', { class: 'tab-label', text: section.label }),
        h('span', { class: 'tab-dots' }),
      )),
    );
    updateNav();
  }

  // The page the user is on, remembered by id. Reading it back from scrollLeft after the DOM changed
  // would be wrong: the browser may have re-snapped to a different page in the meantime.
  let currentId = null;

  // show/hide hooks of the pages (their own polling starts and stops with them): from addPage and from Deck.lifecycle
  const hooks = () => [...Deck.pages, ...Object.entries(Deck.lifecycle).map(([id, hook]) => ({ id, ...hook }))];

  function notifyPages(previous, current) {
    for (const def of hooks()) {
      if (def.id === previous && def.hide) def.hide();
      if (def.id === current && def.show) def.show();
    }
  }

  function updateNav() {
    const pages = allPages();
    const index = Math.min(currentIndex(), pages.length - 1);
    const page = pages[index];
    if (page && currentId !== pageId(page)) {
      const previous = currentId;
      currentId = pageId(page);
      if (pendingId === currentId) pendingId = null;
      notifyPages(previous, currentId);
    }
    if (!page) return;

    const activeSection = sectionOf(page);
    lastPageIn[activeSection] = pageId(page);
    tabs.querySelectorAll('.tab').forEach((tab) => {
      const active = tab.dataset.section === activeSection;
      const section = SECTIONS.find((candidate) => candidate.id === tab.dataset.section);
      const sectionPages = pagesOf(tab.dataset.section);
      const nested = active && sectionPages.length > 1;

      tab.setAttribute('aria-selected', String(active));
      // inside a section with several pages the tab names the page you are on ("Desempenho 1/3")
      tab.querySelector('.tab-label').textContent = nested ? [page.dataset.title, page.dataset.part].filter(Boolean).join(' ') : section.label;
      tab.querySelector('.tab-dots').replaceChildren(...(nested ? sectionPages.map((candidate) => h('i', { class: candidate === page ? 'on' : '' })) : []));
    });
  }

  // Rebuild the generated pages and stay on the same one, so a rotation or a refresh doesn't jump back to page 1.
  function render() {
    if (!pager.clientWidth) return;

    // snapping is paused while the pages change, otherwise the browser re-snaps to the old snap target
    pager.style.scrollSnapType = 'none';
    volumeHolder.append(volumeBox); // keep the volume strip (and its state) out of the pages being thrown away
    pager.replaceChildren(...buildPages(), ...modulePages());

    const keep = allPages().findIndex((page) => pageId(page) === (pendingId || currentId));
    goTo(keep === -1 ? 0 : keep, false);
    renderTabs();
    Deck.pc.paint();
    Deck.game.pagesReady();
    requestAnimationFrame(() => { pager.style.scrollSnapType = ''; });
  }

  // the person takes over: whatever slide was pending is forgotten
  pager.addEventListener('touchstart', () => { pendingId = null; }, { passive: true });

  let scrollFrame;
  pager.addEventListener('scroll', () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(updateNav);
  }, { passive: true });

  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  }).observe(pager);

  Deck.pager = {
    render,
    goToId,
    // the show/hide hook of the page on screen, if it has one (connection.js pauses it with the screen)
    // the section (apps, shortcuts, sound...) of the page on screen, for Deck.back()
    currentSection: () => { const page = allPages()[currentIndex()]; return page ? sectionOf(page) : null; },
    activeHook: () => hooks().find((def) => def.id === currentId),
  };
  Deck.goTo = goToId; // modules can ask to jump to a page
})();
