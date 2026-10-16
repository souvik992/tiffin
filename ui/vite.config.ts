import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The backend only accepts loopback Host headers and never approves CORS, so the dev server
// proxies /api to it (changeOrigin rewrites Host to 127.0.0.1:<port>). POS_PORT matches the backend.
const backend = `http://127.0.0.1:${process.env.POS_PORT ?? 4800}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './', // relative asset paths, so the build also loads from file:// inside the Electron host
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': { target: backend, changeOrigin: true } } },
  preview: { host: '127.0.0.1', port: 4173, proxy: { '/api': { target: backend, changeOrigin: true } } },
});
