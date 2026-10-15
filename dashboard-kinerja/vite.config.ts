import { defineConfig } from 'vite'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const shadowApiPort = env.SHADOW_API_PORT ?? '8788'
  const proxy = {
    '/api/appraisal': {
      target: `http://127.0.0.1:${shadowApiPort}`,
      changeOrigin: false,
    },
    '/api/funding': {
      target: `http://127.0.0.1:${shadowApiPort}`,
      changeOrigin: false,
    },
    '/api/admin': {
      target: `http://127.0.0.1:${shadowApiPort}`,
      changeOrigin: false,
    },
  }
  return {
  // Allows an isolated no-JSON runtime check while preserving the real public/ directory.
  publicDir: env.VITE_TEST_PUBLIC_DIR || 'public',
  plugins: [
    react(),
    tailwindcss(),
  ],
    server: {
    proxy,
    allowedHosts: [
      'societies-cricket-chassis-deadline.trycloudflare.com',
    ],
  },
  }
})
