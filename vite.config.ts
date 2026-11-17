import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';

// PulseDNS 以 Docker 方式运行在 Node.js 上，数据保存在外置 MySQL / MariaDB。
export default defineConfig({
  build: { rolldownOptions: { external: ['mysql2', 'mysql2/promise'] } },
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [vinext()],
});
