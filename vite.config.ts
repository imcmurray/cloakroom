import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base on build so the SPA works under a subpath (GitHub Pages serves
// it at /cloakroom/). Dev server stays at root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [react()],
  // Privacy posture: lock the SPA down so injected code can't phone home.
  // (In production also send this as a real CSP header from the host.)
  server: { port: 5181 },
  build: { target: 'es2022', sourcemap: false },
}));
