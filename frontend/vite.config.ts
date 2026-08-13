import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// /api/* 를 백엔드로 프록시 — CORS 없이 같은 오리진으로 개발한다.
// 기본은 Spring(:8080), Nest로 붙이려면 VITE_PROXY_TARGET=http://localhost:3000
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
