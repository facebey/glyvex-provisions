import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { sidecarGate } from './tauri'

// U7: dentro de la shell Tauri (build de producción) la app NO monta todavía:
// muestra el splash y redirige al backend real al recibir `sidecar-state`.
// Fuera de Tauri o en dev, comportamiento idéntico al de siempre.
if (!sidecarGate()) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
