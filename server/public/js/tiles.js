'use strict';

/**
 * The keys of the Apps and Shortcuts pages: what each key is (app, shortcut, macro, camera), how it is drawn and what a tap does,
 * the saved order, and reading the lists from the PC. It knows nothing about pages or scrolling (pager.js builds those).
 *
 * An item is { key, label, visual(): Node, onTap(), appId? }.
 */
(() => {
  const { $, api, toast: showToast } = Deck;
  const pager = $('pager');

  const sections = {
    apps: { title: 'Aplicativos', items: [] },
    shortcuts: { title: 'Atalhos', items: [] },
  };

  const refreshStateSoon = (ms) => setTimeout(() => Deck.pc.refresh(), ms);

  function fallbackIcon(name) {
    const el = document.createElement('div');
    el.className = 'fallback';
    el.textContent = name.charAt(0).toUpperCase();
    return el;
  }

  function appItem(app) {
    return {
      appId: app.id,
      key: `a:${app.id}`,
      label: app.name,
      visual() {
        if (!app.hasIcon) return fallbackIcon(app.name);
        const img = document.createElement('img');
        img.src = `/api/icon/${app.id}?v=${app.iconVersion || ''}`;
        img.alt = '';
        img.draggable = false; // a long press on an icon must not start the browser's own image drag
        img.addEventListener('error', () => img.replaceWith(fallbackIcon(app.name)));
        return img;
      },
      async onTap() {
        try {
          const { action } = await api(`/api/launch/${app.id}`, { method: 'POST' });
          showToast(action === 'focused' ? `${app.name} em primeiro plano` : `Abrindo ${app.name}`);
          refreshStateSoon(1500); // the "running" dot appears once the window exists
        } catch (err) {
          showToast(`Erro: ${err.message}`, true);
        }
      },
    };
  }

  function shortcutItem(shortcut) {
    return {
      key: `s:${shortcut.id}`,
      label: shortcut.label,
      visual() {
        const keycap = document.createElement('div');
        keycap.className = 'keycap';
        keycap.textContent = shortcut.display.replace(/\+/g, '+​'); // allow a line break after each "+"
        return keycap;
      },
      async onTap() {
        try {
          await api(`/api/shortcut/${shortcut.id}`, { method: 'POST' });
        } catch (err) {
          showToast(`Erro: ${err.message}`, true);
        }
      },
    };
  }

  // A macro (made in the button editor) is one key that runs a list of steps on the PC. The camera steps are for the phone.
  async function runMacro(id, name) {
    try {
      const outcome = await api(`/api/macro/${id}`, { method: 'POST' });
      const failed = outcome.steps.filter((step) => !step.ok);
      for (const step of outcome.client || []) if (step.type === 'camera' && Deck.camera) await Deck.camera.set(step.on);
      if (failed.length) showToast(`${name}: ${failed.length} de ${outcome.steps.length} passos falharam (${failed[0].error})`, true);
      else showToast(`${name} ✓`);
      refreshStateSoon(800);
    } catch (err) {
      showToast(`Erro: ${err.message}`, true);
    }
  }
  Deck.runMacro = runMacro;

  function macroItem(macro) {
    return {
      key: `m:${macro.id}`,
      label: macro.label,
      visual() {
        const box = document.createElement('div');
        box.className = 'keycap macro';
        box.append(Deck.icon('play', 22), Object.assign(document.createElement('small'), { textContent: `${macro.steps} passo${macro.steps === 1 ? '' : 's'}` }));
        return box;
      },
      onTap: () => runMacro(macro.id, macro.label),
    };
  }

  // The phone camera as the PC's webcam is one more key on the apps page: a tap turns it on or off, a long press
  // opens its settings. A red dot on it means it is transmitting.
  function cameraItem() {
    return {
      appId: 'camera',
      key: 'c:camera',
      label: 'Câmera',
      visual() {
        const box = document.createElement('div');
        box.className = 'fallback cam';
        box.append(Deck.icon('camera', 30));
        return box;
      },
      onTap: () => Deck.camera.toggle(),
    };
  }

  function paintCamera() {
    const live = Boolean(Deck.camera && Deck.camera.sending);
    pager.querySelectorAll('.tile[data-app-id="camera"]').forEach((tile) => tile.classList.toggle('live', live));
  }

  function makeTile(item) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    if (item.appId) tile.dataset.appId = item.appId;
    if (item.key) tile.dataset.key = item.key;

    const text = document.createElement('span');
    text.textContent = item.label;
    tile.append(item.visual(), text);

    tile.addEventListener('click', () => {
      if (Deck.arrange.justDropped) return; // the touch that ended a drag is not a tap
      tile.classList.add('launched');
      setTimeout(() => tile.classList.remove('launched'), 250);
      // a macro can take seconds: its key stays marked busy until it ends
      const result = item.onTap();
      if (result && typeof result.then === 'function') {
        tile.classList.add('busy');
        result.finally(() => tile.classList.remove('busy'));
      }
    });
    return tile;
  }

  // Where each key sits (saved by holding and dragging it): "a:<app>", "s:<shortcut>", "m:<macro>", "c:camera" per page.
  // Keys not in the saved order keep their natural place, after the ones that are.
  let tileOrder = { apps: [], shortcuts: [] };

  function arranged(page, items) {
    const rank = new Map((tileOrder[page] || []).map((key, index) => [key, index]));
    const place = (item, index) => (rank.has(item.key) ? rank.get(item.key) : 1e6 + index);
    return items.map((item, index) => ({ item, at: place(item, index) })).sort((a, b) => a.at - b.at).map(({ item }) => item);
  }

  async function loadLayout() {
    try {
      tileOrder = { apps: [], shortcuts: [], ...(await api('/api/layout')) };
    } catch {
      // keep the order we have: the keys just stay where they were
    }
  }

  // the apps page: the taskbar apps, the macros placed on it and the camera key, in the saved order
  let appTiles = [];
  let appMacroTiles = [];
  let shortcutTiles = [];
  const composeApps = () => { sections.apps.items = arranged('apps', [...appTiles, ...appMacroTiles, ...(Deck.camera ? [cameraItem()] : [])]); };
  const composeShortcuts = () => { sections.shortcuts.items = arranged('shortcuts', shortcutTiles); };

  async function loadApps() {
    const [{ apps, host }] = await Promise.all([api('/api/apps'), loadLayout()]);
    if (host) $('host').textContent = host;
    appTiles = apps.map(appItem);
    composeApps();
  }

  async function loadShortcuts() {
    const [{ shortcuts }, { macros }] = await Promise.all([api('/api/shortcuts'), api('/api/macros'), loadLayout()]);
    shortcutTiles = [...shortcuts.map(shortcutItem), ...macros.filter((macro) => macro.page !== 'apps').map(macroItem)];
    appMacroTiles = macros.filter((macro) => macro.page === 'apps').map(macroItem);
    composeShortcuts();
    composeApps();
  }

  Deck.tiles = {
    sections,
    makeTile,
    loadApps,
    loadShortcuts,
    paintCamera,
    // the order as it is on screen now (arrange.js saves it to the PC)
    setOrder(page, order) { tileOrder = { ...tileOrder, [page]: order }; },
  };
})();
