import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteCommonjs } from '@originjs/vite-plugin-commonjs';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteCommonjs()
  ],
  // seems like only required in dev mode
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: ['dicom-parser'],
  },
  worker: {
    format: 'es',
  },

  server: {
    // fs: {
    //   strict: true,
    // },
    proxy: {
      '/orthancUrl': {
        target: 'http://localhost:8042',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/orthancUrl/, '')
      }
    }
  },
});