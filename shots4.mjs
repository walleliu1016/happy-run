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

// 1. 横屏手机首屏 = 海报墙
await shot('game-home-landscape', { width: 851, height: 394 }, '', async (page) => {
  const st = await page.evaluate(() => ({
    active: document.querySelector('.screen.active')?.id,
    posters: document.querySelectorAll('.level-poster').length,
  }));
  console.log('home:', JSON.stringify(st));
});

// 2. 竖屏手机首屏 = 海报墙
await shot('game-home-portrait', { width: 393, height: 852 }, '', async (page) => {
  const st = await page.evaluate(() => document.querySelectorAll('.level-poster').length);
  console.log('home-portrait posters:', st);
});

// 3. 点 LV1 进开玩准备（横屏）
await shot('game-prepare-landscape', { width: 851, height: 394 }, '', async (page) => {
  await page.click('.level-poster[data-level="circus-run"]');
  await page.waitForTimeout(600);
  const st = await page.evaluate(() => ({
    active: document.querySelector('.screen.active')?.id,
    head: document.querySelector('#prepare-head')?.textContent?.replace(/\s+/g, ' ').trim(),
    start: document.querySelector('#btn-start')?.textContent,
  }));
  console.log('prepare:', JSON.stringify(st));
});

// 4. 点开始挑战 → 过场 → 对局（竖屏，全流程通畅验证）
await shot('game-ingame', { width: 393, height: 852 }, '', async (page) => {
  await page.click('.level-poster[data-level="circus-run"]');
  await page.waitForTimeout(500);
  await page.click('#btn-start');
  await page.waitForTimeout(3600); // 过场卡 2.6s + 开局
  const st = await page.evaluate(() => document.querySelector('.screen.active')?.id);
  console.log('after-start:', st);
});

// 5. TV 首屏海报墙
await shot('game-home-tv', { width: 1920, height: 1080 }, '?tv=1');

await browser.close();
