'use strict';

// Makes the pictures of the interface used by the README and the guides (docs/img/*.png), from the made-up PC of the browser tests
// (web/e2e/harness.cjs): no real window title, program or host name is ever in them, so they can go in a public repository.
//
//   node tools/screenshots/run.cjs           (needs web/dist built: npm run build in web/, and Chrome, Brave or Edge)
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { fakeDeck, launchBrowser, findBrowser, sleep } = require('../../web/e2e/harness.cjs');
const { tapTab } = require('../../web/e2e/support.cjs');

const OUT = path.join(__dirname, '..', '..', 'docs', 'img');
const DIST = path.join(__dirname, '..', '..', 'web', 'dist', 'index.html');

// a camera that gives a coloured picture, so the preview of the camera page is not empty
const CAMERA = `
  navigator.mediaDevices.getUserMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const g = canvas.getContext('2d');
    const gradient = g.createLinearGradient(0, 0, 1280, 720);
    gradient.addColorStop(0, '#2b3a67'); gradient.addColorStop(1, '#c9a27e');
    g.fillStyle = gradient; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.beginPath(); g.arc(640, 330, 110, 0, Math.PI * 2); g.fill();
    g.fillRect(500, 470, 280, 250);
    return canvas.captureStream(15);
  };
`;

