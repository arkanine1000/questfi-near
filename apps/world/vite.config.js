import { defineConfig } from 'vite';

export default defineConfig({
  // relative base so the built app works on GitHub Pages / any subpath
  base: './',
  build: {
    chunkSizeWarningLimit: 1400,
  },
  server: {
    host: true,
    port: 5175,
  },
});
