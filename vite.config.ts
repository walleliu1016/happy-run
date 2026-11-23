import { defineConfig, type Plugin } from 'vite';
import { handlePkApi } from './pk-api.mjs';

// 部署沙盒注入 PORT；监听该端口并绑定 0.0.0.0，反代域名放行 host 检查
const port = Number(process.env.PORT) || undefined;

// PK 对战 API 挂 vite 中间件：平台线上跑 vite dev（部署不上传 dist/，不能走 node server.mjs），
// 对战 API 与页面同源同端口。非 /api/pk/* 路径原样放行给 vite。
const pkApiPlugin: Plugin = {
  name: 'pk-api',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      void handlePkApi(req, res).then((handled) => { if (!handled) next(); }, () => next());
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      void handlePkApi(req, res).then((handled) => { if (!handled) next(); }, () => next());
    });
  },
};

export default defineConfig({
  base: './',
  plugins: [pkApiPlugin],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 2000,
  },
  server: {
    host: true,
    port,
    strictPort: !!port,
    allowedHosts: true,
  },
  preview: {
    host: true,
    port,
    strictPort: !!port,
    allowedHosts: true,
  },
});
