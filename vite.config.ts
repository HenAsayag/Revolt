import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // Relative asset paths in builds, so the game works from any sub-path (e.g. GitHub Pages /Revolt/).
  base: command === 'build' ? './' : '/',
  // host: true → also reachable from a phone on the same Wi-Fi (http://<this PC's IP>:5180).
  server: { port: 5180, strictPort: true, open: false, host: true },
  preview: { port: 5181, host: true },
  // Rapier inlines ~2 MB of wasm into the bundle, hence the higher warning limit.
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
  // Rapier's compat build inlines its wasm as base64, so no wasm plugin is needed.
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
}));
