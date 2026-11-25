import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the dashboard runs on :5173 and forwards API calls to the
// backend on :3000, so cookies stay same-origin (no CORS needed).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/admin/api': 'http://localhost:3000', '/api': 'http://localhost:3000', '/healthz': 'http://localhost:3000' },
  },
  build: { outDir: 'dist', sourcemap: false },
});
