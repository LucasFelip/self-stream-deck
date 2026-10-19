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
    { id: 'lock', icon: 'lock', label: 'Bloquear', tone: 'soft', short: 'Vai para a tela de login. Os apps continuam abertos.', immediate: true },
    {
      id: 'sleep', icon: 'sleep', label: 'Suspender', tone: 'soft', short: 'Baixo consumo, volta em segundos. Apps continuam abertos.',
      title: 'Suspender o PC?', effects: 'O PC entra em suspensão com tudo aberto na memória.',
      reconnect: 'O painel perde a conexão até o PC acordar (mouse, teclado ou botão de ligar).',
    },
    {
      id: 'hibernate', icon: 'hibernate', label: 'Hibernar', tone: 'soft', short: 'Salva a sessão no disco e desliga.',
      title: 'Hibernar o PC?', effects: 'A sessão é salva no disco e o PC desliga, sem consumo. Ao ligar, tudo volta como estava.',
      reconnect: 'O painel só volta quando o PC for ligado de novo.', needs: 'hibernate', unavailable: 'Hibernação desativada no Windows',
    },
    {
      id: 'logoff', icon: 'logout', label: 'Sair da conta', tone: 'warn', short: 'Encerra a sessão e fecha os apps do usuário.',
      title: 'Sair da conta?', effects: 'A sessão do usuário é encerrada e todos os apps abertos são fechados.',
      reconnect: 'O painel para de funcionar até alguém entrar de novo (o servidor roda dentro da sessão).', apps: true,
    },
    {
      id: 'restart', icon: 'restart', label: 'Reiniciar', tone: 'danger', short: 'Fecha tudo e liga de novo.',
      title: 'Reiniciar o PC?', effects: 'Todos os apps são fechados e o Windows reinicia.',
      reconnect: 'O painel reconecta sozinho quando o Windows e o servidor voltarem.', apps: true, delay: true,
    },
    {
      id: 'shutdown', icon: 'power', label: 'Desligar', tone: 'danger', short: 'Fecha tudo e desliga o PC.',
      title: 'Desligar o PC?', effects: 'Todos os apps são fechados e o PC desliga por completo.',
      reconnect: 'Para ligar de novo você precisa apertar o botão do PC: este painel não consegue acordá-lo.', apps: true, delay: true,
    },
    {
      id: 'firmware', icon: 'chip', label: 'Reiniciar p/ BIOS', tone: 'danger', short: 'Reinicia direto na configuração da placa-mãe (UEFI).',
      title: 'Reiniciar para a BIOS?', effects: 'O PC reinicia e abre a configuração UEFI em vez do Windows. É preciso um teclado e monitor no PC para usá-la.',
      reconnect: 'O painel só volta depois que você sair da BIOS e o Windows iniciar.', apps: true, delay: true,
    },
    {
      id: 'advanced', icon: 'wrench', label: 'Modo avançado', tone: 'danger', short: 'Menu de recuperação: modo seguro, reparo, restauração.',
      title: 'Reiniciar no menu avançado?', effects: 'O PC reinicia no menu de opções avançadas do Windows (modo seguro, reparo de inicialização, restauração).',
      reconnect: 'O painel só volta depois que você escolher uma opção e o Windows iniciar. É preciso teclado e monitor no PC.', apps: true, delay: true,
    },
  ];

  const DELAYS = [['Agora', 0], ['10 s', 10], ['1 min', 60], ['5 min', 300], ['15 min', 900], ['30 min', 1800], ['1 h', 3600], ['2 h', 7200]];
  const SCHEDULE_LABELS = { shutdown: 'Desligamento', restart: 'Reinício', firmware: 'Reinício para a BIOS', advanced: 'Reinício avançado' };

  let power = null; // last GET /api/power
  let fetchedAt = 0;
  let pollTimer = null;
  let clockTimer = null;
  let inFlight = false;

  // --- status side ----------------------------------------------------------------------------

  const uptimeValue = h('dd', { text: '–' });
  const bootValue = h('dd', { text: '–' });
  const pendingValue = h('dd');
  const hibernateValue = h('dd');
  const appsBox = h('div', { class: 'chips' });
  const appsNote = h('p', { class: 'muted', style: 'font-size:0.68rem;line-height:1.4;margin:0' });

  const statusCard = h('div', { class: 'card' },
    h('h3', { text: 'Estado' }),
    h('dl', { class: 'kv' },
      h('dt', { text: 'Ligado há' }), uptimeValue,
      h('dt', { text: 'Último boot' }), bootValue,
      h('dt', { text: 'Reinício pendente' }), pendingValue,
      h('dt', { text: 'Hibernação' }), hibernateValue),
    h('div', { class: 'divider' }),
    h('h3', { text: 'Janelas abertas' }),
    h('div', { class: 'scroll' }, appsBox, appsNote));

  // --- actions side ---------------------------------------------------------------------------

  const scheduleText = h('span');
  const cancelButton = h('button', { type: 'button', text: 'Cancelar agendamento', on: { click: cancelSchedule } });
  const schedule = h('div', { class: 'schedule', hidden: true }, scheduleText, cancelButton);

  const tiles = new Map();
  const grid = h('div', { class: 'actions-grid' }, ...ACTIONS.map((action) => {
    const tile = h('button', { type: 'button', class: 'act', 'data-tone': action.tone, on: { click: () => choose(action) } },
      icon(action.icon), h('div', {}, h('b', { text: action.label }), h('small', { text: action.short })));
    tiles.set(action.id, tile);
    return tile;
  }));

  const el = h('section', { class: 'power-page' }, h('div', { class: 'power-side' }, statusCard), h('div', { class: 'power-main' }, schedule, grid));

  // --- rendering ------------------------------------------------------------------------------

  const badge = (label, tone) => h('span', { class: `badge ${tone || ''}`.trim(), text: label });

  function render() {
    if (!power) return;

    bootValue.textContent = fmt.dateTime(power.lastBoot);
    pendingValue.replaceChildren(power.rebootPending ? badge('Sim', 'warn') : badge('Não'));
    hibernateValue.replaceChildren(power.hibernate ? badge('Ativa', 'ok') : badge('Desativada'));

    appsBox.replaceChildren(...power.openApps.map((app) => h('span', { class: 'chip', text: app.count > 1 ? `${app.name} ×${app.count}` : app.name })));
    appsNote.textContent = power.openApps.length
      ? 'Podem ter trabalho não salvo: ao reiniciar ou desligar, o Windows pede que fechem.'
      : 'Nenhuma janela de aplicativo aberta.';

    for (const action of ACTIONS) {
      const blocked = action.needs && !power[action.needs];
      tiles.get(action.id).disabled = Boolean(blocked) || power.enabled === false;
      tiles.get(action.id).querySelector('small').textContent = blocked ? action.unavailable : action.short;
    }

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

  async function poll() {
    if (inFlight || document.hidden) return;
    inFlight = true;
    try {
      power = await api('/api/power');
      fetchedAt = Date.now();
      render();
    } catch {
      // keep what is on screen
    } finally {
      inFlight = false;
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
      poll();
      clearInterval(pollTimer);
      clearInterval(clockTimer);
      pollTimer = setInterval(poll, POLL_MS);
      clockTimer = setInterval(paintClock, 1000);
    },
    hide() {
      clearInterval(pollTimer);
      clearInterval(clockTimer);
    },
  });
})();
