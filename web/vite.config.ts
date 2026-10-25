import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev: el frontend sirve en 127.0.0.1:8331 (NO en 5173: ese es el dev
// server de Glyvex-AI-Suite; 8331 queda justo por encima de la escalera de
// puertos del backend — 8321 +1…+9 — y evita choques cuando ambas apps
// corren a la vez) y hace proxy de /api al backend
// (uvicorn en 127.0.0.1:8321). Sin CORS, todo local.
// strictPort (patrón de la Suite): si 8331 está ocupado falla a la vista
// en vez de moverse callado al siguiente.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 8331,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8321',
    },
  },
})
