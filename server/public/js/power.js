'use strict';

/**
 * "Energia" page: lock, sleep, hibernate, sign out, restart, shut down, restart into the BIOS or the
 * advanced boot menu, with optional delay, a visible countdown and a way to cancel.
 *
 * Anything that ends the session asks for confirmation in a sheet that explains the consequences, lists the
 * apps that are open (they may hold unsaved work) and must be *held* to confirm, so a stray tap can't do it.
 */
(() => {
  const { h, icon, api, toast, fmt, holdButton } = Deck;

  const POLL_MS = 5000;
  const modalRoot = Deck.$('modal-root');

  // What each action does, in the words shown in the sheet. `apps`: warn about open apps. `delay`: can be scheduled.
  const ACTIONS = [
    { id: 'lock', icon: 'fl-lock', label: 'Bloquear', tone: 'soft', short: 'Vai para a tela de login. Os apps continuam abertos.', immediate: true },
    {
      id: 'sleep', icon: 'fl-sleep', label: 'Suspender', tone: 'soft', short: 'Baixo consumo, volta em segundos.',
      title: 'Suspender o PC?', effects: 'O PC entra em suspensão com tudo aberto na memória.',
      reconnect: 'O painel perde a conexão até o PC acordar (mouse, teclado ou botão de ligar).',
    },
    {
      id: 'hibernate', icon: 'fl-hibernate', label: 'Hibernar', tone: 'soft', short: 'Salva a sessão no disco e desliga.',
      title: 'Hibernar o PC?', effects: 'A sessão é salva no disco e o PC desliga, sem consumo. Ao ligar, tudo volta como estava.',
      reconnect: 'O painel só volta quando o PC for ligado de novo.', needs: 'hibernate',
    },
    {
      id: 'logoff', icon: 'fl-logout', label: 'Sair da conta', tone: 'warn', short: 'Encerra a sessão e fecha os apps do usuário.',
      title: 'Sair da conta?', effects: 'A sessão do usuário é encerrada e todos os apps abertos são fechados.',
      reconnect: 'O painel para de funcionar até alguém entrar de novo (o servidor roda dentro da sessão).', apps: true,
    },
    {
      id: 'restart', icon: 'fl-restart', label: 'Reiniciar', tone: 'danger', short: 'Fecha tudo e liga de novo.',
      title: 'Reiniciar o PC?', effects: 'Todos os apps são fechados e o Windows reinicia.',
      reconnect: 'O painel reconecta sozinho quando o Windows e o servidor voltarem.', apps: true, delay: true,
    },
    {
      id: 'shutdown', icon: 'fl-power', label: 'Desligar', tone: 'danger', short: 'Fecha tudo e desliga o PC.',
      title: 'Desligar o PC?', effects: 'Todos os apps são fechados e o PC desliga por completo.',
      reconnect: 'Para ligar de novo você precisa apertar o botão do PC: este painel não consegue acordá-lo.', apps: true, delay: true,
    },
    {
      id: 'firmware', icon: 'fl-board', label: 'Reiniciar p/ BIOS', tone: 'danger', short: 'Reinicia direto na configuração da placa-mãe (UEFI).',
      title: 'Reiniciar para a BIOS?', effects: 'O PC reinicia e abre a configuração UEFI em vez do Windows. É preciso um teclado e monitor no PC para usá-la.',
      reconnect: 'O painel só volta depois que você sair da BIOS e o Windows iniciar.', apps: true, delay: true,
    },
    {
      id: 'advanced', icon: 'fl-wrench', label: 'Modo avançado', tone: 'danger', short: 'Menu de recuperação: modo seguro, reparo, restauração.',
      title: 'Reiniciar no menu avançado?', effects: 'O PC reinicia no menu de opções avançadas do Windows (modo seguro, reparo de inicialização, restauração).',
      reconnect: 'O painel só volta depois que você escolher uma opção e o Windows iniciar. É preciso teclado e monitor no PC.', apps: true, delay: true,
    },
  ];

  const DELAYS = [['Agora', 0], ['10 s', 10], ['1 min', 60], ['5 min', 300], ['15 min', 900], ['30 min', 1800], ['1 h', 3600], ['2 h', 7200]];
  const SCHEDULE_LABELS = { shutdown: 'Desligamento', restart: 'Reinício', firmware: 'Reinício para a BIOS', advanced: 'Reinício avançado' };

  let power = null; // last GET /api/power
  let fetchedAt = 0;
  let watcher = null; // live updates (or the fallback poller) while the page is the visible one
  let clockTimer = null;

  // --- status line -----------------------------------------------------------------------------

  // one line above the keys: uptime, pending restart, hibernation (the full explanations live in the confirmation sheet)
  const uptimeValue = h('b', { text: '–' });
  const pendingValue = h('b');
  const hibernateValue = h('b');

  const statusLine = h('div', { class: 'power-status' },
    h('span', {}, 'Ligado há ', uptimeValue),
    h('span', {}, 'Reinício pendente ', pendingValue),
    h('span', {}, 'Hibernação ', hibernateValue));

  // --- the keys -------------------------------------------------------------------------------

  const scheduleText = h('span');
  const cancelButton = h('button', { type: 'button', text: 'Cancelar agendamento', on: { click: cancelSchedule } });
  const schedule = h('div', { class: 'schedule', hidden: true }, scheduleText, cancelButton);

  // Same key as Apps and Shortcuts (.tile in a .grid): icon + name. The short description is only a tooltip / accessible name here;
  // the sheet that opens on tap spells out the consequences. The tone colours the icon.
  const tiles = new Map();
  const grid = h('div', { class: 'grid actions-grid' }, ...ACTIONS.map((action) => {
    const tile = h('button', { type: 'button', class: 'tile act-tile', 'data-tone': action.tone, title: action.short, 'aria-label': `${action.label}. ${action.short}`, on: { click: () => choose(action) } },
      h('div', { class: 'fallback' }, icon(action.icon)), h('span', { text: action.label }));
    tiles.set(action.id, tile);
    return tile;
  }));

  const el = h('section', { class: 'power-page' }, statusLine, schedule, grid);

  // --- rendering ------------------------------------------------------------------------------

  const setValue = (node, label, tone) => { node.textContent = label; node.className = tone || ''; };

  function render() {
    if (!power) return;

    setValue(pendingValue, power.rebootPending ? 'Sim' : 'Não', power.rebootPending ? 'warn' : '');
    setValue(hibernateValue, power.hibernate ? 'Ativa' : 'Desativada', power.hibernate ? 'ok' : '');

    // (the open windows are not listed here: the confirmation sheet warns about them, from power.openApps)
    // an action the PC cannot do (hibernation off) is hidden, not greyed out; the "Hibernação: Desativada" line says why
    let shown = 0;
    for (const action of ACTIONS) {
      const tile = tiles.get(action.id);
      tile.hidden = Boolean(action.needs && !power[action.needs]);
      tile.disabled = power.enabled === false;
      if (!tile.hidden) shown += 1;
    }
    grid.dataset.count = String(shown); // with seven keys the last one takes two columns, so there is no hole (see pages.css)

    paintClock();
  }

  function paintClock() {
    if (!power) return;
    uptimeValue.textContent = fmt.duration(power.uptimeSec + (Date.now() - fetchedAt) / 1000);

    const pending = power.scheduled;
    schedule.hidden = !pending;
    if (pending) {
      const left = Math.max(0, Math.round(pending.inSec - (Date.now() - fetchedAt) / 1000));
      scheduleText.replaceChildren(`${SCHEDULE_LABELS[pending.action] || pending.action} em `, h('b', { text: fmt.clock(left) }));
    }
  }

  function apply(data) {
    power = data;
    fetchedAt = Date.now();
    render();
  }

  // reads once more right away (after scheduling or cancelling something)
  async function poll() {
    if (document.hidden) return;
    try {
      apply(await api('/api/power'));
    } catch {
      // keep what is on screen
    }
  }

  // --- doing things ---------------------------------------------------------------------------

  async function perform(action, options = {}) {
    try {
      const result = await api('/api/power', { method: 'POST', json: { action, confirm: true, ...options } });
      Deck.refreshState?.();
      poll();
      return result;
    } catch (err) {
      toast(`Erro: ${err.message}`, true);
      throw err;
    }
  }

  async function cancelSchedule() {
    try {
      const { cancelled } = await api('/api/power', { method: 'POST', json: { action: 'cancel' } });
      toast(cancelled ? 'Agendamento cancelado' : 'Nada estava agendado');
      Deck.refreshState?.();
      poll();
    } catch (err) {
      toast(`Erro: ${err.message}`, true);
    }
  }

  function choose(action) {
    if (action.immediate) {
      perform(action.id).then(() => toast('Bloqueando…')).catch(() => {});
      return;
    }
    openSheet(action);
  }

  // --- confirmation sheet ---------------------------------------------------------------------

  function openSheet(action) {
    let delay = action.delay ? 10 : 0;
    let force = false;

    const close = () => backdrop.remove();

    const summary = h('p', { class: 'muted' });
    const delayChips = DELAYS.map(([label, seconds]) => h('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(seconds === delay),
      text: label,
      on: { click: () => { delay = seconds; refresh(); } },
    }));

    const forceKnob = h('span', { class: 'knob' });
    const forceNote = h('small');
    const forceSwitch = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': 'false', on: { click: () => { if (delay === 0) { force = !force; refresh(); } } } },
      forceKnob, h('span', {}, 'Forçar o fechamento dos apps', forceNote));

    function refresh() {
      delayChips.forEach((chip, i) => chip.setAttribute('aria-pressed', String(DELAYS[i][1] === delay)));
      // Windows rule: "shutdown /t N" with N > 0 implies /f, so a delayed action always forces apps to close
      const forced = force || delay > 0;
      forceSwitch.setAttribute('aria-checked', String(forced));
      forceSwitch.disabled = delay > 0;
      forceNote.textContent = delay > 0
        ? 'Sempre ativo quando há atraso (regra do Windows): alterações não salvas serão perdidas.'
        : 'Sem isso, um app com arquivo aberto pode bloquear o processo e o PC não reinicia.';
      const when = delay === 0 ? 'imediatamente' : `em ${DELAYS.find(([, s]) => s === delay)[0]} (dá para cancelar até lá)`;
      summary.textContent = `${action.label} ${when}${forced ? ', fechando os apps à força' : ''}.`;
    }

    const apps = power && power.openApps.length ? power.openApps.map((app) => app.name).join(', ') : '';
    const body = [
      h('header', { 'data-tone': action.tone }, icon(action.icon), h('h2', { text: action.title })),
      h('p', { text: action.effects }),
      action.apps && apps ? h('p', { class: 'warning', text: `Janelas abertas: ${apps}. Alterações não salvas podem ser perdidas.` }) : null,
      h('p', { text: action.reconnect }),
      action.delay ? h('div', { class: 'field' }, h('label', { text: 'Quando' }), h('div', { class: 'chips' }, ...delayChips)) : null,
      action.delay ? forceSwitch : null,
      action.delay ? summary : null,
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', text: 'Cancelar', on: { click: close } }),
        holdButton(`Segure para ${action.label.toLowerCase()}`, async () => {
          close();
          try {
            const result = await perform(action.id, action.delay ? { delaySec: delay, force: force || delay > 0 } : {});
            toast(result.at ? `${action.label} agendado` : `${action.label}…`);
          } catch {
            // perform() already showed the error
          }
        })),
    ];

    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': action.title }, ...body);
    const backdrop = h('div', { class: 'backdrop', on: { click: (event) => { if (event.target === backdrop) close(); } } }, sheet);
    modalRoot.append(backdrop);
    if (action.delay) refresh();
  }

  // --- lifecycle ------------------------------------------------------------------------------

  Deck.addPage({
    id: 'power',
    section: 'power',
    title: 'Energia',
    el,
    show() {
      if (watcher) watcher.stop();
      // the countdown of a scheduled action is counted here, so the value only changes when something is (un)scheduled
      const signature = (data) => JSON.stringify({ ...data, scheduled: data.scheduled ? { ...data.scheduled, inSec: 0 } : null });
      watcher = Deck.live.watch('power', { apply, poll: () => api('/api/power'), ms: POLL_MS, idleMs: 15000, idleAfter: 4, signature });
      clearInterval(clockTimer);
      clockTimer = setInterval(paintClock, 1000);
    },
    hide() {
      if (watcher) watcher.stop();
      watcher = null;
      clearInterval(clockTimer);
    },
  });
})();
