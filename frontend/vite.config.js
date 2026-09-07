import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = process.env.API_TARGET || 'http://127.0.0.1:3000'
const media = process.env.MEDIA_TARGET || 'http://127.0.0.1:8888'

// Optional web analytics (Umami). Injected only when BOTH vars are set at build time,
// so a plain `npm run build` — and every self-hosted install — stays telemetry-free.
// Set for the public instance: VITE_UMAMI_SRC=https://stats.example/script.js VITE_UMAMI_ID=<uuid>
const umamiSrc = process.env.VITE_UMAMI_SRC
const umamiId = process.env.VITE_UMAMI_ID

const umami = {
  name: 'opengym-umami',
  transformIndexHtml() {
    if (!umamiSrc || !umamiId) return
    return [{
      tag: 'script',
      attrs: { defer: true, src: umamiSrc, 'data-website-id': umamiId },
      injectTo: 'head'
    }]
  }
}

// Version marker (N6). web/Dockerfile's BUILD stage promotes the VCS_REF/BUILD_DATE build args
// to environment variables before `npm run build`, so the commit the bundle was built from is
// baked into the JS itself — the browser has no other way to know, and the service worker can
// happily keep serving an old bundle against a freshly deployed server. Absent everywhere else
// (`npm run dev`, `npm run build` by hand, vitest): both become empty strings, which Settings
// reads as "unknown" and renders as nothing at all.
const vcsRef = process.env.VCS_REF || ''
const buildDate = process.env.BUILD_DATE || ''

export default defineConfig({
  plugins: [react(), umami],
  base: './',
  define: {
    __VCS_REF__: JSON.stringify(vcsRef),
    __BUILD_DATE__: JSON.stringify(buildDate)
  },
  server: {
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/img': { target: media, changeOrigin: true },
      '/gif': { target: media, changeOrigin: true }
    }
  },
  build: { chunkSizeWarningLimit: 1500 }
})
