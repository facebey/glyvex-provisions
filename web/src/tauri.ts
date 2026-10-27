/**
 * Gate del sidecar para la shell Tauri (U7) — espejo de `tauriBootstrapRedirect`
 * de Glyvex-AI-Suite.
 *
 * Solo activo cuando: build de producción (PROD) AND ventana Tauri
 * (__TAURI_INTERNALS__) AND origen aún no es el backend (127.0.0.1). En ese
 * caso la shell todavía sirve el splash de `frontendDist`: esperamos el evento
 * `sidecar-state` de Rust (el backend puede caer en cualquier puerto de la
 * escalera 8321..8330, así que la URL la decide Rust, nunca el frontend) y
 * redirige la webview al origen real del backend, que ya sirve esta misma SPA.
 *
 * En `npm run dev` (Vite en 8331 con proxy /api) el gate es inerte:
 * import.meta.env.PROD es false.
 */

function renderShellSplash() {
  document.getElementById('root')?.remove()
  const splash = document.createElement('div')
  splash.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#0f1115;color:#e6e8ee;font-family:system-ui,sans-serif'
  splash.innerHTML =
    '<div style="font-size:22px;font-weight:600">Glyvex Provisions</div>' +
    '<div id="prov-boot-msg" style="font-size:14px;opacity:.75">Iniciando el backend local…</div>'
  document.body.appendChild(splash)
}

export function sidecarGate(): boolean {
  if (!import.meta.env.PROD) return false
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  if (!w.__TAURI_INTERNALS__) return false
  if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') return false

  renderShellSplash()
  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<{ state: string; url?: string }>('sidecar-state', (ev) => {
        const p = ev.payload
        if (p?.state === 'running' && p.url) {
          // ?prov=boot: cache-buster para la primera carga (patrón PUB-13 de la Suite)
          location.replace(p.url + '/?prov=boot')
        } else if (p?.state === 'stopped') {
          const msg = document.getElementById('prov-boot-msg')
          if (msg) msg.textContent = 'El backend no arrancó. Reintentando…'
        }
      }),
    )
    .catch(() => {
      // sin puente Tauri (no debería pasar en la shell): el splash queda esperando
    })
  return true
}
