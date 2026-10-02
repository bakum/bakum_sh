import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { buildInfo } from './build-info';

const define = buildInfo();

/** Strict CSP for the packaged renderer (dev server needs inline preamble + HMR websocket). */
function cspPlugin(): Plugin {
  return {
    name: 'bm-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        // Commit authors' avatars in History (D65).
        "img-src 'self' data: blob: https://avatars.githubusercontent.com",
        "font-src 'self' data:",
        "worker-src 'self' blob:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ');
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
    },
  };
}

export default defineConfig({
  main: {
    define,
    build: {
      externalizeDeps: { exclude: ['@bm/core', '@bm/shared'] },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          core: resolve(__dirname, 'src/main/core-entry.ts'),
          // Command line client (D53): Node built-ins only, copied to <localDir>/bin by main.
          cli: resolve(__dirname, 'src/main/cli.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ['@bm/shared'] },
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    define,
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), cspPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
    worker: { format: 'es' },
  },
});
