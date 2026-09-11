import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': import.meta.dirname + '/src',
    },
  },
  server: {
    // When VITE_ALMADEL_MOCK=0, proxy the browser-facing API to a running
    // almadel server. In production the server serves these assets directly.
    proxy: {
      '/api': {
        target: process.env.ALMADEL_SERVER_URL ?? 'http://localhost:1213',
        changeOrigin: true,
      },
    },
  },
})
