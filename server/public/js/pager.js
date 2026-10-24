'use strict';

/**
 * The pager (swipe between pages), the generated Apps / Shortcuts pages that fit the real screen, the section tabs and
 * "which page am I on". The other pages live in js/*.js and register themselves with Deck.addPage().
 */
(() => {
  const { $, h } = Deck;

  const pager = $('pager');
  const tabs = $('tabs');
  const dots = $('page-dots');

  const PAGE_PADDING_X = 16;
  const PAGE_PADDING_Y = 12;
  const GAP = 10;
  const MIN_TILE_H = 96;
  const TILE_ASPECT = 1.1; // keys are roughly square, like a real deck
  const TILE_CHROME = 50; // vertical space a tile spends on padding, gap and the two-line label

  // Fit a fixed grid to the real screen: as many rows as the height allows, then as many roughly
  // square columns as the width allows. Also returns how big the icons can be inside those tiles.
  // the camera cut-out / bars the pages keep clear of (style.css, --safe-*): the grid is fitted to what is left.
  // Read from the pager, not the root: the rail / bar already covers its side, so .main zeroes that inset.
  const safe = (name) => parseFloat(getComputedStyle(pager).getPropertyValue(name)) || 0;

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

  // the grid the pages were last built for: the pages only depend on cols and rows (the icon size is a CSS variable)
  let built = null;

  function buildPages() {
    const { cols, rows, icon } = measure();
    const perPage = cols * rows;
    pager.style.setProperty('--icon', `${icon}px`);
    built = { cols, rows };

    const pages = [];
    for (const [key, section] of Object.entries(Deck.tiles.sections)) {
      // Atalhos has the whole grid (the volume lives in its own panel, opened from the live strip)
      if (section.items.length === 0) {
        if (key === 'apps' || key === 'shortcuts') {
          const page = buildPage(`${key}-0`, section.title, '', key);
          page.innerHTML = `<p class="empty">${key === 'apps' ? 'Nenhum app encontrado na barra de tarefas.' : 'Nenhum atalho configurado.'}</p>`;
          pages.push(page);
        }
        continue;
      }

      const count = Math.ceil(section.items.length / perPage);
      for (let index = 0; index < count; index += 1) {
        const page = buildPage(`${key}-${index}`, section.title, count > 1 ? `${index + 1}/${count}` : '', key);
        const grid = document.createElement('div');
        grid.className = 'grid';
        grid.style.setProperty('--cols', cols);
        grid.style.setProperty('--rows', rows);

        const tiles = section.items.slice(index * perPage, (index + 1) * perPage).map(Deck.tiles.makeTile);
        // unused positions stay visible as faint slots, so every page keeps the same grid
        const slots = Array.from({ length: perPage - tiles.length }, () => Object.assign(document.createElement('div'), { className: 'slot' }));
        grid.append(...tiles, ...slots);
        page.append(grid);
        pages.push(page);
      }
    }
    return pages;
  }

  // --- section tabs ---------------------------------------------------------------------------
  // The pager is one flat row of pages, but people think in a few places. A tab jumps straight to a place
  // (remembering the page you last had open there); tapping the active tab goes back to the start of its section;
  // the dots over the bottom of the pages (#page-dots) show where you are inside a section with several pages.
  // Swiping still walks through every page in order.

  const SECTIONS = [
    { id: 'apps', label: 'Apps', icon: 'grid' },
    { id: 'shortcuts', label: 'Atalhos', icon: 'keys' },
    { id: 'windows', label: 'Janelas', icon: 'windows' },
    { id: 'sound', label: 'Som', icon: 'speaker' },
    { id: 'pc', label: 'PC', icon: 'pc' },
    { id: 'power', label: 'Energia', icon: 'power' },
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
    // already in this section: back to its first page (nothing to do if we are there); coming from elsewhere: where we left it
    const target = current && sectionOf(current) === sectionId
      ? pages[0]
      : pages.find((page) => pageId(page) === lastPageIn[sectionId]) || pages[0];
    if (target && target !== current) goTo(allPages().indexOf(target));
  }

  function renderTabs() {
    tabs.replaceChildren(
      ...SECTIONS.filter((section) => pagesOf(section.id).length).map((section) => h(
        'button',
        { type: 'button', class: 'tab', role: 'tab', 'aria-selected': 'false', data: { section: section.id }, on: { click: () => openSection(section.id) } },
        Deck.icon(section.icon),
        h('span', { class: 'tab-label', text: section.label }),
      )),
    );
    updateNav();
  }

  // The page the user is on, remembered by id. Reading it back from scrollLeft after the DOM changed
  // would be wrong: the browser may have re-snapped to a different page in the meantime.
  let currentId = null;

  // show/hide hooks of the pages (their own polling starts and stops with them), from addPage
  const hooks = () => Deck.pages;

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
    tabs.querySelectorAll('.tab').forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.section === activeSection)));

    // the page indicator: only for a section that spans several pages
    const sectionPages = pagesOf(activeSection);
    dots.hidden = sectionPages.length < 2;
    dots.replaceChildren(...(dots.hidden ? [] : sectionPages.map((candidate) => h('i', { class: candidate === page ? 'on' : '' }))));
  }

  // Rebuild the generated pages and stay on the same one, so a rotation or a refresh doesn't jump back to page 1.
  function render() {
    if (!pager.clientWidth) return;

    // snapping is paused while the pages change, otherwise the browser re-snaps to the old snap target
    pager.style.scrollSnapType = 'none';
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
  // If the pager resizes but the grid (cols x rows) stays the same, the pages are not rebuilt, so nothing blinks; the CSS grid
  // already stretches the tiles, only the icon size is updated.
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (pager.clientWidth && built) {
        const { cols, rows, icon } = measure();
        if (cols === built.cols && rows === built.rows) {
          pager.style.setProperty('--icon', `${icon}px`);
          return;
        }
      }
      render();
    }, 120);
  }).observe(pager);

  Deck.pager = {
    render,
    goToId,
    // the section (apps, shortcuts, windows, sound...) of the page on screen, for Deck.back()
    currentSection: () => { const page = allPages()[currentIndex()]; return page ? sectionOf(page) : null; },
    // the show/hide hook of the page on screen, if it has one (connection.js pauses it with the screen)
    activeHook: () => hooks().find((def) => def.id === currentId),
  };
  Deck.goTo = goToId; // modules can ask to jump to a page
})();
