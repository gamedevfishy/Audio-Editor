import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths so the build works at https://<user>.github.io/<repo>/ under any repo name.
  base: './',
  plugins: [react()],
  // ffmpeg.wasm spins up its own module worker; pre-bundling breaks the worker URL.
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
  },
});