(async () => {
  if (!findBrowser()) { console.error('no Chrome, Brave or Edge found (set CHROME_PATH)'); process.exit(1); }
  if (!fs.existsSync(DIST)) { console.error('web/dist is not built: run `npm run build` in web/'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });

  const deck = await fakeDeck();
  // a deck that looks like someone's: more programs than the six of the tests
  deck.model.apps = ['Navegador', 'Terminal', 'Editor de código', 'Chat', 'Música', 'Jogos', 'Arquivos', 'Notas', 'Calendário', 'Planilha', 'Fotos', 'Câmera'].map((name, i) => ({ id: `app${i}`, name, hasIcon: false, iconVersion: '' }));
  deck.model.drives = [{ name: 'C:', label: 'Sistema', totalGB: 500, freeGB: 210 }, { name: 'D:', label: 'Jogos', totalGB: 1000, freeGB: 420 }, { name: 'E:', label: 'Arquivos', totalGB: 2000, freeGB: 1400 }];
  deck.model.cameraWanted = true;
  // pictures for the keys (the real agent sends the icons of the programs): a colored square with the first letter, so the tones of the keys show
  const COLORS = ['#3b82f6', '#14b8a6', '#8b5cf6', '#22c55e', '#ec4899', '#f97316', '#eab308', '#06b6d4', '#ef4444', '#16a34a', '#a855f7', '#64748b'];
  deck.model.apps.forEach((app, i) => {
    deck.model.icons[app.id] = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${COLORS[i % COLORS.length]}"/><text x="32" y="44" font-size="32" font-weight="700" text-anchor="middle" fill="#fff" font-family="Segoe UI, sans-serif">${app.name.charAt(0)}</text></svg>`;
    app.hasIcon = true;
    app.iconVersion = '1';
  });
  // live-looking numbers (waves), so the charts of PC have a history to draw
  deck.model.sampleHook = (sample) => {
    const t = Date.now() / 1000;
    const wave = (base, amp, speed, phase = 0) => Math.round(Math.max(1, Math.min(99, base + amp * Math.sin(t * speed + phase) + amp * 0.4 * Math.sin(t * speed * 2.7))));
    sample.cpu.usage = wave(38, 22, 1.3);
    sample.cpu.cores = Array.from({ length: 12 }, (_, i) => wave(35, 30, 1.1 + i * 0.07, i));
    sample.memory.usedPct = 48;
    if (sample.gpu) sample.gpu.usage = wave(45, 25, 0.9, 2);
    sample.network = [{ name: 'Ethernet', downBps: (wave(50, 45, 1.7) * 1024 * 120), upBps: (wave(30, 25, 1.1, 1) * 1024 * 12), speed: '1 Gbps' }];
    return sample;
  };
  const browsers = [];
  const open = async (width, height, script) => {
    const browser = await launchBrowser({ width, height });
    browsers.push(browser);
    const page = await browser.open(`${deck.url}/`, script ? { script } : {});
    await page.waitFor(`document.body.dataset.state === 'online'`, 'online', 9000);
    await sleep(900);
    return page;
  };
  const shot = async (page, name) => { await sleep(500); await page.shot(path.join(OUT, `${name}.png`)); console.log(`docs/img/${name}.png`); };

  try {
    // the phone in landscape (the deck's main use): 2400x1080 of the Galaxy A31 is 20:9
    const land = await open(1200, 540);
    for (const [section, name] of [['apps', 'apps'], ['shortcuts', 'atalhos'], ['windows', 'janelas'], ['sound', 'som'], ['pc', 'pc'], ['power', 'energia']]) {
      await tapTab(land, section);
      if (section === 'pc') for (let i = 0; i < 70; i += 1) { deck.model.pushMonitor(); await sleep(70); } // a history for the charts
      await shot(land, name);
    }

    // the cover of the README: three of the pages together, in a page of its own (the screenshots above, composed by the browser)
    const frame = (name, rotate, left, top, width, z) => `<img src="${pathToFileURL(path.join(OUT, `${name}.png`)).href}" style="position:absolute;left:${left}px;top:${top}px;width:${width}px;transform:rotate(${rotate}deg);z-index:${z};border-radius:18px;border:1px solid #2a2e3a;box-shadow:0 24px 60px rgba(0,0,0,.6)">`;
    const cover = path.join(os.tmpdir(), 'ssd-capa.html');
    fs.writeFileSync(cover, `<!doctype html><meta charset="utf-8"><body style="margin:0;width:1600px;height:700px;overflow:hidden;background:radial-gradient(ellipse at 50% 0%,#1a2036 0%,#0b0c10 62%);font-family:'Segoe UI',system-ui,sans-serif;color:#d7dae3">
      <div style="position:absolute;left:0;right:0;top:40px;text-align:center"><div style="font-size:54px;font-weight:700;letter-spacing:.01em">Self Stream Deck</div><div style="margin-top:8px;font-size:22px;color:#7d8394">O celular como painel de controle do PC</div></div>
      ${frame('pc', -4, 20, 250, 700, 1)}${frame('apps', 0, 400, 215, 800, 3)}${frame('som', 4, 880, 250, 700, 2)}</body>`);
    const coverBrowser = await launchBrowser({ width: 1600, height: 700 });
    browsers.push(coverBrowser);
    const capa = await coverBrowser.open(pathToFileURL(cover).href);
    await sleep(1500);
    await shot(capa, 'capa');

    // the same deck in portrait
    const portrait = await open(450, 975);
    await tapTab(portrait, 'apps');
    await shot(portrait, 'apps-retrato');

    // the notice when the PC is gone, with the button that only exists inside the Android app
    const notice = await open(1200, 540, 'window.Android = { lockScreen() {}, reconnect() {}, vibrate() {}, openSettings() {} };');
    deck.model.down = true;
    await notice.waitFor(`document.body.dataset.state === 'offline'`, 'offline', 9000);
    await shot(notice, 'sem-conexao');
    deck.model.down = false;

    // the page of the phone's camera
    const camera = await open(1200, 540, CAMERA);
    await camera.eval(`document.querySelector('#menu-btn, [aria-label="Configurações"], .nav-end button')?.click()`);
    await sleep(400);
    await camera.eval(`[...document.querySelectorAll('#menu-pop button, .menu button')].find((b) => /Câmera do celular/.test(b.textContent))?.click()`);
    await camera.waitFor(`document.querySelector('.camera-page')`, 'the camera page', 6000).catch(() => undefined);
    await sleep(500);
    await camera.eval(`document.querySelector('.cam-placeholder button')?.click()`);
    await sleep(1200);
    await shot(camera, 'camera');
  } finally {
    browsers.forEach((browser) => browser.close());
    deck.close();
  }
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
