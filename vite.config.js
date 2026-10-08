import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  preview: {
    allowedHosts: ['all'],
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'favicon.svg'],
      manifest: {
        name: 'Pharmacy POS',
        short_name: 'Pharmacy POS',
        description: 'Multi-shop pharmacy point of sale, stock, and restock system',
        theme_color: '#2F6F5E',
        background_color: '#F7F8F6',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Do not download every SQLite engine variant during PWA install.
        // Cache the specific WASM file PowerSync uses on its first request.
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            urlPattern: /\.wasm$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'powersync-wasm',
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // Don't pre-bundle these — they ship their own web worker and WASM
    // files that need to stay as separate files, not get inlined.
    exclude: ['@powersync/web', '@journeyapps/wa-sqlite'],
  },
});
