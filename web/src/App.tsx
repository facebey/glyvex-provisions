import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type FileRow,
  type Hardware,
  type JobEvent,
  type LibModel,
  type LibraryData,
  type ModelHit,
  type Profile,
  type Regime,
  type RepoData,
  type Storage,
  addProfile,
  addStorage,
  deleteProfile,
  deleteStorage,
  fmtBytes,
  getHardware,
  getLibrary,
  getRepo,
  listDownloads,
  listProfiles,
  listStorages,
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
  const [dest, setDest] = useState<string>('')  // R11: path de storage elegido
  const [jobs, setJobs] = useState<JobView[]>([])
  // Perfiles de hardware (R10): "local" (auto) + manuales
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [profileId, setProfileId] = useState<string>('local')
  const [showAddProfile, setShowAddProfile] = useState(false)
  const [pName, setPName] = useState('')
  const [pGpu, setPGpu] = useState('')
  const [pVram, setPVram] = useState('')
  const [pRam, setPRam] = useState('')
  // Storage multi-path (R11) + librería local (R9)
  const [storages, setStorages] = useState<Storage[]>([])
  const [showAddStorage, setShowAddStorage] = useState(false)
  const [stName, setStName] = useState('')
  const [stPath, setStPath] = useState('')
  const [lib, setLib] = useState<LibraryData | null>(null)
  const [libFilter, setLibFilter] = useState<string>('') // '' = todos
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
    listProfiles().then((d) => setProfiles(d.profiles)).catch(() => {
      /* backend caído: ya se muestra el error del hardware */
    })
    listStorages().then((d) => setStorages(d.storages)).catch(() => {
      /* backend caído: ya se muestra el error del hardware */
    })
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
      const d = await getRepo(repoId, regime, profileId)
      setRepo(d)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  // Si cambia el régimen o el perfil, re-calcular la tabla del repo abierto
  useEffect(() => {
    if (repo) {
      getRepo(repo.repo_id, regime, profileId)
        .then(setRepo)
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regime, profileId])

  const doAddProfile = async () => {
    const name = pName.trim()
    const vram = parseFloat(pVram)
    const ram = parseFloat(pRam)
    if (!name || !Number.isFinite(vram) || vram <= 0 ||
        !Number.isFinite(ram) || ram <= 0) return
    setBusy('profile')
    setError(null)
    try {
      const gpus = pGpu.trim() ? [{ name: pGpu.trim(), vram_gb: vram }] : []
      const p = await addProfile({ name, gpus, ram_gb: ram })
      setProfiles((ps) => [...ps, p])
      setProfileId(p.id)
      setPName('')
      setPGpu('')
      setPVram('')
      setPRam('')
      setShowAddProfile(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const doDeleteProfile = async (id: string) => {
    setBusy('profile')
    setError(null)
    try {
      await deleteProfile(id)
      setProfiles((ps) => ps.filter((p) => p.id !== id))
      if (profileId === id) setProfileId('local')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const doAddStorage = async () => {
    const name = stName.trim()
    const path = stPath.trim()
    if (!name || !path) return
    setBusy('storage')
    setError(null)
    try {
      const s = await addStorage({ name, path })
      setStorages((ss) => [...ss, s])
      setStName('')
      setStPath('')
      setShowAddStorage(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const doDeleteStorage = async (id: string) => {
    setBusy('storage')
    setError(null)
    try {
      await deleteStorage(id)
      const removed = storages.find((s) => s.id === id)
      setStorages((ss) => ss.filter((s) => s.id !== id))
      if (removed && dest === removed.path) setDest('')
      if (libFilter === id) setLibFilter('')
      if (lib) setLib(null) // la librería mostrada ya no es válida
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const doScanLibrary = async () => {
    setBusy('lib')
    setError(null)
    try {
      setLib(await getLibrary(libFilter || undefined))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const libModels: LibModel[] = lib
    ? libFilter
      ? lib.models.filter((m) => m.storage_id === libFilter)
      : lib.models
    : []

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

  // Select-all de la tabla: marca/desmarca TODOS los archivos del repo.
  const toggleAll = () => {
    if (!repo) return
    const all = repo.rows.length > 0 &&
      repo.rows.every((r) => selected.has(r.path))
    setSelected(all ? new Set() : new Set(repo.rows.map((r) => r.path)))
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
  const activeProfile = profiles.find((p) => p.id === profileId) ?? null
  const manualProfiles = profiles.filter((p) => p.kind === 'manual')

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

      {/* Panel de hardware: el perfil elegido (local auto o manual) */}
      <section className="panel hw">
        {profileId === 'local' ? (
          hw ? (
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
                </div>
              </div>
            </>
          ) : (
            <div className="hw-item">
              <div className="hw-meta">{error ?? 'Leyendo hardware…'}</div>
            </div>
          )
        ) : activeProfile ? (
          <>
            <div className="hw-item profile-active">
              <span className="hw-icon">🎛️</span>
              <div>
                <div className="hw-name">Semáforo contra: {activeProfile.name}</div>
                <div className="hw-meta">
                  perfil manual — declarás lo que tiene el server (la app no se conecta a él)
                </div>
              </div>
            </div>
            {activeProfile.gpus.map((g, i) => (
              <div key={i} className="hw-item">
                <span className="hw-icon">🎮</span>
                <div>
                  <div className="hw-name">{g.name}</div>
                  <div className="hw-meta">VRAM {g.vram_gb} GB</div>
                </div>
              </div>
            ))}
            {activeProfile.gpus.length === 0 && (
              <div className="hw-item">
                <span className="hw-icon">⚠️</span>
                <div>
                  <div className="hw-name">Sin GPU declarada</div>
                  <div className="hw-meta">usa el régimen CPU / Offload</div>
                </div>
              </div>
            )}
            <div className="hw-item">
              <span className="hw-icon">🧠</span>
              <div>
                <div className="hw-name">RAM {activeProfile.ram_gb} GB</div>
                <div className="hw-meta">declarada manualmente</div>
              </div>
            </div>
          </>
        ) : (
          <div className="hw-item">
            <div className="hw-meta">Cargando perfiles…</div>
          </div>
        )}
      </section>

      {/* Perfiles de hardware (R10) */}
      <section className="panel profiles">
        <div className="row profilebar">
          <span className="muted">Perfil de hardware:</span>
          <select
            name="profile"
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            className="mini"
            onClick={() => setShowAddProfile((v) => !v)}
          >
            {showAddProfile ? 'Cerrar' : '+ Agregar perfil (otro server)'}
          </button>
        </div>
        {showAddProfile && (
          <div className="row addprofile">
            <input
              placeholder="Nombre (p. ej. Server-01)"
              value={pName}
              onChange={(e) => setPName(e.target.value)}
            />
            <input
              placeholder="GPU (p. ej. RTX 4090; vacío si no tiene)"
              value={pGpu}
              onChange={(e) => setPGpu(e.target.value)}
            />
            <input
              type="number" min="0.5" step="0.5" placeholder="VRAM GB"
              value={pVram}
              onChange={(e) => setPVram(e.target.value)}
            />
            <input
              type="number" min="1" step="1" placeholder="RAM GB"
              value={pRam}
              onChange={(e) => setPRam(e.target.value)}
            />
            <button
              className="primary"
              disabled={busy === 'profile' || !pName.trim()}
              onClick={doAddProfile}
            >
              {busy === 'profile' ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        )}
        {manualProfiles.length > 0 && (
          <div className="prof-list">
            {manualProfiles.map((p) => (
              <div key={p.id} className="row prof-row">
                <span className="mono muted">{p.id}</span>
                <b>{p.name}</b>
                <span className="muted">
                  {p.gpus.length > 0
                    ? p.gpus.map((g) => `${g.name} ${g.vram_gb} GB`).join(', ')
                    : 'sin GPU'}
                  {' · '}RAM {p.ram_gb} GB
                </span>
                <button
                  className="mini danger"
                  disabled={busy === 'profile'}
                  onClick={() => doDeleteProfile(p.id)}
                >
                  ✕ borrar
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Storage y librería local (R11 / R9) */}
      <section className="panel storage">
        <h2>Storage y librería</h2>
        <div className="row profilebar">
          <span className="muted">Paths de storage (destino de descargas + base de la librería):</span>
          <button className="mini" onClick={() => setShowAddStorage((v) => !v)}>
            {showAddStorage ? 'Cerrar' : '+ Agregar storage'}
          </button>
        </div>
        {showAddStorage && (
          <div className="row addprofile">
            <input
              placeholder="Nombre (p. ej. NAS-01)"
              value={stName}
              onChange={(e) => setStName(e.target.value)}
            />
            <input
              placeholder="Ruta (G:\LLM, C:\LLM, \\NAS\compartido…)"
              value={stPath}
              onChange={(e) => setStPath(e.target.value)}
              className="st-path"
            />
            <button
              className="primary"
              disabled={busy === 'storage' || !stName.trim() || !stPath.trim()}
              onClick={doAddStorage}
            >
              {busy === 'storage' ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        )}
        {storages.length > 0 && (
          <div className="prof-list">
            {storages.map((s) => (
              <div key={s.id} className="row prof-row">
                <span className="mono muted">{s.id}</span>
                <b>{s.name}</b>
                <span className="mono muted" title={s.path}>{s.path}</span>
                <button
                  className="mini danger"
                  disabled={busy === 'storage'}
                  onClick={() => doDeleteStorage(s.id)}
                >
                  ✕ borrar
                </button>
              </div>
            ))}
          </div>
        )}
        {storages.length === 0 && !showAddStorage && (
          <div className="muted">
            Sin storages. Agregá al menos uno (p. ej. <span className="mono">D:\LLM</span>)
            para escanear la librería; las descargas apuntarán a uno de estos paths.
          </div>
        )}

        {storages.length > 0 && (
          <div className="row libbar">
            <button
              onClick={doScanLibrary}
              disabled={busy === 'lib' || storages.length === 0}
            >
              {busy === 'lib' ? 'Escaneando…' : '🔍 Escanear librería'}
            </button>
            <label className="dest">
              Storage:
              <select
                name="libfilter"
                value={libFilter}
                onChange={(e) => { setLibFilter(e.target.value); setLib(null) }}
              >
                <option value="">Todos</option>
                {storages.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
            {lib && (
              <span className="muted">
                {libModels.length} modelos · {lib.files} pesos · {lib.scanned_dirs} carpetas
                {lib.errors > 0 && ` · ${lib.errors} errores de acceso`}
                {lib.truncated && ' · (truncado)'}
              </span>
            )}
          </div>
        )}
        {lib && libModels.length > 0 && (
          <table className="tbl">
            <thead>
              <tr>
                <th>Modelo</th>
                <th>Storage</th>
                <th>Cuantizaciones</th>
                <th className="num">Tamaño</th>
              </tr>
            </thead>
            <tbody>
              {libModels.map((m) => (
                <tr key={`${m.storage_id}:${m.model_dir}`}>
                  <td>
                    <b>{m.name}</b>
                    <div className="mono small" title={m.model_dir}>{m.model_dir}</div>
                  </td>
                  <td className="muted">{m.storage_name}</td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {m.quants.map((q) => (
                        <span key={q} className="chip tiny" style={{ cursor: 'default' }}>{q}</span>
                      ))}
                    </div>
                  </td>
                  <td className="num">{fmtBytes(m.total_bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {lib && libModels.length === 0 && (
          <div className="muted">
            Ningún archivo de pesos en los storages escaneados
            {lib.errors > 0 ? ` (${lib.errors} errores de acceso)` : ''}.
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
              <span className="muted">
                {' — '}
                {repo.rows.length} archivos de pesos · régimen: {REGIME_LABELS[regime]}
                {repo.profile ? ` · perfil: ${repo.profile.name}` : ''}
              </span>
            </div>
            <div className="row totals">
              <span>
                Seleccionado: <b>{selected.size}</b> archivos · <b>{fmtBytes(selectedBytes)}</b>
              </span>
              <label className="dest">
                Destino (storage):
                <select
                  name="dest"
                  value={dest}
                  onChange={(e) => setDest(e.target.value)}
                >
                  <option value="">— elegí un storage —</option>
                  {storages.map((s) => (
                    <option key={s.id} value={s.path}>
                      {s.name} · {s.path}
                    </option>
                  ))}
                </select>
              </label>
              {storages.length === 0 && (
                <span className="muted">
                  Sin storages: agregá uno en «Storage y librería»
                </span>
              )}
              <button
                className="primary"
                disabled={selected.size === 0 || !dest || busy === 'dl'}
                onClick={doDownload}
              >
                {busy === 'dl' ? 'Enviando…' : '⬇ Descargar'}
              </button>
            </div>
          </div>
          <table className="tbl files">
            <thead>
              <tr>
                <th style={{ width: 28 }}>
                  <input
                    type="checkbox"
                    title="Seleccionar / desmarcar todos los archivos"
                    checked={repo.rows.length > 0 &&
                      repo.rows.every((r) => selected.has(r.path))}
                    onChange={toggleAll}
                  />
                </th>
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
