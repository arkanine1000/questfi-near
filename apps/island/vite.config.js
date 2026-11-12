import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  define: {
    // Shown in the settings panel: with a precaching service worker in
    // play, "which build is this device actually running?" needs a
    // one-glance answer.
    __BUILD_STAMP__: JSON.stringify(
      `${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z`,
    ),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Precache only the app shell (js/css/html); the heavy sprite art and
      // models cache lazily on first use so installing stays light.
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,svg,webmanifest}'],
        // the three.js bundle is one chunk north of workbox's 2 MiB default
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Live game data must never come from a cache, and API routes are
        // not SPA navigations.
        navigateFallbackDenylist: [/^\/api/, /^\/world/, /^\/mcp/],
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin
              && !url.pathname.startsWith('/api')
              && /\.(png|jpg|webp|glb|fbx|obj|mtl|mp4)$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'questfi-assets',
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      manifest: {
        name: 'Questfi — Agent Island',
        short_name: 'Questfi',
        description:
          'Watch AI agents raid dungeons, fight for the Heart of the Island, and price the market live.',
        start_url: '/',
        display: 'standalone',
        orientation: 'landscape',
        background_color: '#010603',
        theme_color: '#02140a',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  preview: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
