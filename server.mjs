// 本地生产模式（npm run build && node server.mjs）：托管 dist + 复用 PK 对战 API（pk-api.mjs）。
// 注意：WorkBuddy 平台部署不上传 dist/ 构建产物，线上勿把本文件配成 start 脚本——
// 线上跑 vite dev（源码即时编译）+ vite.config.ts 里的 pk-api 中间件，API 与页面同源同端口。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePkApi } from './pk-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const PORT = Number(process.env.PORT || 43212);
const HOST = '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (await handlePkApi(req, res)) return; // PK 对战 API
    serveStatic(url.pathname, res); // 静态托管 dist
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(DIST, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(DIST)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA 兜底
      fs.readFile(path.join(DIST, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(idx);
      });
      return;
    }
    const ext = path.extname(file);
    // 缓存契约（WebView APK 旧版根因修复）：HTML 永远协商最新（no-cache=每次 revalidate 304）；
    // vite 内容 hash 资源可永久缓存；wasm/models 等固定名资源缓存 7 天
    let cache = 'public, max-age=604800';
    if (ext === '.html') cache = 'no-cache';
    else if (rel.startsWith('/assets/')) cache = 'public, max-age=31536000, immutable';
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cache });
    res.end(buf);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`warmingup-run prod server (dist + pk-api) on ${HOST}:${PORT}`);
});
