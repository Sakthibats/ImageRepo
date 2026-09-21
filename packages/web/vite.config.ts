import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // Hashed filenames so the Worker can serve them with a long immutable TTL.
    assetsDir: 'assets',
    sourcemap: false,
  },
  server: {
    // `npm run dev` proxies API calls to the deployed Worker so the local app
    // talks to real data without a second copy of the backend.
    proxy: {
      '/a': { target: 'https://imagerepo-api.baskaran-sakthivel.workers.dev', changeOrigin: true },
      '/admin': { target: 'https://imagerepo-api.baskaran-sakthivel.workers.dev', changeOrigin: true },
    },
  },
});
