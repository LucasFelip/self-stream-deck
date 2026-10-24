'use strict';

/**
 * Monitoring pages:
 *   Desempenho - live CPU (per core), memory, GPU, disk and network
 *   Sistema    - what the machine is: OS, CPU, RAM modules, GPU, board, storage, network, monitors
 *   Processos  - top processes by CPU and by memory
 */
(() => {
  const { h, api, fmt } = Deck;

  const SAMPLE_MS = 2000;
  const PROCESS_MS = 3000;
  const HISTORY = 60;

  const level = (value, warn, crit) => (!Number.isFinite(value) ? 'ok' : value >= crit ? 'crit' : value >= warn ? 'warn' : 'ok');

  const text = (el, value) => { if (el.textContent !== value) el.textContent = value; return el; };
  const orDash = (value, format = (v) => String(v)) => (value === null || value === undefined || Number.isNaN(value) ? '–' : format(value));

  // --- small components -----------------------------------------------------------------------

  /** Scrolling line chart; values are scaled to `max` (or to the largest value seen, with a floor). */
  function spark({ max = null, floor = 1, alt = false } = {}) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('viewBox', '0 0 100 30');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = `<path class="fill"></path><path class="line${alt ? ' alt' : ''}"></path>`;
    const [fill, line] = svg.querySelectorAll('path');
    const values = [];

    return {
      el: svg,
      push(value) {
        // the first reading fills the whole history, so the chart starts as a flat line instead of a stub
        if (!values.length) values.push(...Array(HISTORY).fill(Number.isFinite(value) ? value : 0));
        values.push(Number.isFinite(value) ? value : 0);
        if (values.length > HISTORY) values.shift();
        const top = max ?? Math.max(floor, ...values);
        const offset = HISTORY - values.length; // newest value sits at the right edge
        const xs = values.map((_, i) => (((i + offset) / (HISTORY - 1)) * 100).toFixed(1));
        const points = values.map((v, i) => `${xs[i]},${(29 - (Math.min(v, top) / top) * 27).toFixed(1)}`);
        line.setAttribute('d', `M${points.join(' L')}`);
        fill.setAttribute('d', `M${xs[0]},30 L${points.join(' L')} L100,30 Z`);
      },
    };
  }

  function bar() {
    const fillEl = h('i');
    const el = h('div', { class: 'bar', 'data-level': 'ok' }, fillEl);
    return {
      el,
      set(percent, lvl = 'ok') {
        fillEl.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
        el.dataset.level = lvl;
      },
    };
  }

  const stat = (label) => {
    const value = h('span', { text: '–' });
    return { el: h('div', {}, h('span', { text: label }), value), set: (v) => text(value, v) };
  };

  const card = (title, sub, ...children) => {
    const subEl = h('span', { class: 'sub' });
    if (sub) subEl.textContent = sub;
    return { el: h('div', { class: 'card' }, h('div', { class: 'head' }, h('h3', { text: title }), subEl), ...children), sub: subEl };
  };

  let latest = null; // last sample, shared by the pages
  let info = null;

  // --- Desempenho -----------------------------------------------------------------------------

  const cpuBig = h('div', { class: 'big', 'data-level': 'ok' });
  const cpuSpark = spark({ max: 100 });
  const cpuStats = { clock: stat('Clock'), temp: stat('Temperatura'), power: stat('Potência'), tasks: stat('Processos') };
  const coreBars = Array.from({ length: 16 }, () => h('i', {}, h('b')));
  const cpuCard = card('CPU', '', cpuBig, cpuSpark.el, h('div', { class: 'stats' }, ...Object.values(cpuStats).map((s) => s.el)), h('div', { class: 'cores' }, ...coreBars));
  cpuCard.el.classList.add('c-cpu');

  const memBig = h('div', { class: 'big', 'data-level': 'ok' });
  const memBar = bar();
  const memStats = { used: stat('Em uso'), free: stat('Livre'), commit: stat('Commit') };
  const memCard = card('Memória', '', memBig, memBar.el, h('div', { class: 'stats' }, ...Object.values(memStats).map((s) => s.el)));
  memCard.el.classList.add('c-mem');

  const gpuBig = h('div', { class: 'big', 'data-level': 'ok' });
  const gpuBar = bar();
  const gpuStats = { vram: stat('VRAM'), temp: stat('Temperatura'), power: stat('Potência'), fan: stat('Ventoinha'), clock: stat('Clock') };
  const gpuCard = card('GPU', '', gpuBig, gpuBar.el, h('div', { class: 'stats' }, ...Object.values(gpuStats).map((s) => s.el)));
  gpuCard.el.classList.add('c-gpu');

  const diskBig = h('div', { class: 'big', 'data-level': 'ok' });
  const diskStats = { read: stat('Leitura'), write: stat('Escrita') };
  const driveList = h('div', { class: 'scroll' });
  const diskCard = card('Disco', '', diskBig, h('div', { class: 'stats' }, diskStats.read.el, diskStats.write.el), driveList);
  diskCard.el.classList.add('c-dsk');

  const netDown = h('div', { class: 'big' });
  const netSpark = spark({ floor: 100 * 1024 });
  const netStats = { up: stat('Envio'), link: stat('Link') };
  const netCard = card('Rede', '', netDown, netSpark.el, h('div', { class: 'stats' }, netStats.up.el, netStats.link.el));
  netCard.el.classList.add('c-net');

  // The game's frame rate (from RTSS / Afterburner): its own strip above everything, only while a game is drawing frames
  const fpsGame = h('span', { class: 'fps-game' });
  const fpsBig = h('div', { class: 'big' });
  const fpsSpark = spark({ floor: 60 });
  const fpsFrame = h('span', { class: 'fps-frame' });
  const fpsCard = h('div', { class: 'card c-fps' }, h('div', { class: 'fps-info' }, fpsGame, fpsFrame), fpsBig, fpsSpark.el);

  const monitorEl = h('section', { class: 'monitor-page' }, h('div', { class: 'col-cpu' }, fpsCard, cpuCard.el), memCard.el, gpuCard.el, diskCard.el, netCard.el);
  let gaming = false;

  function updateFps(fps) {
    if (Boolean(fps) !== gaming) {
      gaming = Boolean(fps);
      fpsCard.classList.toggle('on', gaming);
    }
    if (!fps) return;
    fpsGame.textContent = fps.app || 'Jogo';
    fpsGame.title = `Fonte: ${fps.source}`;
    fpsBig.replaceChildren(`${fps.fps}`, h('small', { text: 'FPS' }));
    fpsSpark.push(fps.fps);
    fpsFrame.textContent = `${fps.frameMs} ms`;
  }

  function updatePerformance(sample) {
    const { cpu, memory, gpu, disk, network, fps } = sample;
    updateFps(fps);
    cpuCard.sub.textContent = ''; // clears "iniciando sensores…"

    cpuBig.dataset.level = level(cpu.usage, 80, 95);
    cpuBig.replaceChildren(`${Math.round(cpu.usage ?? 0)}`, h('small', { text: '%' }));
    cpuSpark.push(cpu.usage);
    cpuStats.clock.set(orDash(cpu.freqMHz, (v) => `${(v / 1000).toFixed(2)} GHz`));
    cpuStats.temp.set(orDash(cpu.temp, (v) => `${Math.round(v)} °C`));
    cpuStats.power.set(orDash(cpu.power, (v) => `${v.toFixed(0)} W`));
    cpuStats.tasks.set(`${cpu.processes} · ${cpu.threads} threads`);
    cpu.cores.forEach((usage, i) => {
      const cell = coreBars[i];
      if (cell) cell.firstChild.style.height = `${Math.min(100, usage)}%`;
    });
    coreBars.forEach((cell, i) => { cell.style.visibility = i < cpu.cores.length ? 'visible' : 'hidden'; });
    cpuStats.temp.el.title = cpu.tempSource ? `Fonte: ${cpu.tempSource}` : 'Sensor indisponível (abra o MSI Afterburner para ler a temperatura)';

    memBig.dataset.level = level(memory.usedPct, 80, 92);
    memBig.replaceChildren(`${memory.usedPct}`, h('small', { text: '%' }));
    memBar.set(memory.usedPct, level(memory.usedPct, 80, 92));
    memStats.used.set(`${fmt.gb(memory.usedMB)} / ${fmt.gb(memory.totalMB)}`);
    memStats.free.set(fmt.gb(memory.totalMB - memory.usedMB));
    memStats.commit.set(`${fmt.gb(memory.commitUsedMB)} / ${fmt.gb(memory.commitLimitMB)}`);

    if (gpu) {
      gpuCard.sub.textContent = gpu.name.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '');
      gpuBig.dataset.level = level(gpu.usage, 80, 95);
      gpuBig.replaceChildren(`${Math.round(gpu.usage ?? 0)}`, h('small', { text: '%' }));
      const vramPct = (gpu.memUsedMB / gpu.memTotalMB) * 100;
      gpuBar.set(vramPct, level(vramPct, 85, 95));
      gpuStats.vram.set(`${fmt.gb(gpu.memUsedMB)} / ${fmt.gb(gpu.memTotalMB)}`);
      gpuStats.temp.set(orDash(gpu.temp, (v) => `${v} °C`));
      gpuStats.power.set(`${orDash(gpu.power, (v) => v.toFixed(0))} / ${orDash(gpu.powerLimit, (v) => v.toFixed(0))} W`);
      gpuStats.fan.set(orDash(gpu.fan, (v) => `${v}%`));
      gpuStats.clock.set(orDash(gpu.clock, (v) => `${v} MHz`));
    } else {
      gpuCard.sub.textContent = '';
      gpuBig.replaceChildren('–');
      gpuBar.set(0);
      Object.values(gpuStats).forEach((s) => s.set('–'));
    }

    const total = disk.total || { active: 0, readBps: 0, writeBps: 0 };
    diskBig.dataset.level = level(total.active, 80, 95);
    diskBig.replaceChildren(`${Math.round(total.active ?? 0)}`, h('small', { text: '%' }));
    diskStats.read.set(fmt.rate(total.readBps));
    diskStats.write.set(fmt.rate(total.writeBps));
    updateDrives(disk.drives);

    const down = network.reduce((sum, adapter) => sum + (adapter.downBps || 0), 0);
    const up = network.reduce((sum, adapter) => sum + (adapter.upBps || 0), 0);
    netCard.sub.textContent = network.map((adapter) => adapter.name).join(', ');
    netDown.replaceChildren(`↓ ${fmt.rate(down)}`);
    netSpark.push(down);
    netStats.up.set(`↑ ${fmt.rate(up)}`);
    netStats.link.set(network[0] ? network[0].speed : '–');
  }

  function updateDrives(drives) {
    const signature = drives.map((drive) => drive.name).join('|');
    if (driveList.dataset.sig !== signature) {
      driveList.dataset.sig = signature;
      driveList.replaceChildren(...drives.map((drive) => {
        const usage = bar();
        const free = h('b');
        return Object.assign(h('div', { class: 'drive', data: { drive: drive.name } }, h('div', { class: 'row' }, h('span', { text: `${drive.name} ${drive.label || ''}`.trim() }), free), usage.el), { usage, free });
      }));
    }
    drives.forEach((drive, index) => {
      const row = driveList.children[index];
      if (!row) return;
      const usedPct = ((drive.totalGB - drive.freeGB) / drive.totalGB) * 100;
      text(row.free, `${Math.round(drive.freeGB)} GB livres`);
      row.usage.set(usedPct, level(usedPct, 85, 95));
    });
  }

  // --- Sistema --------------------------------------------------------------------------------

  const systemColumns = [h('div', { class: 'col' }), h('div', { class: 'col' }), h('div', { class: 'col' })];
  const systemLoading = h('div', { class: 'loading', text: 'Lendo informações do sistema…' });
  const systemEl = h('section', { class: 'system-page' }, ...systemColumns);
  systemColumns[0].append(systemLoading);

  const kv = (rows) => h('dl', { class: 'kv' }, ...rows.filter(([, value]) => value !== null && value !== undefined && value !== '').flatMap(([key, value]) => [h('dt', { text: key }), h('dd', { text: String(value) })]));
  const infoCard = (title, ...children) => h('div', { class: 'card' }, h('h3', { text: title }), ...children);

  let uptimeEl = null;
  let bootTime = null;

  function renderInfo(data) {
    const { os, cpu, memory, gpus, board, storage, network, monitors } = data;
    bootTime = os.lastBoot ? new Date(os.lastBoot).getTime() : null;

    systemColumns[0].replaceChildren(
      infoCard('Sistema',
        kv([['Computador', data.host], ['Usuário', data.user], ['Windows', os.name.replace(/^Microsoft\s+/, '')], ['Versão', `${os.version} (build ${os.build})`], ['Arquitetura', os.arch], ['Instalado em', fmt.date(os.installed)], ['Último boot', fmt.dateTime(os.lastBoot)], ['Ligado há', '–']])),
      infoCard('Placa-mãe', kv([['Fabricante', board.maker], ['Modelo', board.model], ['BIOS', board.bios], ['Data da BIOS', fmt.date(board.biosDate)]])),
    );

    systemColumns[1].replaceChildren(
      infoCard('Processador', kv([['Modelo', cpu.name], ['Núcleos / threads', `${cpu.cores} / ${cpu.threads}`], ['Clock base', orDash(cpu.maxMHz, (v) => `${(v / 1000).toFixed(2)} GHz`)], ['Cache', `L2 ${cpu.l2KB / 1024} MB · L3 ${cpu.l3KB / 1024} MB`]])),
      infoCard('Memória', kv([['Total', `${memory.totalGB} GB`], ...memory.modules.map((m) => [m.slot, `${m.sizeGB} GB ${m.type} ${m.speed || ''} MHz`.replace(/\s+/g, ' ')])])),
      infoCard('Vídeo', ...gpus.map((gpu) => kv([['Placa', gpu.name], ['VRAM', `${gpu.vramGB} GB`], ['Driver', gpu.driver]]))),
    );

    systemColumns[2].replaceChildren(
      infoCard('Armazenamento',
        kv(storage.map((disk) => [disk.model, `${disk.sizeGB} GB ${disk.type} ${disk.bus}`.replace(/\s+/g, ' ')])),
        h('div', { class: 'divider' }),
        h('div', { class: 'drives' }, ...data.drives.map((drive) => {
          const usage = bar();
          usage.set(((drive.totalGB - drive.freeGB) / drive.totalGB) * 100);
          return h('div', { class: 'drive' }, h('div', { class: 'row' }, h('span', { text: `${drive.name} ${drive.label || ''} · ${drive.fs}`.trim() }), h('b', { text: `${drive.freeGB} / ${drive.totalGB} GB livres` })), usage.el);
        }))),
      infoCard('Rede', ...network.map((adapter) => kv([[adapter.name, adapter.ip], ['Link', adapter.speed], ['MAC', adapter.mac]]))),
      infoCard('Monitores', kv(monitors.map((monitor) => [monitor.name + (monitor.primary ? ' ★' : ''), `${monitor.width}×${monitor.height}`]))),
    );
    uptimeEl = systemColumns[0].querySelector('dl dd:last-child'); // the "Ligado há" row, ticked every second
    paintUptime();
  }

  function paintUptime() {
    if (uptimeEl && bootTime) uptimeEl.textContent = fmt.duration((Date.now() - bootTime) / 1000);
  }

  // --- Processos ------------------------------------------------------------------------------

  const cpuList = h('div', { class: 'scroll' });
  const memList = h('div', { class: 'scroll' });
  const processesEl = h('section', { class: 'processes-page' }, h('div', { class: 'card' }, h('h3', { text: 'Maiores usos de CPU' }), cpuList), h('div', { class: 'card' }, h('h3', { text: 'Maiores usos de memória' }), memList));

  function renderProcesses(list, items, valueOf, share) {
    list.replaceChildren(...items.map((item) => {
      const usage = bar();
      usage.set(share(item));
      return h('div', { class: 'proc' },
        h('div', { class: 'name' }, item.name, item.count > 1 ? h('small', { text: ` ×${item.count}` }) : null),
        h('div', { class: 'val', text: valueOf(item) }),
        usage.el);
    }));
  }

  function updateProcesses({ cpu, mem }) {
    const topCpu = Math.max(1, ...cpu.map((item) => item.cpu));
    const topMem = Math.max(1, ...mem.map((item) => item.memMB));
    renderProcesses(cpuList, cpu, (item) => `${item.cpu.toFixed(1)}%`, (item) => (item.cpu / topCpu) * 100);
    renderProcesses(memList, mem, (item) => fmt.gb(item.memMB), (item) => (item.memMB / topMem) * 100);
  }

  // --- lifecycle ------------------------------------------------------------------------------

  const timers = { clock: null };
  const watchers = { sample: null, processes: null }; // live updates (or the fallback poller) while a page is the visible one

  async function loadInfo() {
    if (info) return;
    try {
      info = await api('/api/monitor/info');
      renderInfo(info);
    } catch (err) {
      systemLoading.textContent = `Não foi possível ler o sistema: ${err.message}`;
    }
  }

  Deck.addPage({
    id: 'monitor',
    section: 'monitor',
    title: 'Desempenho',
    el: monitorEl,
    show() {
      // the monitor helper starts on demand (a few seconds the first time) and stops again when idle
      Deck.game?.monitorOpen(true);
      if (!latest) cpuCard.sub.textContent = 'iniciando sensores…';
      if (watchers.sample) watchers.sample.stop();
      // every sample is new (the numbers always move): no slowing down when "unchanged"
      watchers.sample = Deck.live.watch('monitor', {
        apply: (sample) => { latest = sample; updatePerformance(sample); },
        poll: () => api('/api/monitor/sample'),
        ms: SAMPLE_MS,
        idleAfter: Infinity,
      });
    },
    hide() {
      Deck.game?.monitorOpen(false);
      if (watchers.sample) watchers.sample.stop();
      watchers.sample = null;
    },
  });

  // Hardware and OS facts are rarely needed: a sheet opened from the menu instead of a page on the swipe path
  const systemSheet = Deck.overlay({
    title: 'Sobre este PC',
    el: systemEl,
    onOpen() {
      loadInfo();
      clearInterval(timers.clock);
      timers.clock = setInterval(paintUptime, 1000);
    },
    onClose() { clearInterval(timers.clock); },
  });
  Deck.menuItems.push({ label: 'Sobre este PC', onClick: () => systemSheet.open() });

  Deck.addPage({
    id: 'processes',
    section: 'processes',
    title: 'Processos',
    el: processesEl,
    show() {
      if (watchers.processes) watchers.processes.stop();
      watchers.processes = Deck.live.watch('processes', {
        apply: updateProcesses,
        poll: () => api('/api/monitor/processes'),
        ms: PROCESS_MS,
        idleAfter: Infinity,
      });
    },
    hide() {
      if (watchers.processes) watchers.processes.stop();
      watchers.processes = null;
    },
  });
})();
