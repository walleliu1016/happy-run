// Dual-viewport visual check: phone 390x844 + TV 1920x1080 (?tv=1)
import { chromium } from '/Users/akke/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs';

const base = 'http://127.0.0.1:43211/';

// sample ghost challenge (same encoding as src/engine/ghost.ts: JSON -> utf8 -> base64url)
const ghost = {
  v: 1, name: '影子小明', date: '2026-11-22', bpm: 120, off: 0,
  ev: [[0, 0, 1, 0, 50], [500, 1, 2, 1, 50], [1000, 2, 3, 0, 50]],
  ph: [[0, 1]], tr: [[0, 0], [5000, 1200], [10000, 2400]],
  res: { score: 2400, combo: 30, grade: 'A' },
};
const ghostHash = Buffer.from(JSON.stringify(ghost), 'utf-8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
    '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

const shots = [
  { name: 'menu-phone', vp: { width: 390, height: 844 }, url: base, pre: 'skip' },
  { name: 'menu-phone-ghost', vp: { width: 390, height: 844 }, url: base + '#ghost=' + ghostHash, pre: 'skip' },
  { name: 'profile-phone', vp: { width: 390, height: 844 }, url: base, pre: 'profile' },
  { name: 'menu-tv', vp: { width: 1920, height: 1080 }, url: base + '?tv=1', pre: 'none' },
  { name: 'profile-tv', vp: { width: 1920, height: 1080 }, url: base + '?tv=1', pre: 'profile' },
];

for (const s of shots) {
  const page = await browser.newPage({ viewport: s.vp });
  await page.goto(s.url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  if (s.pre === 'skip') {
    await page.click('#btn-skip');
    await page.waitForTimeout(900);
  } else if (s.pre === 'profile') {
    if (await page.locator('#btn-skip').isVisible().catch(() => false)) {
      await page.click('#btn-skip');
      await page.waitForTimeout(600);
    }
    await page.click('#btn-profile');
    await page.waitForTimeout(900);
  }
  await page.screenshot({ path: `shots/${s.name}.png` });
  console.log('shot:', s.name);
  await page.close();
}
await browser.close();
console.log('done');
