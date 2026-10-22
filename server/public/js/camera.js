'use strict';

/**
 * "Câmera do celular": the phone's camera as a webcam for the PC. The page asks the phone for its camera, draws
 * frames into a canvas and posts them as JPEGs to the server (POST /api/camera/frame). The server republishes them as
 * an MJPEG stream that OBS shows in a Browser Source and offers to other apps as its Virtual Camera.
 * It opens as a full-screen sheet from the menu; while it transmits, a red camera icon in the header brings it back.
 */
(() => {
  const { h, icon, api, toast } = Deck;

  const FRAME_MS = 40; // 25 frames a second at best; slower when the link or the phone cannot keep up
  const JPEG_QUALITY = 0.72;
  const QUALITIES = { leve: { label: '480p', width: 854 }, hd: { label: '720p', width: 1280 } };

  let stream = null;
  let facing = 'user'; // 'user' = the front camera, 'environment' = the back one
  let quality = 'leve';
  let sending = false;
  let loopId = 0; // a running loop stops when this changes
  let statusTimer = null;

  // --- DOM ------------------------------------------------------------------------------------

  // the capture video lives outside the sheet: closing the sheet must not stop the picture that is being sent
  const capture = h('video', { muted: true, playsinline: true, autoplay: true, 'aria-hidden': 'true', style: 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none' });
  capture.muted = true;
  document.body.append(capture);
  const canvas = document.createElement('canvas');

  const preview = h('video', { muted: true, playsinline: true, autoplay: true, class: 'cam-video' });
  preview.muted = true;
  const placeholder = h('div', { class: 'cam-placeholder', text: 'Ligando a câmera…' });
  const view = h('div', { class: 'cam-view' }, preview, placeholder);

  const sendButton = h('button', { type: 'button', class: 'bigbtn cam-send', on: { click: () => (sending ? stopSending() : startSending()) } });
  const flipButton = h('button', { type: 'button', class: 'bigbtn', on: { click: flip } }, icon('swap', 24), h('span', { text: 'Virar câmera' }));
  const qualityChips = Object.entries(QUALITIES).map(([key, value]) => h('button', {
    type: 'button', class: 'chip big-chip', text: value.label, 'aria-pressed': String(key === quality),
    on: { click: () => { quality = key; paintQuality(); } },
  }));
  const copyButton = h('button', { type: 'button', class: 'cam-act', on: { click: copyLink } }, h('span', { text: 'Copiar link' }));
  const statusLine = h('div', { class: 'cam-status muted' });

  // two ways to reach the PC's apps; both are fed at the same time, use whichever one the app can see
  const directState = h('small', { class: 'muted' });
  const installButton = Deck.holdButton('Segure p/ instalar', () => directAction('install'), { className: 'cam-act' });
  const removeButton = Deck.holdButton('Segure p/ remover', () => directAction('uninstall'), { className: 'cam-act' });
  const directRow = h('div', { class: 'cam-dest' }, h('div', { class: 'cam-dest-text' }, h('b', { text: 'Câmera virtual direta' }), directState), installButton, removeButton);
  const obsRow = h('div', { class: 'cam-dest' }, h('div', { class: 'cam-dest-text' }, h('b', { text: 'Via OBS' }), h('small', { class: 'muted', text: 'Captura de navegador + Iniciar câmera virtual' })), copyButton);

  const side = h('div', { class: 'card cam-side' },
    sendButton,
    h('div', { class: 'cam-row' }, flipButton, h('div', { class: 'chips' }, ...qualityChips)),
    directRow, obsRow, statusLine);
  const el = h('section', { class: 'camera-page' }, view, side);

  const headerButton = Deck.$('cam');
  headerButton.replaceChildren(icon('camera', 18));

  function paintQuality() {
    Object.entries(QUALITIES).forEach(([key], index) => qualityChips[index].setAttribute('aria-pressed', String(key === quality)));
  }

  function paintSend() {
    sendButton.dataset.on = String(sending);
    sendButton.replaceChildren(icon(sending ? 'pause' : 'play', 24), h('span', { text: sending ? 'Parar transmissão' : 'Transmitir ao PC' }));
    headerButton.hidden = !sending;
    if (Deck.camera && Deck.camera.onChange) Deck.camera.onChange();
  }

  // --- the camera -----------------------------------------------------------------------------

  async function startCamera() {
    if (stream) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      placeholder.textContent = 'Este navegador não libera a câmera aqui. Use o app do Stream Deck.';
      return false;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch (err) {
      placeholder.textContent = err && err.name === 'NotAllowedError'
        ? 'A câmera está bloqueada. Permita o acesso à câmera para o app do Stream Deck.'
        : `Não foi possível abrir a câmera (${err && err.name ? err.name : 'erro'}).`;
      placeholder.hidden = false;
      return false;
    }
    stream.getVideoTracks().forEach((track) => track.addEventListener('ended', onEnded));
    capture.srcObject = stream;
    preview.srcObject = stream;
    preview.dataset.mirror = String(facing === 'user'); // a mirror for the person looking; the PC gets the unmirrored picture
    await Promise.allSettled([capture.play(), preview.play()]);
    placeholder.hidden = true;
    return true;
  }

  function stopCamera() {
    if (!stream) return;
    stream.getTracks().forEach((track) => { track.removeEventListener('ended', onEnded); track.stop(); });
    stream = null;
    capture.srcObject = null;
    preview.srcObject = null;
    placeholder.textContent = 'Câmera desligada';
    placeholder.hidden = false;
  }

  // the system took the camera away (screen off, another app): get it back if we were transmitting
  function onEnded() {
    stream = null;
    if (sending) setTimeout(() => startCamera(), 800);
  }

  async function flip() {
    facing = facing === 'user' ? 'environment' : 'user';
    stopCamera();
    placeholder.textContent = 'Trocando de câmera…';
    await startCamera();
  }

  // --- sending --------------------------------------------------------------------------------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // When nobody uses the picture (no OBS source watching, no app with the virtual camera open) one frame a second is enough:
  // the PC says so in every answer, and the phone goes back to full speed on the first answer that says someone does.
  const IDLE_FRAME_MS = 1000;
  const IDLE_AFTER = 3; // consecutive "nobody" answers before slowing down, so a short gap does not make it flap
  let nobody = 0;
  let idle = false;

  async function loop(id) {
    nobody = 0;
    idle = false;
    while (sending && id === loopId) {
      const started = performance.now();
      if (capture.readyState >= 2 && capture.videoWidth > 0 && !document.hidden) {
        const width = Math.min(QUALITIES[quality].width, capture.videoWidth);
        const height = Math.round((width * capture.videoHeight) / capture.videoWidth);
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        canvas.getContext('2d').drawImage(capture, 0, 0, width, height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
        if (!blob) continue;
        try {
          const response = await fetch('/api/camera/frame', { method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (response.headers.get('X-Camera-Wanted') === '0') {
            nobody += 1;
            if (nobody >= IDLE_AFTER) idle = true;
          } else {
            nobody = 0;
            idle = false;
          }
        } catch {
          await sleep(600); // the PC is unreachable for a moment: do not spin
        }
      } else {
        await sleep(200);
      }
      await sleep(Math.max(0, (idle ? IDLE_FRAME_MS : FRAME_MS) - (performance.now() - started)));
    }
  }

  async function startSending() {
    if (!(await startCamera())) return;
    sending = true;
    loopId += 1;
    paintSend();
    pollStatus();
    loop(loopId);
  }

  function stopSending() {
    sending = false;
    loopId += 1;
    paintSend();
    if (!sheet.isOpen) stopCamera();
    paintStatus(null);
  }

  // --- status ---------------------------------------------------------------------------------

  let direct = { installed: false, inUse: false, name: 'Stream Deck Camera' };

  function paintDirect() {
    installButton.hidden = direct.installed;
    removeButton.hidden = !direct.installed;
    directState.textContent = direct.installed
      ? `Instalada como “${direct.name}”: escolha-a no Discord, Zoom, navegador…${direct.inUse ? ' · em uso agora' : ''}`
      : 'Aparece como webcam em qualquer app, sem OBS. Instala uma vez (administrador).';
  }

  function paintStatus(status) {
    if (status && status.direct) {
      direct = status.direct;
      paintDirect();
    }
    if (!status || !sending) {
      statusLine.textContent = sending ? 'Transmitindo…' : 'Pronto: toque em Transmitir ao PC.';
      return;
    }
    const watching = status.viewers > 0 ? 'OBS conectado' : (direct.inUse ? 'câmera direta em uso' : 'nenhum app usando ainda');
    if (status.live && !status.wanted) statusLine.textContent = 'Transmitindo em espera: nenhum app usa a câmera (1 quadro/s, economiza bateria)';
    else statusLine.textContent = status.live ? `Transmitindo · ${status.fps} fps · ${status.kbps} KB/s · ${watching}` : 'Aguardando o PC receber…';
  }

  async function pollStatus() {
    try {
      paintStatus(await api('/api/camera/status'));
    } catch {
      statusLine.textContent = 'Sem conexão com o PC';
    }
  }

  // installing registers a camera device for the whole PC (administrator), removing takes it away again
  async function directAction(action) {
    toast(action === 'install' ? 'Instalando a câmera virtual…' : 'Removendo a câmera virtual…');
    try {
      await api(`/api/camera/direct/${action}`, { method: 'POST', json: { confirm: true } });
      toast(action === 'install' ? 'Câmera virtual instalada' : 'Câmera virtual removida');
    } catch (err) {
      toast(`Erro: ${err.message}`, true);
    }
    pollStatus();
  }

  async function copyLink() {
    try {
      await api('/api/camera/copy-link', { method: 'POST' });
      toast('Link copiado no PC: cole no OBS (Ctrl+V)');
    } catch (err) {
      toast(`Erro: ${err.message}`, true);
    }
  }

  // --- the sheet ------------------------------------------------------------------------------

  const sheet = Deck.overlay({
    title: 'Câmera do celular',
    el,
    onOpen() {
      paintSend();
      paintQuality();
      startCamera();
      pollStatus();
      clearInterval(statusTimer);
      statusTimer = setInterval(() => { if (!document.hidden) pollStatus(); }, 2000);
    },
    onClose() {
      clearInterval(statusTimer);
      statusTimer = null;
      if (!sending) stopCamera(); // transmitting keeps the camera on; a mere preview does not
    },
  });

  // for the apps page: one tap on the camera key turns the transmission on or off
  Deck.camera = {
    get sending() { return sending; },
    async toggle() {
      if (sending) {
        stopSending();
        toast('Câmera desligada');
        return;
      }
      await startSending();
      if (sending) toast('Câmera ligada: transmitindo ao PC');
    },
    // used by macros: switch to the wanted state, whatever the current one is
    async set(wanted) {
      if (wanted !== sending) await this.toggle();
    },
    openSheet: () => sheet.open(),
    onChange: null,
  };

  headerButton.addEventListener('click', () => sheet.open());
  Deck.menuItems.push({ label: 'Câmera do celular', onClick: () => sheet.open() });
  paintSend();
  paintStatus(null);
})();
