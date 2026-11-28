/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The agent serves the build at / (inside the agent's executable; the source maps stay in dist/ for debugging and are left out of it).
// `npm run dev` proxies the API to the agent on this PC; the pairing cookie of 127.0.0.1:7878 is shared with localhost:5173.
// `--mode demo` builds the demonstration (src/demo: the panel with no PC behind it, for GitHub Pages): relative addresses, so it works from any folder.
export default defineConfig(({ mode }) => ({
  base: mode === 'demo' ? './' : '/',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:7878' } },
  build: { outDir: mode === 'demo' ? 'dist-demo' : 'dist', sourcemap: mode !== 'demo', target: 'es2022' },
  // css: the styles are read as text by styles/contrast.test.ts (vitest would otherwise give an empty string)
  test: { environment: 'jsdom', globals: false, include: ['src/**/*.test.{ts,tsx}'], css: true },
}));
