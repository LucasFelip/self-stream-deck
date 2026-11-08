'use strict';

// The phone camera as the PC webcam, in the new interface and in a real headless browser against the fake deck server: opening the sheet does
// not ask for the camera, the preview, the transmission (frames go to the PC at full speed or one a second when nobody uses them), the camera
// key on Apps, a macro that turns the camera on, the two ways to reach the PC's apps. The first two cases are the old interface's.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fakeDeck, launchBrowser, findBrowser, sleep } = require('./harness.cjs');
const { tapTab, tapUntil, posts } = require('./support.cjs');

const DIST = path.join(__dirname, '..', 'dist', 'index.html');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok     ${name}`); };

// a camera that gives a coloured canvas as its picture
const FAKE_CAMERA = `
  window.__gum = 0;
  navigator.mediaDevices.getUserMedia = async () => {
    window.__gum += 1;
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const g = canvas.getContext('2d');
    let n = 0;
    setInterval(() => { g.fillStyle = 'hsl(' + ((n += 1) * 7 % 360) + ', 60%, 50%)'; g.fillRect(0, 0, 640, 360); }, 50);
    const stream = canvas.captureStream(10);
    window.__tracks = stream.getVideoTracks();
    return stream;
  };
`;
const BLOCKED_CAMERA = `
  window.__gum = 0;
  navigator.mediaDevices.getUserMedia = async () => { window.__gum += 1; throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' }); };
`;

(async () => {
  if (!findBrowser()) { console.log('skipped (no Chrome, Brave or Edge found; set CHROME_PATH)'); return; }
  if (!fs.existsSync(DIST)) { console.log('skipped (web/dist is not built: npm run build)'); return; }

  const deck = await fakeDeck();
  const extra = [];
  const open = async (script, width = 411, height = 914) => {
    const browser = await launchBrowser({ width, height });
    extra.push(browser);
    const page = await browser.open(`${deck.url}/`, { script });
    await page.waitFor(`document.querySelectorAll('.tile[data-key]').length >= 6`, 'the apps grid');
    await page.waitFor(`document.body.dataset.state === 'online'`, 'online', 9000);
    await sleep(400);
    return { page, close: () => browser.close() };
  };
  const openSheet = async (page) => {
    await tapUntil(page, '#menu', `!document.getElementById('menu-pop').hidden`, 'the menu');
    await sleep(300);
    await page.eval(`[...document.querySelectorAll('#menu-pop button')].find((b) => b.textContent.trim() === 'Câmera do celular').click()`);
    await page.waitFor(`!document.querySelector('.camera-page').closest('.overlay').hidden`, 'the camera sheet');
  };
  const sheetOpen = (page) => page.eval(`!document.querySelector('.camera-page').closest('.overlay').hidden`);
  const frames = () => deck.model.frames;

  try {
    await test('Câmera do celular: opening the sheet does not ask for the camera; "Ver prévia" and "Transmitir ao PC" do', async () => {
      const { page, close } = await open(BLOCKED_CAMERA);
      try {
        await openSheet(page);
        await sleep(400);
        assert.strictEqual(await page.eval('window.__gum'), 0, 'opening the sheet asked for the camera');
        assert.strictEqual(await page.eval(`document.querySelector('.cam-placeholder button').hidden`), false, 'the Ver prévia button is there');
        assert.strictEqual(await page.eval(`getComputedStyle(document.querySelector('.cam-video')).visibility`), 'hidden', 'the empty video (WebView play poster) is hidden while there is no stream');
        await page.tap('.cam-placeholder button');
        await page.waitFor('window.__gum === 1', 'getUserMedia after Ver prévia');
        await page.waitFor(`/A câmera está bloqueada/.test(document.querySelector('.cam-placeholder span').textContent)`, 'the blocked explanation');
        await page.tap('.cam-send');
        await page.waitFor('window.__gum === 2', 'getUserMedia after Transmitir ao PC');
        assert.strictEqual(await page.eval(`document.querySelector('.cam-send').dataset.on`), 'false', 'nothing is transmitting without a camera');
        assert.deepStrictEqual(page.errors, []);
      } finally { close(); }
    });

    await test('Câmera do celular: the preview video shows once there is a stream, mirrored for the front camera, and hides again on close', async () => {
      const { page, close } = await open(FAKE_CAMERA);
      try {
        await openSheet(page);
        const visibility = () => page.eval(`getComputedStyle(document.querySelector('.cam-video')).visibility`);
        assert.strictEqual(await visibility(), 'hidden', 'hidden before Ver prévia');
        await page.tap('.cam-placeholder button');
        await page.waitFor(`document.querySelector('.cam-video').dataset.live === 'true'`, 'the preview going live');
        assert.strictEqual(await visibility(), 'visible', 'visible with a stream');
        assert.strictEqual(await page.eval(`document.querySelector('.cam-video').dataset.mirror`), 'true', 'the front camera is mirrored');
        assert.strictEqual(await page.eval(`document.querySelector('.cam-placeholder').hidden`), true);
        // the other camera is not mirrored
        await page.tap('.cam-row .bigbtn');
        await page.waitFor(`window.__gum === 2 && document.querySelector('.cam-video').dataset.mirror === 'false'`, 'the back camera, not mirrored');
        await page.eval(`document.querySelector('.camera-page').closest('.overlay').querySelector('.overlay-close').click()`);
        await page.waitFor(`document.querySelector('.cam-video').dataset.live === 'false'`, 'the preview stopping');
        assert.strictEqual(await visibility(), 'hidden', 'hidden again after closing');
        assert.strictEqual(await page.eval(`window.__tracks.every((t) => t.readyState === 'ended')`), true, 'the camera is off, not just hidden');
      } finally { close(); }
    });

    await test('Câmera do celular: transmitting sends frames to the PC, keeps going when the sheet closes, and stops on request', async () => {
      deck.model.cameraWanted = true;
      const { page, close } = await open(FAKE_CAMERA);
      try {
        await openSheet(page);
        const before = frames();
        await tapUntil(page, '.cam-send', `document.querySelector('.cam-send').dataset.on === 'true'`, 'transmitting');
        assert.match(await page.eval(`document.querySelector('.cam-send').textContent`), /Parar transmissão/);
        await page.waitFor('true');
        await sleep(2000);
        assert.ok(frames() - before >= 8, `frames reach the PC at speed: ${frames() - before}`);
        deck.model.cameraStatus = { live: true, fps: 24, kbps: 310, viewers: 0, wanted: true, ageMs: 40 };
        await page.waitFor(`/^Transmitindo · 24 fps · 310 KB\\/s · nenhum app usando ainda$/.test(document.querySelector('.cam-status').textContent)`, 'the status line', 6000);
        deck.model.cameraStatus = { live: true, fps: 24, kbps: 310, viewers: 1, wanted: true, ageMs: 40 };
        await page.waitFor(`/OBS conectado$/.test(document.querySelector('.cam-status').textContent)`, 'OBS connected', 6000);
        // closing the sheet does not stop the picture
        await page.eval(`document.querySelector('.camera-page').closest('.overlay').querySelector('.overlay-close').click()`);
        const afterClose = frames();
        await sleep(1200);
        assert.ok(frames() - afterClose >= 4, 'it keeps sending with the sheet closed');
        assert.strictEqual(await page.eval(`document.querySelector('.tile[data-key="c:camera"]').classList.contains('live')`), true, 'the camera key shows it');
        await openSheet(page);
        await tapUntil(page, '.cam-send', `document.querySelector('.cam-send').dataset.on === 'false'`, 'stopped');
        await sleep(500);
        const stopped = frames();
        await sleep(1200);
        assert.ok(frames() - stopped <= 1, 'no frames after stopping');
        assert.match(await page.eval(`document.querySelector('.cam-status').textContent`), /Câmera desligada/);
      } finally { deck.model.cameraStatus = { live: false, fps: 0, kbps: 0, viewers: 0, wanted: false, ageMs: null }; close(); }
    });

    await test('Câmera do celular: when nobody uses the picture the phone sends one frame a second', async () => {
      deck.model.cameraWanted = false;
      const { page, close } = await open(FAKE_CAMERA);
      try {
        await openSheet(page);
        await tapUntil(page, '.cam-send', `document.querySelector('.cam-send').dataset.on === 'true'`, 'transmitting');
        await sleep(2500); // three answers saying "nobody" slow it down
        const slow = frames();
        await sleep(3200);
        const rate = frames() - slow;
        assert.ok(rate >= 1 && rate <= 6, `about one a second, not ${rate / 3.2} per second`);
        deck.model.cameraWanted = true; // somebody opens the camera in an app: full speed again at the next answer
        await page.waitFor('true');
        const resumed = frames();
        await sleep(2500);
        assert.ok(frames() - resumed >= 8, `back to full speed: ${frames() - resumed}`);
        await tapUntil(page, '.cam-send', `document.querySelector('.cam-send').dataset.on === 'false'`, 'stopped');
      } finally { deck.model.cameraWanted = true; close(); }
    });

    await test('the camera key on Apps turns the transmission on and off, says so, and edit mode has nothing to edit on it', async () => {
      const { page, close } = await open(FAKE_CAMERA);
      try {
        assert.strictEqual(await page.eval(`document.querySelector('.tile[data-key="c:camera"]').getAttribute('aria-label')`), 'Câmera');
        await tapUntil(page, '.tile[data-key="c:camera"]', `document.getElementById('toast').textContent === 'Câmera ligada: transmitindo ao PC'`, 'the on notice');
        await page.waitFor(`document.querySelector('.tile[data-key="c:camera"]').classList.contains('live')`, 'the red dot');
        await sleep(600);
        await tapUntil(page, '.tile[data-key="c:camera"]', `document.getElementById('toast').textContent === 'Câmera desligada'`, 'the off notice');
        await page.waitFor(`!document.querySelector('.tile[data-key="c:camera"]').classList.contains('live')`, 'the dot gone');
        // edit mode: the camera key is not editable
        await tapUntil(page, '#menu', `!document.getElementById('menu-pop').hidden`, 'the menu');
        await sleep(300);
        await page.eval(`[...document.querySelectorAll('#menu-pop button')].find((b) => b.textContent.trim() === 'Editar botões').click()`);
        await page.waitFor(`document.body.classList.contains('editing')`, 'edit mode');
        await tapUntil(page, '.tile[data-key="c:camera"]', `document.getElementById('toast').textContent === 'A tecla da câmera não tem o que editar'`, 'the notice');
        assert.strictEqual(await page.eval(`!document.querySelector('.editor-page').closest('.overlay').hidden`), false);
      } finally { close(); }
    });

    await test('a macro with a camera step turns the camera on in the phone', async () => {
      deck.model.macros = [{ id: 'ligar', label: 'Ligar câmera', page: 'apps', steps: 1 }];
      deck.model.macroClient = [{ type: 'camera', on: true }];
      const { page, close } = await open(FAKE_CAMERA);
      try {
        await tapUntil(page, '.tile[data-key="m:ligar"]', `document.querySelector('.tile[data-key="c:camera"]').classList.contains('live')`, 'the camera transmitting');
        assert.ok(posts(deck, '/api/macro/ligar').length >= 1);
      } finally { deck.model.macros = []; deck.model.macroClient = []; close(); }
    });

    await test('Câmera do celular: the direct virtual camera is installed by holding, shows as installed, and the OBS link is copied on the PC', async () => {
      deck.model.direct = { name: 'Stream Deck Camera', installed: false, inUse: false, busy: false };
      const { page, close } = await open(FAKE_CAMERA);
      try {
        await openSheet(page);
        assert.match(await page.eval(`document.querySelector('.cam-dest small').textContent`), /Instala uma vez/);
        assert.strictEqual(await page.eval(`document.querySelector('.cam-dest .hold').textContent`), 'Segure p/ instalar');
        deck.model.calls.length = 0;
        await page.tap('.cam-dest .hold');
        await sleep(300);
        assert.strictEqual(posts(deck, '/api/camera/direct/install').length, 0, 'a tap does not install');
        const c = await page.center('.cam-dest .hold');
        await page.touch('touchStart', c.x, c.y);
        await sleep(1400);
        await page.touch('touchEnd', c.x, c.y);
        await page.waitFor(`document.querySelector('.cam-dest .hold')?.textContent === 'Segure p/ remover'`, 'installed');
        assert.deepStrictEqual(posts(deck, '/api/camera/direct/install').map((x) => x.body), [{ confirm: true }]);
        assert.match(await page.eval(`document.querySelector('.cam-dest small').textContent`), /Instalada como “Stream Deck Camera”/);
        deck.model.calls.length = 0;
        await tapUntil(page, '.cam-dest:nth-of-type(3) .cam-act', `document.getElementById('toast').textContent.startsWith('Link copiado')`, 'the copy notice');
        assert.ok(posts(deck, '/api/camera/copy-link').length >= 1);
      } finally { deck.model.direct = { name: 'Stream Deck Camera', installed: false, inUse: false, busy: false }; close(); }
    });

    await test('Câmera do celular: the sheet closes with Back, the quality chips switch, and the page raised no script errors', async () => {
      const { page, close } = await open(FAKE_CAMERA);
      try {
        await openSheet(page);
        assert.deepStrictEqual(await page.eval(`[...document.querySelectorAll('.cam-row .chip')].map((c) => [c.textContent, c.getAttribute('aria-pressed')])`), [['480p', 'true'], ['720p', 'false']]);
        await page.tap('.cam-row .chip:nth-child(2)');
        await page.waitFor(`document.querySelector('.cam-row .chip:nth-child(2)').getAttribute('aria-pressed') === 'true'`, '720p');
        assert.strictEqual(await page.eval('Deck.back()'), true);
        await page.waitFor(`document.querySelector('.camera-page').closest('.overlay').hidden`, 'closed');
        assert.strictEqual(await sheetOpen(page), false);
        await tapTab(page, 'sound');
        await tapTab(page, 'apps');
        assert.deepStrictEqual(page.errors, []);
      } finally { close(); }
    });
  } finally {
    extra.forEach((browser) => browser.close());
    deck.close();
  }
  console.log(`${passed} passed`);
  process.exit(0); // the page's open event stream would keep the fake server (and so the process) alive
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
