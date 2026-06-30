import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

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
  plugins: [react(), cspByMode(command === 'build')],
  server: { port: 5181 },
  build: { target: 'es2022', sourcemap: false },
}));
