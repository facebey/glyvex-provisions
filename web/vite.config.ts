import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev: el frontend sirve en 127.0.0.1:5173 y hace proxy de /api al backend
// (uvicorn en 127.0.0.1:8321). Sin CORS, todo local.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8321',
    },
  },
})
