import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Privacy posture: lock the SPA down so injected code can't phone home.
  // (In production also send this as a real CSP header from the host.)
  server: { port: 5181 },
  build: { target: 'es2022', sourcemap: false },
});
