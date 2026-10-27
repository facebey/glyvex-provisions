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
 * import.meta.env.PROD es false. Excepción de QA: `?prov-splash` en dev fuerza
 * el splash para poder diseñarlo/verificarlo sin hacer un `tauri build`.
 *
 * El splash replica el estilo "A oscuro centrado" del brand kit (iguales que
 * BootSplash de la Suite): eyebrow GLYVEX GROUP, isotipo, wordmark en 2 líneas
 * con la segunda en degradado de marca, tagline, barra de progreso animada,
 * versión y borde inferior degradado. Poppins va embebido desde public/fonts
 * (app 100% offline, licencia SIL OFL 1.1 incluida).
 */

function splashStyleTag(): string {
  return `
    @font-face { font-family: Poppins; font-weight: 400; src: url(/fonts/poppins-regular.woff2) format("woff2"); }
    @font-face { font-family: Poppins; font-weight: 500; src: url(/fonts/poppins-medium.woff2) format("woff2"); }
    @font-face { font-family: Poppins; font-weight: 700; src: url(/fonts/poppins-bold.woff2) format("woff2"); }
    .prov-splash-grad {
      background: linear-gradient(90deg, #7c3aed, #0ea5e9 60%, #06b6d4);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .prov-splash-bar i {
      display: block; height: 100%; width: 40%; border-radius: 3px;
      background: linear-gradient(90deg, #7c3aed, #0ea5e9, #06b6d4);
      animation: prov-splash-load 1.6s ease-in-out infinite;
    }
    @keyframes prov-splash-load { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
    .prov-splash-logo { animation: prov-splash-in 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
    @keyframes prov-splash-in { from { opacity: 0; transform: scale(0.85) rotate(-30deg); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) {
      .prov-splash-logo { animation: none; }
      .prov-splash-bar i { animation-duration: 3s; }
    }
  `
}

// Isotipo del brand kit (igual al BootLogo de la Suite; SVG embebido, sin
// assets externos: el splash pinta antes de cualquier red).
function splashLogoSvg(): string {
  return `
    <svg class="prov-splash-logo" width="112" height="112" viewBox="100 100 824 824" xmlns="http://www.w3.org/2000/svg">
      <circle cx="512" cy="512" r="356" fill="none" stroke="#7c3aed" stroke-width="22"/>
      <line x1="203.7" y1="334.0" x2="820.3" y2="690.0" stroke="#a77bf3" stroke-opacity="1" stroke-width="16" stroke-linecap="round"/>
      <line x1="203.7" y1="690.0" x2="820.3" y2="334.0" stroke="#06b6d4" stroke-opacity="0.9" stroke-width="16" stroke-linecap="round"/>
      <circle cx="512" cy="512" r="102" fill="#7c3aed"/>
      <line x1="512.0" y1="156.0" x2="512.0" y2="868.0" stroke="#0ea5e9" stroke-opacity="0.95" stroke-width="16" stroke-linecap="round"/>
      <circle cx="512.0" cy="156.0" r="57" fill="#0ea5e9"/>
      <circle cx="820.3" cy="334.0" r="57" fill="#06b6d4"/>
      <circle cx="820.3" cy="690.0" r="57" fill="#7c3aed"/>
      <circle cx="512.0" cy="868.0" r="57" fill="#0ea5e9"/>
      <circle cx="203.7" cy="690.0" r="57" fill="#06b6d4"/>
      <circle cx="203.7" cy="334.0" r="57" fill="#7c3aed"/>
    </svg>
  `
}

function renderShellSplash() {
  document.getElementById('root')?.remove()
  const el = (tag: string, cls: string | undefined, style: string, html?: string) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    n.style.cssText = style
    if (html) n.innerHTML = html
    return n
  }
  const wrap = el('div', undefined,
    'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'background:radial-gradient(ellipse at 50% 35%, #1a1530 0%, #0b0d14 70%);color:#e8eaf0;' +
      "font-family:Poppins,'Segoe UI',sans-serif;user-select:none")
  const center = el('div', undefined,
    'display:flex;flex-direction:column;align-items:center;gap:12px')
  center.appendChild(el('div', undefined,
    'font-size:11px;letter-spacing:4px;color:#8a90a6;font-weight:500', 'GLYVEX GROUP'))
  const logo = el('div', undefined, 'display:flex', splashLogoSvg())
  center.appendChild(logo)
  center.appendChild(el('div', undefined,
    'font-size:30px;font-weight:700;line-height:1.15;letter-spacing:-0.4px;margin-top:14px;text-align:center',
    'Glyvex<br><span class="prov-splash-grad">Provisions</span>'))
  center.appendChild(el('div', undefined,
    'font-size:12.5px;color:#8a90a6;margin-top:2px', 'IA local, sin nube'))
  const bar = el('div', 'prov-splash-bar',
    'width:220px;height:3px;border-radius:3px;background:#1e2133;margin-top:26px;overflow:hidden')
  bar.appendChild(document.createElement('i'))
  center.appendChild(bar)
  const status = el('div', undefined, 'font-size:10.5px;color:#6b7089;margin-top:8px')
  status.id = 'prov-boot-msg'
  status.textContent = 'Iniciando el backend local…'
  center.appendChild(status)
  wrap.appendChild(center)
  const foot = el('div', undefined,
    'position:absolute;bottom:14px;right:18px;font-size:10.5px;color:#6b7089')
  wrap.appendChild(foot)
  wrap.appendChild(el('div', undefined,
    'position:absolute;left:0;right:0;bottom:0;height:3px;' +
      'background:linear-gradient(90deg, #7c3aed, #0ea5e9 60%, #06b6d4)'))
  wrap.appendChild(el('style', undefined, '', splashStyleTag()))
  document.body.appendChild(wrap)
  // Versión de la shell en el footer (solo IPC Tauri; sin ella se oculta).
  void import('@tauri-apps/api/app')
    .then(({ getVersion }) => getVersion())
    .then((v) => { foot.textContent = `v${v}` })
    .catch(() => {}) // sin IPC (p. ej. preview en dev): se oculta la versión
}

export function sidecarGate(): boolean {
  // QA en dev: `?prov-splash` fuerza el splash para diseñarlo sin build.
  const preview = import.meta.env.DEV && location.search.includes('prov-splash')
  if (!import.meta.env.PROD && !preview) return false
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  if (!preview && !w.__TAURI_INTERNALS__) return false
  if (!preview && (location.hostname === '127.0.0.1' || location.hostname === 'localhost')) return false

  renderShellSplash()
  if (preview) return true
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
