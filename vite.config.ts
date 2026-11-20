/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Relative asset paths so the same build works on a web server and inside the desktop app.
  base: './',
  plugins: [react(), tailwindcss()],
  build: { target: 'es2022', sourcemap: true },
  // The photo-enlarging worker is an ES module (it imports the ONNX runtime).
  worker: { format: 'es' },
  // Leave the ONNX runtime as it ships, so it finds its WebAssembly file next to itself in development too.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
