import { chromium } from '/Users/akke/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

async function shot(name, viewport, path, fn) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:43211/' + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  if (fn) await fn(page);
  await page.screenshot({ path: `shots/${name}.png` });
  await ctx.close();
  console.log('ok', name);
}

// 1. 竖屏首屏：海报墙 + ⚙️ 设置入口
await shot('ia-home', { width: 393, height: 852 }, '', async (page) => {
  const st = await page.evaluate(() => ({
    settingsBtn: !!document.querySelector('#btn-settings'),
    posters: document.querySelectorAll('.level-poster').length,
  }));
  console.log('home:', JSON.stringify(st));
});

// 2. 点 LV1 → 准备屏（hero + 难度/模式，无音乐工坊）
await shot('ia-prepare-level', { width: 393, height: 852 }, '', async (page) => {
  await page.click('.level-poster[data-level="circus-run"]');
  await page.waitForTimeout(600);
  const st = await page.evaluate(() => ({
    active: document.querySelector('.screen.active')?.id,
    hero: document.querySelector('#prepare-hero')?.textContent?.replace(/\s+/g, ' ').trim(),
    musicHidden: document.querySelector('#music-card')?.hidden,
  }));
  console.log('prepare-level:', JSON.stringify(st));
});

// 3. 点 FREE → 准备屏（音乐工坊显示）
await shot('ia-prepare-free', { width: 393, height: 852 }, '', async (page) => {
  await page.click('.level-poster.free');
  await page.waitForTimeout(600);
  const st = await page.evaluate(() => ({
    active: document.querySelector('.screen.active')?.id,
    musicHidden: document.querySelector('#music-card')?.hidden,
  }));
  console.log('prepare-free:', JSON.stringify(st));
  await page.evaluate(() => document.querySelector('.prepare-wrap').scrollTo(0, 600));
  await page.waitForTimeout(300);
});

// 4. 设置屏（首屏 ⚙️ 进）
await shot('ia-settings', { width: 393, height: 852 }, '', async (page) => {
  await page.click('#btn-settings');
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => document.querySelector('.screen.active')?.id);
  console.log('settings:', st);
});

// 5. TV 首屏
await shot('ia-home-tv', { width: 1920, height: 1080 }, '?tv=1');

await browser.close();
