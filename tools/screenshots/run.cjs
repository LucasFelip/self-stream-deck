'use strict';

// Makes the pictures of the interface used by the README and the guides (docs/img/*.png), from the made-up PC of the browser tests
// (web/e2e/harness.cjs): no real window title, program or host name is ever in them, so they can go in a public repository.
//
//   node tools/screenshots/run.cjs           (needs web/dist built: npm run build in web/, and Chrome, Brave or Edge)
const fs = require('node:fs');
const path = require('node:path');
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
      await shot(land, name);
    }

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
