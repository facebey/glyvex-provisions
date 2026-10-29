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
      // El backend puede no quedar en 8321: si esa base estaba ocupada, su
      // escalera (8321..8330) lo asienta en 8322, 8323, ... El arrancador
      // (start.ps1) descubre el puerto real con /api/healthz y lo inyecta por
      // PROV_BACKEND_URL; sin la variable, 8321 sigue siendo el valor por
      // defecto (arranque manual directo de `npm run dev`).
      '/api': process.env.PROV_BACKEND_URL || 'http://127.0.0.1:8321',
    },
  },
})
