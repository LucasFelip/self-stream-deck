/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The agent serves the build at / (the old interface stays at /legacy/ for one more version, docs/adr/0007).
// `npm run dev` proxies the API to the agent on this PC; the pairing cookie of 127.0.0.1:7878 is shared with localhost:5173.
export default defineConfig({
  base: '/',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:7878' } },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  test: { environment: 'jsdom', globals: false, include: ['src/**/*.test.{ts,tsx}'] },
});
