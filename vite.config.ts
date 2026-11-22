import { defineConfig } from 'vite';

// 部署沙盒注入 PORT；监听该端口并绑定 0.0.0.0，反代域名放行 host 检查
const port = Number(process.env.PORT) || undefined;

export default defineConfig({
  base: './',
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
