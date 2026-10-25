import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type FileRow,
  type Hardware,
  type JobEvent,
  type ModelHit,
  type Regime,
  type RepoData,
  fmtBytes,
  getHardware,
  getRepo,
  listDownloads,
  openJobEvents,
  searchModels,
  submitDownload,
} from './api'

interface JobView {
  id: string
  repo_id: string
  status: string
  error: string | null
  dest?: string
  bytesDone: number
  bytesTotal: number
  filesDone: number
  filesTotal: number
  log: string[]
}

const REGIME_LABELS: Record<Regime, string> = {
  gpu: 'Solo GPU (VRAM)',
  offload: 'Offload GPU+RAM',
  cpu: 'Solo CPU (RAM)',
}

export default function App() {
  const [hw, setHw] = useState<Hardware | null>(null)
  const [regime, setRegime] = useState<Regime>('gpu')
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<ModelHit[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [repo, setRepo] = useState<RepoData | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dest, setDest] = useState<string>('D:\\Downloads')
  const [jobs, setJobs] = useState<JobView[]>([])
  const eventsRef = useRef<Map<string, EventSource>>(new Map())

  const closeJob = useCallback((id: string) => {
    eventsRef.current.get(id)?.close()
    eventsRef.current.delete(id)
  }, [])

  const attachJob = useCallback((id: string, repoId: string, fileCount: number) => {
    if (eventsRef.current.has(id)) return // ya suscrito
    setJobs((js) =>
      js.some((j) => j.id === id)
        ? js
        : [
            { id, repo_id: repoId, status: 'queued', error: null,
              bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: fileCount,
              log: [] },
            ...js,
          ],
    )
    const es = openJobEvents(id, (ev: JobEvent) => {
      setJobs((js) =>
        js.map((j) => {
          if (j.id !== id) return j
          const nj = { ...j }
          if (ev.type === 'start') {
            nj.dest = ev.dest
            nj.status = 'running'
          } else if (ev.type === 'progress') {
            // desc = "Downloading bytes" / "Reconstructing (incomplete total...)"
            //        / "Fetching N files"
            if (ev.path?.startsWith('Fetching')) {
              // barra "Fetching N files": done = archivos completados
              if (ev.done !== undefined) nj.filesDone = ev.done
              if (ev.total) nj.filesTotal = ev.total
              nj.status = 'running'
            } else if (ev.path?.startsWith('Reconstructing')) {
              nj.bytesDone = Math.max(nj.bytesDone, ev.done ?? 0)
              nj.status = 'running'
            }
            // "Downloading bytes" no lleva total: se ignora para la barra
          } else if (ev.type === 'log') {
            nj.log = [...nj.log, ev.msg ?? ''].slice(-20)
          } else if (ev.type === 'done') {
            nj.status = 'done'
            nj.dest = ev.dest ?? nj.dest
            nj.bytesDone = nj.bytesTotal
            nj.filesDone = nj.filesTotal
            setTimeout(() => closeJob(id), 500)
          } else if (ev.type === 'error') {
            nj.status = 'error'
            nj.error = ev.error ?? 'error desconocido'
            setTimeout(() => closeJob(id), 500)
          }
          return nj
        }),
      )
    })
    eventsRef.current.set(id, es)
  }, [closeJob])

  // Carga inicial: hardware + jobs activos en el servidor (re-suscripción)
  useEffect(() => {
    getHardware().then((h) => {
      setHw(h)
      setDest(h.downloads_dir)
    }).catch(() =>
      setError('No se pudo conectar con el backend (¿uvicorn corriendo en 8321?).'),
    )
    listDownloads()
      .then((d) => {
        for (const j of d.jobs) {
          if (j.status === 'running' || j.status === 'queued') {
            attachJob(j.id, j.repo_id, j.files)
          }
        }
      })
      .catch(() => {/* backend caído: ya se muestra el error */})
    return () => {
      for (const es of eventsRef.current.values()) es.close()
      eventsRef.current.clear()
    }
  }, [attachJob])

  const doSearch = async () => {
    if (!query.trim()) return
    setBusy('search')
    setError(null)
    try {
      const d = await searchModels(query.trim())
      setModels(d.models)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const doOpenRepo = async (repoId: string) => {
    setBusy('repo')
    setError(null)
    setRepo(null)
    setSelected(new Set())
    try {
      const d = await getRepo(repoId, regime)
      setRepo(d)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  // Si cambia el régimen, re-calcular la tabla del repo abierto
  useEffect(() => {
    if (repo) {
      getRepo(repo.repo_id, regime)
        .then(setRepo)
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regime])

  const toggle = (path: string) => {
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(path)) n.delete(path)
      else n.add(path)
      return n
    })
  }

  const selectByLabel = (label: string, on: boolean) => {
    if (!repo) return
    setSelected((s) => {
      const n = new Set(s)
      for (const r of repo.rows) {
        if (r.label === label) {
          if (on) n.add(r.path)
          else n.delete(r.path)
        }
      }
      return n
    })
  }

  const selectedBytes = (repo?.rows ?? [])
    .filter((r) => selected.has(r.path))
    .reduce((a, r) => a + r.size, 0)

  const doDownload = async () => {
    if (!repo || selected.size === 0) return
    setBusy('dl')
    setError(null)
    try {
      const files = repo.rows.filter((r) => selected.has(r.path)).map((r) => r.path)
      const d = await submitDownload(repo.repo_id, files, dest)
      // total de bytes para la barra de progreso
      setJobs((js) =>
        [
          {
            id: d.id,
            repo_id: repo.repo_id,
            status: 'queued',
            error: null,
            bytesDone: 0,
            bytesTotal: files.reduce((a, f) => a + (repo.rows.find((r) => r.path === f)?.size ?? 0), 0),
            filesDone: 0,
            filesTotal: files.length,
            log: [],
          },
          ...js,
        ],
      )
      attachJob(d.id, repo.repo_id, files.length)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const gpus = hw?.gpus ?? []

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">
            {/* Ícono Glyvex AI (brand kit oficial) — red neural violeta→sky */}
            <svg viewBox="0 0 80 80" width="24" height="24" role="img" aria-label="Glyvex AI">
              <defs>
                <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#7c3aed" />
                  <stop offset="100%" stopColor="#0ea5e9" />
                </linearGradient>
              </defs>
              <circle cx="40" cy="40" r="28" fill="none" stroke="url(#logoGrad)" strokeWidth="2" />
              <circle cx="40" cy="40" r="8" fill="#7c3aed" />
              <circle cx="40" cy="12" r="4.5" fill="#0ea5e9" />
              <circle cx="64" cy="26" r="4.5" fill="#06b6d4" />
              <circle cx="64" cy="54" r="4.5" fill="#7c3aed" opacity="0.75" />
              <circle cx="40" cy="68" r="4.5" fill="#0ea5e9" opacity="0.75" />
              <circle cx="16" cy="54" r="4.5" fill="#06b6d4" />
              <circle cx="16" cy="26" r="4.5" fill="#7c3aed" opacity="0.55" />
              <line x1="40" y1="32" x2="40" y2="16" stroke="#0ea5e9" strokeWidth="1.5" />
              <line x1="47" y1="35" x2="60" y2="29" stroke="#06b6d4" strokeWidth="1.5" />
              <line x1="47" y1="45" x2="60" y2="51" stroke="#7c3aed" strokeWidth="1.5" />
              <line x1="40" y1="48" x2="40" y2="64" stroke="#0ea5e9" strokeWidth="1.5" />
              <line x1="33" y1="45" x2="20" y2="51" stroke="#06b6d4" strokeWidth="1.5" />
              <line x1="33" y1="35" x2="20" y2="29" stroke="#7c3aed" strokeWidth="1.5" />
            </svg>
          </span> Glyvex Provisions
          <span className="sub">tu hardware → modelos que caben</span>
        </div>
        <div className="regimes">
          {(Object.keys(REGIME_LABELS) as Regime[]).map((r) => (
            <button
              key={r}
              className={regime === r ? 'chip active' : 'chip'}
              onClick={() => setRegime(r)}
            >
              {REGIME_LABELS[r]}
            </button>
          ))}
        </div>
      </header>

      {/* Panel de hardware */}
      <section className="panel hw">
        {hw ? (
          <>
            {gpus.map((g) => (
              <div key={g.index} className="hw-item">
                <span className="hw-icon">🎮</span>
                <div>
                  <div className="hw-name">{g.name}</div>
                  <div className="hw-meta">
                    VRAM {fmtBytes(g.vram_total_bytes)} · libre {fmtBytes(g.vram_free_bytes)} · driver {g.driver}
                  </div>
                </div>
              </div>
            ))}
            {gpus.length === 0 && (
              <div className="hw-item">
                <span className="hw-icon">⚠️</span>
                <div>
                  <div className="hw-name">Sin GPU NVIDIA detectada</div>
                  <div className="hw-meta">usa el régimen CPU / Offload</div>
                </div>
              </div>
            )}
            <div className="hw-item">
              <span className="hw-icon">🧠</span>
              <div>
                <div className="hw-name">RAM {fmtBytes(hw.ram_total_bytes)}</div>
                <div className="hw-meta">{hw.cpu_cores} núcleos de CPU</div>
              </div>
            </div>
            <div className="hw-item">
              <span className="hw-icon">💾</span>
              <div>
                <div className="hw-name">Disco: {fmtBytes(hw.disk_free_bytes)} libres</div>
                <div className="hw-meta">descargas → {hw.downloads_dir}</div>
              </div>
            </div>
          </>
        ) : (
          <div className="hw-item">
            <div className="hw-meta">{error ?? 'Leyendo hardware…'}</div>
          </div>
        )}
      </section>

      {/* Búsqueda */}
      <section className="panel">
        <div className="row searchbar">
          <input
            name="query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            placeholder="Buscar modelos GGUF en Hugging Face (p. ej. Qwen3, Llama 3.1)…"
          />
          <button onClick={doSearch} disabled={busy === 'search'}>
            {busy === 'search' ? 'Buscando…' : 'Buscar'}
          </button>
        </div>
        {models !== null && (
          <table className="tbl">
            <thead>
              <tr><th>Modelo</th><th>Descargas</th><th>Me gusta</th><th></th></tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id}>
                  <td className="mono" title={m.id}>{m.id}</td>
                  <td>{m.downloads.toLocaleString('es')}</td>
                  <td>{m.likes.toLocaleString('es')}</td>
                  <td>
                    <button
                      className="mini"
                      disabled={busy === 'repo'}
                      onClick={() => doOpenRepo(m.id)}
                    >
                      Abrir
                    </button>
                  </td>
                </tr>
              ))}
              {models.length === 0 && (
                <tr><td colSpan={4} className="muted">Sin resultados.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </section>

      {error && busy === null && (
        <div className="banner error">{error}</div>
      )}

      {/* Tabla de cuantizaciones por archivo */}
      {repo && (
        <section className="panel">
          <div className="row repohead">
            <div>
              <span className="mono repo-id">{repo.repo_id}</span>
              <span className="muted"> — {repo.rows.length} archivos de pesos (régimen: {REGIME_LABELS[regime]})</span>
            </div>
            <div className="row totals">
              <span>
                Seleccionado: <b>{selected.size}</b> archivos · <b>{fmtBytes(selectedBytes)}</b>
              </span>
              <label className="dest">
                Destino:
                <input
                  name="dest"
                  value={dest}
                  onChange={(e) => setDest(e.target.value)}
                  placeholder="D:\Downloads"
                />
              </label>
              <button
                className="primary"
                disabled={selected.size === 0 || busy === 'dl'}
                onClick={doDownload}
              >
                {busy === 'dl' ? 'Enviando…' : '⬇ Descargar'}
              </button>
            </div>
          </div>
          <table className="tbl files">
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                <th>Cuantización</th>
                <th>Tamaño</th>
                <th>Estima con overhead</th>
                <th className="light">¿Cabe?</th>
                <th>Archivo</th>
              </tr>
            </thead>
            <tbody>
              {repo.rows.map((r: FileRow) => (
                <tr key={r.path} className={selected.has(r.path) ? 'sel' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(r.path)}
                      onChange={() => toggle(r.path)}
                    />
                  </td>
                  <td>
                    <button
                      className="chip tiny"
                      title="marcar / desmarcar todo el grupo"
                      onClick={(e) => {
                        e.stopPropagation()
                        selectByLabel(r.label, !selected.has(r.path))
                      }}
                    >
                      {r.label}
                    </button>
                  </td>
                  <td className="num">{fmtBytes(r.size)}</td>
                  <td className="num muted">{fmtBytes(r.needed_bytes)}</td>
                  <td>
                    {r.status === 'na' ? (
                      <span className="dot na" title={r.detail}>—</span>
                    ) : (
                      <span className={`dot ${r.status}`}
                            title={r.detail ?? `ratio ${(r.ratio ?? 0).toFixed(2)}`}>
                        ● {r.status}
                      </span>
                    )}
                  </td>
                  <td className="mono small" title={r.path}>
                    {r.path.split('/').pop()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Cola de descargas */}
      <section className="panel">
        <h2>Descargas</h2>
        {jobs.length === 0 && <div className="muted">Ninguna descarga.</div>}
        {jobs.map((j) => {
          const pctBytes =
            j.bytesTotal > 0 ? Math.min(100, (j.bytesDone / j.bytesTotal) * 100) : 0
          return (
            <div key={j.id} className="job">
              <div className="row">
                <span className={`job-status s-${j.status}`}>{j.status}</span>
                <span className="mono" title={j.repo_id}>{j.repo_id}</span>
                <span className="muted">
                  {j.filesDone}/{j.filesTotal} archivos
                  {j.bytesTotal > 0 && ` · ${fmtBytes(j.bytesDone)} / ${fmtBytes(j.bytesTotal)}`}
                </span>
              </div>
              {j.status === 'running' || j.status === 'queued' ? (
                <>
                  <div className="bar">
                    <div className="bar-fill" style={{ width: `${pctBytes}%` }} />
                  </div>
                  {j.log.length > 0 && (
                    <div className="log">{j.log[j.log.length - 1]}</div>
                  )}
                </>
              ) : (
                <div className={j.status === 'done' ? 'ok' : 'err'}>
                  {j.status === 'done' ? `Listo → ${j.dest}` : `Error: ${j.error}`}
                </div>
              )}
            </div>
          )
        })}
      </section>

      <footer className="foot">
        Glyvex Provisions · 100% local · backend 127.0.0.1:8321 · token HF solo por env / `hf auth login`
      </footer>
    </div>
  )
}
