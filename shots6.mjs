import { chromium } from '/Users/akke/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs';

const BASE = 'http://127.0.0.1:43211';

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

async function snap(name, viewport, prep) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  if (prep) await prep(page);
  await page.screenshot({ path: `shots/${name}.png` });
  // 量化：卡片尺寸 + 内容矩形
  const data = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.level-poster')];
    return cards.map((c) => {
      const r = c.getBoundingClientRect();
      const lv = c.querySelector('.lp-lv')?.getBoundingClientRect();
      const name = c.querySelector('.lp-name')?.getBoundingClientRect();
      const emoji = c.querySelector('.lp-emoji')?.getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        lvTop: Math.round(lv.top - r.top), nameTop: Math.round(name.top - r.top),
        emojiH: Math.round(emoji.height),
      };
    });
  });
  console.log(name, JSON.stringify(data));
  await ctx.close();
}

await snap('card-home', { width: 390, height: 844 });
await snap('card-home-wide', { width: 1280, height: 800 });
await snap('card-home-tv', { width: 1920, height: 1080 }, async (page) => {
  await page.evaluate(() => document.documentElement.classList.add('tv-mode'));
  await page.waitForTimeout(300);
});

await browser.close();
console.log('done');
