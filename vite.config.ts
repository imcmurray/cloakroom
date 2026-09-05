import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// CSP differs by mode: dev needs ws/wss for HMR; production locks network egress
// to 'none', so the browser itself blocks every fetch/XHR/WebSocket/beacon.
// "Nothing is sent" becomes browser-enforced, not just a promise.
function cspByMode(isBuild: boolean): Plugin {
  return {
    name: 'cloakroom-csp',
    transformIndexHtml(html) {
      const connect = isBuild ? "'none'" : "'self' ws: wss:";
      return html.replace(/connect-src[^;]*/, `connect-src ${connect}`);
    },
  };
}

// Relative base on build so the SPA works under a subpath (GitHub Pages serves
// it at /cloakroom/). Dev server stays at root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [
    react(),
    cspByMode(command === 'build'),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png'],
      // Precache the whole app shell so it loads with no network at all.
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'] },
      manifest: {
        name: 'Cloakroom',
        short_name: 'Cloakroom',
        description: 'Sanitize PII/secrets before pasting into any LLM, then restore them — entirely in your browser.',
        theme_color: '#14161f',
        background_color: '#14161f',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          // Separate maskable art: full-bleed, glyph inside the 80% safe circle so
          // Android's mask can't clip the hanger.
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: { port: 5181 },
  build: { target: 'es2022', sourcemap: false },
}));
