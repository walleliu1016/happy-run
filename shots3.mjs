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

// 1. 横屏手机首屏 = 菜单（不开摄像头）
await shot('fix-first-landscape', { width: 851, height: 394 }, '', async (page) => {
  const st = await page.evaluate(() => ({
    active: document.querySelector('.screen.active')?.id,
    camStreaming: !!(document.querySelector('#check-video')?.srcObject),
  }));
  console.log('first-screen:', JSON.stringify(st));
});

// 2. 横屏手机体检页（等体检跑完看结果）
await shot('fix-check-landscape', { width: 851, height: 394 }, '', async (page) => {
  await page.click('#btn-back-check');
  await page.waitForTimeout(8000);
  const st = await page.evaluate(() => {
    const r = (s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { y: Math.round(b.y), h: Math.round(b.height) };
    };
    return { grid: r('.check-grid'), cam: r('.camera-card'), panel: r('.check-panel'),
      h1: r('.check-panel h1'), verdict: r('#verdict'), btnRow: r('#screen-check .btn-row') };
  });
  console.log('check-layout:', JSON.stringify(st));
});

// 3. 竖屏手机体检页
await shot('fix-check-portrait', { width: 393, height: 852 }, '', async (page) => {
  await page.click('#btn-back-check');
  await page.waitForTimeout(8000);
});

// 4. TV 菜单照旧
await shot('fix-tv-menu', { width: 1920, height: 1080 }, '?tv=1');

await browser.close();
