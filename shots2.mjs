// Menu interaction rework check: single-page scroll config on phone + TV
import { chromium } from '/Users/akke/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs';

const base = 'http://127.0.0.1:43211/';
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
    '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

const shots = [
  { name: 'rework-phone-top', vp: { width: 390, height: 844 }, scroll: 0 },
  { name: 'rework-phone-bottom', vp: { width: 390, height: 844 }, scroll: -1 },
  { name: 'rework-tv-top', vp: { width: 1920, height: 1080 }, scroll: 0 },
  { name: 'rework-tv-bottom', vp: { width: 1920, height: 1080 }, scroll: -1 },
];

for (const s of shots) {
  const page = await browser.newPage({ viewport: s.vp });
  const tv = s.name.includes('tv');
  await page.goto(base + (tv ? '?tv=1' : ''), { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  if (!tv && await page.locator('#btn-skip').isVisible().catch(() => false)) {
    await page.click('#btn-skip');
    await page.waitForTimeout(700);
  }
  await page.evaluate((toBottom) => {
    const wrap = document.querySelector('.menu-wrap');
    if (toBottom) wrap.scrollTop = wrap.scrollHeight;
    else wrap.scrollTop = 0;
  }, s.scroll === -1);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `shots/${s.name}.png` });
  console.log('shot:', s.name);
  await page.close();
}
await browser.close();
console.log('done');
