import { defineConfig } from 'vite';

// the dev server sends api requests to the running app. the build goes to web/dist, which the app serves.
export default defineConfig({
  root: import.meta.dirname,
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:4317' } },
});
