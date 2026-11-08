'use strict';

// Helpers shared by the browser tests of the new interface. `page` is a page of web/e2e/harness.cjs (CDP, no dependencies).
const { sleep } = require('./harness.cjs');

/** opens a section by its tab; a tap during the redraw right after coming online is undone, so it taps again until it sticks */
async function tapTab(page, section) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sleep(300);
    await page.tap(`#tabs .tab[data-section="${section}"]`);
    if (await page.waitFor(`document.querySelector('#tabs .tab[data-section="${section}"]').getAttribute('aria-selected') === 'true'`, `the ${section} tab`, 1500).then(() => true, () => false)) return;
  }
  throw new Error(`could not open ${section}`);
}

/** a tap that lands while the page is redrawing (right after an answer arrived) is undone: tap again until `done` holds */
async function tapUntil(page, selector, done, what) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sleep(300);
    await page.tap(selector);
    if (await page.waitFor(done, what, 1500).then(() => true, () => false)) return;
  }
  const where = await page.eval(`JSON.stringify({ section: document.querySelector('#tabs .tab[aria-selected="true"]')?.dataset.section, sheets: document.getElementById('modal-root').innerHTML.slice(0, 160) })`).catch(() => '?');
  throw new Error(`timed out waiting for: ${what} (${where})`);
}

/** presses and holds an element with a finger */
async function hold(page, selector, ms = 1400) {
  const { x, y } = await page.center(selector);
  await page.touch('touchStart', x, y);
  await sleep(ms);
  await page.touch('touchEnd', x, y);
}

/** the requests the fake deck received, of one method and path */
const posts = (deck, path) => deck.model.calls.filter((c) => c.method === 'POST' && c.path === path);

/** sets a range input the way a finger would (React listens to the `input` event) */
const setRange = (page, selector, value) => page.eval(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(String(value))});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`);

module.exports = { tapTab, tapUntil, hold, posts, setRange };
