import { chromium } from '/Users/akke/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs';

const BASE = 'http://127.0.0.1:43212';

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE ERR:', m.text()); });

await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: 'shots/pk-1-home.png' });

// 点 PK 卡进 PK 屏
await page.click('.level-poster.pk');
await page.waitForTimeout(500);
await page.screenshot({ path: 'shots/pk-2-lobby.png' });

// 开始匹配 → 匹配中
await page.click('#btn-pk-go');
await page.waitForTimeout(1500);
await page.screenshot({ path: 'shots/pk-3-matching.png' });

// 等影子匹配（服务端 6 秒兜底）→ matched 卡
await page.waitForTimeout(6500);
await page.screenshot({ path: 'shots/pk-4-matched.png' });

// 3 秒倒计时 + 过场卡 2.6 秒 → 游戏中
await page.waitForTimeout(6500);
await page.screenshot({ path: 'shots/pk-5-running.png' });

const state = await page.evaluate(() => ({
  active: document.querySelector('.screen.active')?.id,
  oppName: document.getElementById('gb-name')?.textContent,
  oppScore: document.getElementById('gb-rival')?.textContent,
  myScore: document.getElementById('gb-you')?.textContent,
  oppTag: document.getElementById('pk-opp-tag')?.textContent,
  mapInfo: document.getElementById('pk-map-info')?.textContent,
}));
console.log('STATE:', JSON.stringify(state));
await browser.close();
console.log('done');
