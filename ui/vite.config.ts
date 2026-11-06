import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:4417', ws: true, changeOrigin: true },
      '/api': { target: 'http://127.0.0.1:4417', changeOrigin: true },
    },
    fs: { allow: ['..'] },
  },
});
