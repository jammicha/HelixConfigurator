import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // Bind to 0.0.0.0 so the AIOps install command (which embeds the LAN IP)
    // is reachable from a different machine on the same network.
    host: true,
    // Allow tunnel hosts. Vite 5 blocks unknown Host headers by default;
    // cloudflared / ngrok rotate hostnames per session so we whitelist the
    // domains rather than specific subdomains. LAN IP access still works
    // because Vite's default allowed list covers private IP ranges.
    allowedHosts: ['.trycloudflare.com', '.ngrok.io', '.ngrok-free.app', '.ngrok.app'],
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // Propagate X-Forwarded-* (host/proto) so the backend can see the
        // tunnel's public hostname when running behind cloudflared/ngrok.
        xfwd: true,
      }
    }
  }
})
