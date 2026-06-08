import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // Bind to 0.0.0.0 so the dev server is reachable from another machine on
    // the LAN (e.g. checking the UI from a phone or a VM).
    host: true,
    proxy: {
      '/api': {
        // The backend binds PORT (default 8765); the dev proxy follows that
        // default so `npm run dev` on both halves works with no env var.
        target: 'http://localhost:8765',
        changeOrigin: true,
      }
    }
  }
})
