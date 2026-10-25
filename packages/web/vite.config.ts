import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [preact()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  // `npm run dev` here talks to the Worker running locally (`npm run dev -w @eventide/api`).
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
