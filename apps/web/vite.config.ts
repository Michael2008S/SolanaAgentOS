import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), {
    name: 'local-wallet-memory-lifetime',
    apply: 'serve',
    configureServer(server) {
      // Serve this tiny wallet shell without the Vite reload client. The wallet
      // retains its memory key when the dapp changes; an explicit reload still
      // destroys it. The module itself enforces DEV + Localnet.
      server.middlewares.use((request, response, next) => {
        if (request.method !== 'GET' || request.url?.split('?')[0] !== '/local-wallet.html') return next();
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(readFileSync(fileURLToPath(new URL('./local-wallet.html', import.meta.url)), 'utf8'));
      });
    },
  }],
  server: { proxy: { '/api': process.env.AGENTOS_RUNTIME_URL || 'http://127.0.0.1:8787' } },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replaceAll('\\', '/');
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(path)) return 'react-vendor';
          if (/\/node_modules\/(?:@solana|@noble|@scure)\//.test(path)) return 'solana-vendor';
          if (/\/node_modules\/@x402\//.test(path)) return 'x402-vendor';
          return undefined;
        },
      },
    },
  },
});
