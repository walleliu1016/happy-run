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
await page.waitForTimeout(600);
await page.click('.level-poster.pk');
await page.waitForTimeout(300);
await page.fill('#pk-name', '测试拳手');
await page.click('#btn-pk-go');
// 匹配 6s + 倒计时 3s + 过场 2.6s + 一局 60~90s
await page.waitForSelector('#screen-result.active', { timeout: 150000 });
await page.waitForTimeout(4500); // 等对手成绩轮询出胜负文案
await page.screenshot({ path: 'shots/pk-6-result.png' });
const state = await page.evaluate(() => ({
  ghost: document.getElementById('rs-ghost')?.textContent,
  ghostHidden: document.getElementById('rs-ghost')?.hidden,
  win: document.getElementById('rs-ghost')?.classList.contains('win'),
  score: document.getElementById('rs-score')?.textContent,
}));
console.log('RESULT:', JSON.stringify(state));
await browser.close();
console.log('done');
