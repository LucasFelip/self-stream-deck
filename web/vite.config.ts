/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The agent serves the build at /v2/ (next to the old interface at /) until the new one reaches parity (docs/adr/0007).
// `npm run dev` proxies the API to the agent on this PC; the pairing cookie of 127.0.0.1:7878 is shared with localhost:5173.
export default defineConfig({
  base: '/v2/',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:7878' } },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  test: { environment: 'jsdom', globals: false, include: ['src/**/*.test.{ts,tsx}'] },
});
