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
        // Standalone `npm run dev` targets the backend's default port 8765.
        // In the desktop dev flow the Electron supervisor binds a dedicated
        // loopback port and exports HELIX_DESKTOP_DEV_BACKEND_PORT for both
        // halves, so the proxy follows it there instead of the fixed default.
        target: process.env.HELIX_DESKTOP_DEV_BACKEND_PORT
          ? `http://127.0.0.1:${process.env.HELIX_DESKTOP_DEV_BACKEND_PORT}`
          : 'http://localhost:8765',
        changeOrigin: true,
      }
    }
  }
})
