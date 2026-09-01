import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    fs: {
      // The draft companion bundles extension/annotate.js verbatim (?raw
      // import) — allow the dev server to read outside frontend/.
      allow: ['..'],
    },
    proxy: {
      // Forward /api/* requests to the FastAPI backend during development.
      // VITE_API_TARGET overrides the target (e.g. a fixture backend).
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
