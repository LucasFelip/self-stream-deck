'use strict';

/**
 * Button editor ("Editar botões" in the ⚙ menu): create, change, reorder and delete keyboard shortcuts and macros, and hide or
 * reorder the apps on the Apps page, all from the phone. Everything is saved through /api/editor/*, where the server validates
 * it against a whitelist; a macro is a list of steps picked from fixed kinds (open an app, press keys, volume, audio output,
 * place a window, wait, camera...), never a free-form command.
 */
(() => {
  const { h, icon, api, toast } = Deck;

  const MODS = [['ctrl', 'Ctrl'], ['shift', 'Shift'], ['alt', 'Alt'], ['win', 'Win']];
  const MEDIA = [['playpause', 'Play / pausa'], ['next', 'Próxima faixa'], ['prev', 'Faixa anterior']];
  const MUTE = [[true, 'Silenciar'], [false, 'Ativar o som'], ['toggle', 'Alternar']];
  const ZONES = [['left', 'Metade esquerda'], ['right', 'Metade direita'], ['full', 'Tela cheia']];
  const WAITS = [[500, '0,5 s'], [1000, '1 s'], [2000, '2 s'], [3000, '3 s'], [5000, '5 s'], [10000, '10 s']];
  const ARM_MS = 3000;

  let data = null; // what /api/editor returned (apps, devices, screens)
  let tab = 'shortcuts';
  const lists = { shortcuts: [], macros: [], apps: [] }; // working copies, saved with the button
  const selected = { shortcuts: 0, macros: 0 };
  let dirty = false;
  let target = null; // set by edit mode: { key } of a tapped key, or { create } for a "+" slot

  const post = (path, json) => api(path, { method: 'POST', json });
  const clone = (value) => JSON.parse(JSON.stringify(value));

  // --- small pieces -----------------------------------------------------------------------------

  const label = (text, control) => h('label', { class: 'ed-field' }, h('span', { text }), control);

  function select(options, value, onChange) {
    const el = h('select', { class: 'ed-select' }, ...options.map(([val, text]) => h('option', { value: String(val), text })));
    el.value = String(value);
    el.addEventListener('change', () => {
      const chosen = options.find(([val]) => String(val) === el.value);
      onChange(chosen ? chosen[0] : el.value);
    });
    return el;
  }

  function textInput(value, placeholder, onInput, extra = {}) {
    const el = h('input', { type: 'text', class: 'ed-input', placeholder, maxlength: '40', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...extra });
    el.value = value || '';
    el.addEventListener('input', () => onInput(el.value));
    return el;
  }

  /** Modifier chips + one key: reads and writes a spec like "ctrl+shift+m". */
  function keyPicker(spec, onChange) {
    const tokens = String(spec || '').toLowerCase().split('+').map((token) => token.trim()).filter(Boolean);
    const norm = (token) => (token === 'control' ? 'ctrl' : token);
    const on = new Set(tokens.map(norm).filter((token) => MODS.some(([mod]) => mod === token)));
    let key = tokens.filter((token) => !MODS.some(([mod]) => mod === norm(token))).join('+');

    const compose = () => [...MODS.map(([mod]) => mod).filter((mod) => on.has(mod)), key].filter(Boolean).join('+');
    const chips = MODS.map(([mod, text]) => h('button', {
      type: 'button', class: 'chip big-chip', text, 'aria-pressed': String(on.has(mod)),
      on: { click: (event) => {
        if (on.has(mod)) on.delete(mod); else on.add(mod);
        event.currentTarget.setAttribute('aria-pressed', String(on.has(mod)));
        onChange(compose());
      } },
    }));
    const input = textInput(key, 'tecla: a, f5, esc, enter, left…', (value) => { key = value.trim().toLowerCase(); onChange(compose()); }, { maxlength: '30' });
    return { el: h('div', { class: 'ed-keys' }, h('div', { class: 'chips' }, ...chips), input) };
  }

  // --- steps ------------------------------------------------------------------------------------

  const firstApp = () => (data.apps[0] ? data.apps[0].id : '');
  const STEP_TYPES = [
    ['launch', 'Abrir ou focar um app', () => ({ type: 'launch', app: firstApp() })],
    ['place', 'Posicionar a janela de um app', () => ({ type: 'place', app: (data.apps.find((app) => app.canPlace) || data.apps[0] || {}).id || '', monitor: 0, zone: 'left' })],
    ['keys', 'Pressionar teclas', () => ({ type: 'keys', keys: 'ctrl+shift+m' })],
    ['media', 'Tecla de mídia', () => ({ type: 'media', key: 'playpause' })],
    ['volume', 'Definir o volume', () => ({ type: 'volume', level: 50 })],
    ['mute', 'Mudo do som', () => ({ type: 'mute', muted: 'toggle' })],
    ['mic', 'Mudo do microfone', () => ({ type: 'mic', muted: 'toggle' })],
    ['output', 'Trocar a saída/entrada de áudio', () => {
      const device = data.devices.playback[0] || data.devices.capture[0] || { id: '', name: '' };
      return { type: 'output', device: device.id, name: device.name };
    }],
    ['wait', 'Esperar', () => ({ type: 'wait', ms: 1000 })],
    ['camera', 'Câmera do celular', () => ({ type: 'camera', on: true })],
  ];

  function stepControls(step, touch) {
    const appOptions = data.apps.map((app) => [app.id, app.name]);
    const screens = Array.from({ length: data.screens }, (_, i) => [i, `Tela ${i + 1}`]);
    switch (step.type) {
      case 'launch':
        return [select(appOptions, step.app, (v) => { step.app = v; touch(); })];
      case 'place':
        return [
          select(data.apps.filter((app) => app.canPlace).map((app) => [app.id, app.name]), step.app, (v) => { step.app = v; touch(); }),
          select(screens, step.monitor, (v) => { step.monitor = Number(v); touch(); }),
          select(ZONES, step.zone, (v) => { step.zone = v; touch(); }),
        ];
      case 'keys':
        return [keyPicker(step.keys, (spec) => { step.keys = spec; touch(); }).el];
      case 'media':
        return [select(MEDIA, step.key, (v) => { step.key = v; touch(); })];
      case 'volume': {
        const value = h('span', { class: 'value', text: `${step.level}%` });
        const range = h('input', { type: 'range', min: 0, max: 100, value: step.level, class: 'range' });
        range.addEventListener('input', () => { step.level = Number(range.value); value.textContent = `${step.level}%`; range.style.setProperty('--fill', `${step.level}%`); touch(); });
        range.style.setProperty('--fill', `${step.level}%`);
        return [h('div', { class: 'ed-slider' }, range, value)];
      }
      case 'mute':
      case 'mic':
        return [select(MUTE, step.muted, (v) => { step.muted = v; touch(); })];
      case 'output': {
        const options = [...data.devices.playback.map((d) => [d.id, `Saída: ${d.name}`]), ...data.devices.capture.map((d) => [d.id, `Entrada: ${d.name}`])];
        if (step.device && !options.some(([id]) => id === step.device)) options.unshift([step.device, `${step.name || 'Dispositivo'} (não encontrado agora)`]);
        return [select(options, step.device, (v) => {
          step.device = v;
          const found = [...data.devices.playback, ...data.devices.capture].find((d) => d.id === v);
          step.name = found ? found.name : step.name;
          touch();
        })];
      }
      case 'wait':
        return [select(WAITS, step.ms, (v) => { step.ms = Number(v); touch(); })];
      case 'camera':
        return [select([[true, 'Ligar a câmera'], [false, 'Desligar a câmera']], step.on, (v) => { step.on = v === true || v === 'true'; touch(); })];
      default:
        return [];
    }
  }

  function stepRow(macro, index, rerender, touch) {
    const step = macro.steps[index];
    const meta = STEP_TYPES.find(([type]) => type === step.type);
    const move = (by) => {
      const target = index + by;
      if (target < 0 || target >= macro.steps.length) return;
      [macro.steps[index], macro.steps[target]] = [macro.steps[target], macro.steps[index]];
      touch();
      rerender();
    };
    const iconBtn = (name, text, onClick, disabled = false) => h('button', { type: 'button', class: 'ed-ico', 'aria-label': text, disabled, on: { click: onClick } }, icon(name, 18));
    return h('div', { class: 'ed-step' },
      h('div', { class: 'ed-step-head' },
        h('b', { text: `${index + 1}. ${meta ? meta[1] : step.type}` }),
        h('div', { class: 'ed-step-tools' },
          iconBtn('up', 'Subir', () => move(-1), index === 0),
          iconBtn('down', 'Descer', () => move(1), index === macro.steps.length - 1),
          iconBtn('close', 'Remover passo', () => { macro.steps.splice(index, 1); touch(); rerender(); }))),
      h('div', { class: 'ed-step-body' }, ...stepControls(step, touch)));
  }

  // --- lists (left side) ---------------------------------------------------------------------------

  const tabs = h('div', { class: 'ed-tabs' });
  const listBox = h('div', { class: 'ed-list scroll' });
  const addButton = h('button', { type: 'button', class: 'ed-add' });
  const form = h('div', { class: 'card ed-form' });
  const el = h('section', { class: 'editor-page' }, h('div', { class: 'ed-left' }, tabs, listBox, addButton), form);

  function markDirty() {
    dirty = true;
    saveButton.dataset.dirty = 'true';
  }

  const saveButton = h('button', { type: 'button', class: 'ed-save', text: 'Salvar' });
  saveButton.addEventListener('click', () => save());

  let armTimer = null;
  function deleteButton(onDelete) {
    const button = h('button', { type: 'button', class: 'ed-delete', text: 'Excluir' });
    const disarm = () => { clearTimeout(armTimer); button.dataset.armed = 'false'; button.textContent = 'Excluir'; };
    button.addEventListener('click', () => {
      if (button.dataset.armed === 'true') { disarm(); onDelete(); return; }
      button.dataset.armed = 'true';
      button.textContent = 'Toque de novo';
      armTimer = setTimeout(disarm, ARM_MS);
    });
    return button;
  }

  function renderTabs() {
    const names = [['shortcuts', 'Atalhos'], ['macros', 'Macros'], ['apps', 'Apps']];
    tabs.replaceChildren(...names.map(([id, text]) => h('button', {
      type: 'button', class: 'chip big-chip', text, 'aria-pressed': String(id === tab),
      on: { click: () => { tab = id; render(); } },
    })));
  }

  function renderList() {
    const list = lists[tab];
    if (tab === 'apps') {
      listBox.replaceChildren(...list.map((app) => h('div', { class: `ed-row${app.hidden ? ' off' : ''}` },
        h('span', { class: 'ed-appicon' }, app.hasIcon ? h('img', { src: `/api/icon/${app.id}?v=${app.iconVersion || ''}`, alt: '' }) : h('b', { text: app.name.charAt(0).toUpperCase() })),
        h('span', { class: 'ed-main' }, h('b', { text: app.name }), h('small', { class: 'muted', text: app.hidden ? 'oculto' : 'visível' })),
        h('button', { type: 'button', class: 'ed-ico wide', 'aria-label': app.hidden ? 'Mostrar' : 'Ocultar', on: { click: () => { app.hidden = !app.hidden; markDirty(); render(); } } }, h('span', { text: app.hidden ? 'Mostrar' : 'Ocultar' })))));
      addButton.hidden = true;
      return;
    }

    addButton.hidden = false;
    addButton.replaceChildren(icon('plus', 18), h('span', { text: tab === 'shortcuts' ? 'Novo atalho' : 'Nova macro' }));
    listBox.replaceChildren(...list.map((item, index) => h('div', { class: 'ed-row', role: 'button', tabindex: '0', 'aria-pressed': String(index === selected[tab]), on: { click: () => { selected[tab] = index; render(); } } },
      h('span', { class: 'ed-main' },
        h('b', { text: item.label || '(sem nome)' }),
        h('small', { class: 'muted', text: tab === 'shortcuts' ? (item.keys || 'sem teclas') : `${item.steps.length} passo${item.steps.length === 1 ? '' : 's'} · ${item.page === 'apps' ? 'tela Apps' : 'tela Atalhos'}` })))));
  }

  // --- the form (right side) ------------------------------------------------------------------------

  function renderForm() {
    const list = lists[tab];

    if (tab === 'apps') {
      form.replaceChildren(
        h('h3', { text: 'Apps' }),
        h('p', { class: 'muted ed-hint', text: 'Oculte o que você não usa. Para mudar a posição de um botão, segure-o na tela e arraste: não precisa vir aqui.' }),
        h('div', { class: 'ed-actions' }, saveButton));
      return;
    }

    const item = list[selected[tab]];
    if (!item) {
      form.replaceChildren(
        h('h3', { text: tab === 'shortcuts' ? 'Atalhos' : 'Macros' }),
        h('p', { class: 'muted ed-hint', text: tab === 'shortcuts' ? 'Um atalho aperta uma combinação de teclas no PC. Toque em “Novo atalho”.' : 'Uma macro faz uma sequência de passos com um toque: abrir apps, posicionar janelas, trocar a saída de áudio, ligar a câmera… Toque em “Nova macro”.' }));
      return;
    }

    const remove = () => {
      list.splice(selected[tab], 1);
      selected[tab] = Math.max(0, selected[tab] - 1);
      save();
    };
    const actions = h('div', { class: 'ed-actions' }, h('button', { type: 'button', class: 'ed-test', text: 'Testar', on: { click: () => testItem() } }), deleteButton(remove), saveButton);

    if (tab === 'shortcuts') {
      const preview = h('small', { class: 'muted ed-preview' });
      const paint = () => { preview.textContent = item.keys ? `Aperta: ${item.keys.split('+').map((token) => (token.length === 1 || /^f\d+$/.test(token) ? token.toUpperCase() : token[0].toUpperCase() + token.slice(1))).join(' + ')}` : ''; };
      paint();
      form.replaceChildren(
        label('Nome', textInput(item.label, 'ex.: Mutar no Discord', (value) => { item.label = value; markDirty(); renderList(); })),
        h('div', { class: 'ed-field' }, h('span', { text: 'Teclas' }), keyPicker(item.keys, (spec) => { item.keys = spec; markDirty(); paint(); renderList(); }).el, preview),
        actions);
      return;
    }

    // macro
    const stepsBox = h('div', { class: 'ed-steps' });
    const paintSteps = () => stepsBox.replaceChildren(...item.steps.map((_, index) => stepRow(item, index, paintSteps, () => { markDirty(); renderList(); })));
    paintSteps();
    const addStep = select([['', '＋ Adicionar passo…'], ...STEP_TYPES.map(([type, text]) => [type, text])], '', (type) => {
      const meta = STEP_TYPES.find(([id]) => id === type);
      if (!meta) return;
      item.steps.push(meta[2]());
      addStep.value = '';
      markDirty();
      paintSteps();
      renderList();
    });
    form.replaceChildren(
      label('Nome', textInput(item.label, 'ex.: Call de trabalho', (value) => { item.label = value; markDirty(); renderList(); })),
      h('div', { class: 'ed-field' }, h('span', { text: 'Aparece na tela' }),
        h('div', { class: 'chips' }, ...[['shortcuts', 'Atalhos'], ['apps', 'Apps']].map(([page, text]) => h('button', {
          type: 'button', class: 'chip big-chip', text, 'aria-pressed': String((item.page || 'shortcuts') === page),
          on: { click: () => { item.page = page; markDirty(); renderList(); renderForm(); } },
        })))),
      stepsBox, addStep, actions);
  }

  function render() {
    renderTabs();
    renderList();
    renderForm();
    saveButton.dataset.dirty = String(dirty);
  }

  // --- saving -----------------------------------------------------------------------------------

  async function save() {
    try {
      if (tab === 'shortcuts') {
        const { shortcuts } = await post('/api/editor/shortcuts', { items: lists.shortcuts });
        lists.shortcuts = shortcuts;
      } else if (tab === 'macros') {
        const { macros } = await post('/api/editor/macros', { items: lists.macros });
        lists.macros = macros;
      } else {
        await post('/api/editor/apps', { hidden: lists.apps.filter((app) => app.hidden).map((app) => app.id) });
      }
      dirty = false;
      selected.shortcuts = Math.min(selected.shortcuts, Math.max(0, lists.shortcuts.length - 1));
      selected.macros = Math.min(selected.macros, Math.max(0, lists.macros.length - 1));
      toast('Salvo');
      if (Deck.reloadDeck) Deck.reloadDeck();
      render();
      return true;
    } catch (err) {
      toast(`Não salvou: ${err.message}`, true);
      return false;
    }
  }

  // saves first (a new item only gets its id from the server), then runs it once
  async function testItem() {
    const index = selected[tab];
    if (!(await save())) return;
    const item = lists[tab][index];
    if (!item) return;
    try {
      if (tab === 'shortcuts') {
        await post(`/api/shortcut/${item.id}`);
        toast(`Apertou ${item.keys}`);
      } else if (Deck.runMacro) {
        await Deck.runMacro(item.id, item.label);
      }
    } catch (err) {
      toast(`Erro: ${err.message}`, true);
    }
  }

  addButton.addEventListener('click', () => {
    const list = lists[tab];
    if (tab === 'shortcuts') list.push({ label: '', keys: '' });
    else list.push({ label: '', page: 'shortcuts', steps: [STEP_TYPES[0][2]()] });
    selected[tab] = list.length - 1;
    markDirty();
    render();
    form.querySelector('input')?.focus();
  });

  // --- the sheet ----------------------------------------------------------------------------------

  // Opened from edit mode: select the tapped key (its tab and row), or start a new item for the empty slot that was tapped.
  function applyTarget(want) {
    if (!want) return;
    if (want.create) {
      tab = want.create === 'apps' ? 'macros' : 'shortcuts';
      const list = lists[tab];
      list.push(tab === 'shortcuts' ? { label: '', keys: '' } : { label: '', page: 'apps', steps: [STEP_TYPES[0][2]()] });
      selected[tab] = list.length - 1;
      markDirty();
      return;
    }
    const kind = String(want.key || '').charAt(0);
    const id = String(want.key || '').slice(2);
    if (kind === 's' || kind === 'm') {
      tab = kind === 's' ? 'shortcuts' : 'macros';
      const at = lists[tab].findIndex((item) => item.id === id);
      if (at !== -1) selected[tab] = at;
    } else {
      tab = 'apps';
    }
  }

  async function load() {
    const want = target;
    target = null;
    try {
      data = await api('/api/editor');
      lists.shortcuts = clone(data.shortcuts);
      lists.macros = clone(data.macros);
      lists.apps = clone(data.apps);
      dirty = false;
      selected.shortcuts = 0;
      selected.macros = 0;
      applyTarget(want);
      render();
      if (want && want.create) form.querySelector('input')?.focus();
    } catch (err) {
      form.replaceChildren(h('p', { class: 'muted ed-hint', text: err.status === 403 ? 'O editor está desligado no config.json ("editor": false).' : `Não foi possível carregar: ${err.message}` }));
    }
  }

  const sheet = Deck.overlay({
    title: 'Editar botões',
    el,
    onOpen: load,
    onClose() { clearTimeout(armTimer); target = null; },
  });
  // the menu entry turns on edit mode on the deck itself (js/edit.js); this sheet then opens from a tapped key or a "+" slot
  Deck.menuItems.push({ label: 'Editar botões', onClick: () => Deck.edit.enter() });
  Deck.editor = {
    open(where) {
      if (sheet.isOpen) return;
      target = where || null;
      sheet.open();
    },
  };
})();
