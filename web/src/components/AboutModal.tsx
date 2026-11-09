/**
 * U24: modal "Acerca de" (espejo de AboutModal.jsx de la Suite, adaptado:
 * sin i18n, CSS plano de Provisions). Se abre desde "© 2026 Glyvex" del
 * footer. Links del ecosistema + la entrada MANUAL del updater (U13): el
 * banner de App.tsx es pasivo (solo si el feed publica versión nueva),
 * aquí "Verificar actualizaciones" funciona en cualquier versión.
 *
 * El flujo de instalación replica el de installUpdate de App.tsx:
 * stopSidecar antes de descargar (con provisions-backend.exe vivo el NSIS
 * deja _internal/ con lock) y relaunch al terminar. Cierra con Esc.
 */
import { useEffect, useState } from 'react'
import {
  checkForUpdate,
  isTauri,
  relaunchApp,
  stopSidecar,
  type UpdateInfo,
} from '../tauri'
import ExternalLink from './ExternalLink'

const SITE_URL = 'https://ai-suite.glyvexgroup.com'
const GROUP_URL = 'https://glyvexgroup.com'
const GITHUB_URL = 'https://github.com/facebey/glyvex-provisions'

type Phase = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'error'

export default function AboutModal({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [progress, setProgress] = useState(-1) // -1: total aún desconocido
  const [error, setError] = useState('')

  // Versión de la shell (solo IPC Tauri; sin ella se oculta, igual que el splash).
  useEffect(() => {
    if (!isTauri()) return
    void import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((v) => setVersion(v))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleCheck = async () => {
    setPhase('checking')
    setError('')
    try {
      const u = await checkForUpdate()
      if (u) {
        setUpdate(u)
        setPhase('available')
      } else {
        setPhase('up-to-date')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message || String(e) : String(e))
      setPhase('error')
    }
  }

  const handleInstall = async () => {
    const upd = update
    if (!upd?.downloadAndInstall) return
    setPhase('downloading')
    setProgress(-1)
    setError('')
    try {
      await stopSidecar()
      let total = 0
      let done = 0
      await upd.downloadAndInstall((ev) => {
        if (ev?.event === 'Started' && ev.data?.contentLength) {
          total = ev.data.contentLength
        } else if (ev?.event === 'Progress') {
          done += ev.data?.chunkLength ?? 0
          if (total) setProgress(Math.min(100, Math.round((done / total) * 100)))
        } else if (ev?.event === 'Finished') {
          setProgress(100)
        }
      })
      await relaunchApp()
    } catch (e) {
      setError(e instanceof Error ? e.message || String(e) : String(e))
      setPhase('error')
    }
  }

  return (
    <div
      className="about-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Acerca de Glyvex Provisions"
    >
      <div className="about" onClick={(e) => e.stopPropagation()}>
        <div className="about-head">
          <h2>Acerca de</h2>
          <button type="button" className="mini" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>

        <div className="about-brand">
          {/* Mismo glyph que el header (descarga en bandeja; U17). */}
          <svg viewBox="176 180 672 672" width="56" height="56" role="img" aria-label="Glyvex Provisions">
            <defs>
              <linearGradient id="aboutLogoGrad" x1="208" y1="190" x2="816" y2="842" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#0d9488" />
                <stop offset="50%" stopColor="#06b6d4" />
                <stop offset="100%" stopColor="#8b5cf6" />
              </linearGradient>
            </defs>
            <path d="M250 560 V735 Q250 800 315 800 H709 Q774 800 774 735 V560" fill="none" stroke="url(#aboutLogoGrad)" strokeWidth="84" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M472 190 H552 V420 H640 L512 585 L384 420 H472 Z" fill="url(#aboutLogoGrad)" />
            <circle cx="512" cy="452" r="44" fill="#f97316" />
          </svg>
          <div className="about-name">Glyvex Provisions</div>
          <div className="about-tag">tu hardware → modelos que caben</div>
          {version && <div className="about-ver">v{version}</div>}
        </div>

        <div className="about-links">
          <ExternalLink href={SITE_URL}>ai-suite.glyvexgroup.com</ExternalLink>
          <ExternalLink href={GROUP_URL}>glyvexgroup.com</ExternalLink>
          <ExternalLink href={GITHUB_URL}>github.com/facebey/glyvex-provisions</ExternalLink>
        </div>

        {isTauri() && (
          <div className="about-update">
            {phase === 'idle' && (
              <button type="button" className="primary" onClick={() => void handleCheck()}>
                Verificar actualizaciones
              </button>
            )}
            {phase === 'checking' && <div className="about-state">Verificando…</div>}
            {phase === 'up-to-date' && (
              <>
                <div className="about-state ok">Estás en la última versión</div>
                <button type="button" className="mini" onClick={() => void handleCheck()}>
                  Verificar de nuevo
                </button>
              </>
            )}
            {phase === 'available' && (
              <>
                <div className="about-state">
                  La versión <strong>{update?.version}</strong> está disponible
                </div>
                <button type="button" className="primary" onClick={() => void handleInstall()}>
                  Actualizar y reiniciar
                </button>
              </>
            )}
            {phase === 'downloading' && (
              <>
                <div className="about-state">
                  Descargando la actualización…{progress >= 0 ? ` ${progress}%` : ''}
                </div>
                <div className="bar">
                  <div className="bar-fill" style={{ width: `${Math.max(progress, 4)}%` }} />
                </div>
              </>
            )}
            {phase === 'error' && (
              <>
                <div className="about-state err">La actualización no se pudo completar: {error}</div>
                <button type="button" className="mini" onClick={() => void handleCheck()}>
                  Reintentar
                </button>
              </>
            )}
          </div>
        )}

        <div className="about-foot">Licencia Apache-2.0 · © 2026 Glyvex Group</div>
      </div>
    </div>
  )
}
