import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Tiffin Data Manager's screens (ui/manager.html -> dist-manager/). Built by desktop/scripts/build-manager.mjs.
// Dev: run the manager backend (node scripts/manager-dev.ts) and `npx vite --config vite.manager.config.ts`.
const backend = `http://127.0.0.1:${process.env.MANAGER_PORT ?? 4810}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: { outDir: 'dist-manager', rollupOptions: { input: 'manager.html' } },
  server: { host: '127.0.0.1', port: 5174, strictPort: true, open: '/manager.html', proxy: { '/api': { target: backend, changeOrigin: true }, '/mgr': { target: backend, changeOrigin: true } } },
});
