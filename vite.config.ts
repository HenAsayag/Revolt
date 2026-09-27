import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180, strictPort: true, open: false },
  // Rapier inlines ~2 MB of wasm into the bundle, hence the higher warning limit.
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
  // Rapier's compat build inlines its wasm as base64, so no wasm plugin is needed.
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
