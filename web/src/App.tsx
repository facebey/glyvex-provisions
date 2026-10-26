import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type Catalog,
  type FileRow,
  type Hardware,
  type JobEvent,
  type LibModel,
  type LibraryData,
  type ModelHit,
  type Package,
  type Profile,
  type ProfileGpu,
  type Regime,
  type RepoData,
  type Storage,
  addPackage,
  addProfile,
  addStorage,
  deletePackage,
  deleteProfile,
  deleteStorage,
  downloadPackage,
  fmtBytes,
  getCatalog,
  getHardware,
  getLibrary,
  getRepo,
  listDownloads,
  listPackages,
  listProfiles,
  listStorages,
  openJobEvents,
  pauseDownload,
  resumeDownload,
  retryDownload,
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

// Fila de GPU en el formulario de perfil manual (multi-GPU)
interface GpuRow {
  vendor: string
  model: string // '' | 'other' | modelo
  other: string
  vram: string
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
  const [pRam, setPRam] = useState('')
  // Adición 4d: catálogo (vendor → modelo → VRAM autofillada, editable)
  const [cat, setCat] = useState<Catalog | null>(null)
  const [pCpuVendor, setPCpuVendor] = useState('')
  const [pCpuModel, setPCpuModel] = useState('') // '' | 'other' | modelo
  const [pCpuOther, setPCpuOther] = useState('')
  const [pCpuThreads, setPCpuThreads] = useState('')
  // Multi-GPU: filas dinámicas (vendor → modelo → VRAM autofillada)
  const [gpuRows, setGpuRows] = useState<GpuRow[]>([])
  const [pRamType, setPRamType] = useState('')
  const [pRamSpeed, setPRamSpeed] = useState('')
  // Storage multi-path (R11) + librería local (R9)
  const [storages, setStorages] = useState<Storage[]>([])
  const [showAddStorage, setShowAddStorage] = useState(false)
  const [stName, setStName] = useState('')
  const [stPath, setStPath] = useState('')
  const [lib, setLib] = useState<LibraryData | null>(null)
  const [libFilter, setLibFilter] = useState<string>('') // '' = todos
  // Paquetes de modelos por escenario (R12): manifiestos en <storage>\packajes\
  const [pkgStorage, setPkgStorage] = useState('')
  const [pkgs, setPkgs] = useState<Package[]>([])
  const [showAddPkg, setShowAddPkg] = useState(false)
  const [pkgName, setPkgName] = useState('')
  const [pkgScenario, setPkgScenario] = useState('')
  const [pkgRows, setPkgRows] = useState<{ repo: string; spec: string }[]>([
    { repo: '', spec: '' },
  ])
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
            if (ev.files?.length) nj.filesTotal = ev.files.length
          } else if (ev.type === 'progress') {
            // Barra por archivo: done/total = bytes del archivo actual.
            nj.bytesDone = ev.done ?? 0
            if (ev.total) nj.bytesTotal = ev.total
            nj.status = 'running'
          } else if (ev.type === 'file_done') {
            // Archivo terminado (o saltado por estar completo): avanza
            // el contador y la barra arranca en 0 para el siguiente.
            nj.filesDone = ev.index ?? nj.filesDone
            if (ev.count) nj.filesTotal = ev.count
            nj.bytesDone = 0
            nj.bytesTotal = 0
          } else if (ev.type === 'log') {
            nj.log = [...nj.log, ev.msg ?? ''].slice(-20)
          } else if (ev.type === 'paused') {
            nj.status = 'paused'
            setTimeout(() => closeJob(id), 500)
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
    getCatalog().then(setCat).catch(() => {
      /* catálogo no llega: la cascada queda vacía, sigue siendo usable */
    })
    listDownloads()
      .then((d) => {
        for (const j of d.jobs) {
          // paused también se re-suscribe: el stream re-emite el historial
          // y el evento `paused` deja la tarjeta en su estado correcto.
          if (
            j.status === 'running' ||
            j.status === 'queued' ||
            j.status === 'paused'
          ) {
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

  // Adición 4d: cascada vendor → modelo (VRAM/hilos autofillados del catálogo)
  const onCpuVendor = (v: string) => {
    setPCpuVendor(v)
    setPCpuModel('')
    setPCpuOther('')
    setPCpuThreads('')
  }

  const onCpuModel = (v: string) => {
    setPCpuModel(v)
    if (v && v !== 'other' && pCpuVendor && cat) {
      const hit = (cat.cpus[pCpuVendor] ?? []).find((c) => c.model === v)
      setPCpuThreads(hit ? String(hit.threads) : '')
    } else {
      setPCpuThreads('')
    }
  }

  const addGpuRow = () =>
    setGpuRows((rs) => [...rs, { vendor: '', model: '', other: '', vram: '' }])

  const removeGpuRow = (i: number) =>
    setGpuRows((rs) => rs.filter((_, j) => j !== i))

  const onGpuRowVendor = (i: number, v: string) =>
    setGpuRows((rs) =>
      rs.map((r, j) => (j === i ? { vendor: v, model: '', other: '', vram: '' } : r)),
    )

  const onGpuRowModel = (i: number, v: string) =>
    setGpuRows((rs) =>
      rs.map((r, j) => {
        if (j !== i) return r
        // VRAM autocompletada desde el catálogo (editable)
        let vram = ''
        if (v && v !== 'other' && r.vendor && cat) {
          const hit = (cat.gpus[r.vendor] ?? []).find((g) => g.model === v)
          if (hit) vram = String(hit.vram_gb)
        }
        return { ...r, model: v, other: '', vram }
      }),
    )

  const onGpuRowField = (i: number, patch: Partial<GpuRow>) =>
    setGpuRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const onRamType = (v: string) => {
    setPRamType(v)
    setPRamSpeed('')
  }

  const resetProfileForm = () => {
    setPName('')
    setPRam('')
    setPCpuVendor('')
    setPCpuModel('')
    setPCpuOther('')
    setPCpuThreads('')
    setGpuRows([])
    setPRamType('')
    setPRamSpeed('')
  }

  const doAddProfile = async () => {
    const name = pName.trim()
    const ram = parseFloat(pRam)
    const cpuModel = pCpuModel === 'other' ? pCpuOther.trim() : pCpuModel
    const threads = parseInt(pCpuThreads, 10)
    const speed = parseInt(pRamSpeed, 10)
    if (!name || !Number.isFinite(ram) || ram <= 0) return
    // Multi-GPU: cada fila con modelo exige VRAM válida; las filas vacías se ignoran
    const gpus: ProfileGpu[] = []
    for (const r of gpuRows) {
      const gpuName = r.model === 'other' ? r.other.trim() : r.model
      if (!gpuName) continue
      const vram = parseFloat(r.vram)
      if (!Number.isFinite(vram) || vram <= 0) return
      gpus.push({ vendor: r.vendor || null, name: gpuName, vram_gb: vram })
    }
    setBusy('profile')
    setError(null)
    try {
      const cpu =
        pCpuVendor || cpuModel || Number.isFinite(threads)
          ? {
              vendor: pCpuVendor || null,
              model: cpuModel || null,
              threads: Number.isFinite(threads) ? threads : null,
            }
          : null
      const p = await addProfile({
        name,
        gpus,
        ram_gb: ram,
        cpu,
        ram_type: pRamType || null,
        ram_speed_mhz: Number.isFinite(speed) ? speed : null,
      })
      setProfiles((ps) => [...ps, p])
      setProfileId(p.id)
      resetProfileForm()
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

  // Paquetes de modelos por escenario (R12)
  const pkgStorageId =
    (storages.find((s) => s.id === pkgStorage) ?? storages[0])?.id ?? ''

  const refreshPkgs = (sid: string) => {
    if (!sid) return
    listPackages(sid)
      .then((d) => setPkgs(d.packages))
      .catch(() => setPkgs([]))
  }

  useEffect(() => {
    refreshPkgs(pkgStorageId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storages, pkgStorage])

  const doAddPkg = async () => {
    const name = pkgName.trim()
    if (!name || !pkgStorageId) return
    // Spec con chars de glob = pattern; lo contrario = archivo exacto.
    const files = pkgRows
      .filter((r) => r.repo.trim() && r.spec.trim())
      .map((r) => {
        const spec = r.spec.trim()
        const isGlob = /[*?[\]]/.test(spec)
        return {
          repo_id: r.repo.trim(),
          file: isGlob ? null : spec,
          pattern: isGlob ? spec : null,
        }
      })
    if (files.length === 0) return
    setBusy('pkg')
    setError(null)
    try {
      await addPackage(pkgStorageId, {
        name,
        scenario: pkgScenario.trim() || null,
        files,
      })
      setPkgName('')
      setPkgScenario('')
      setPkgRows([{ repo: '', spec: '' }])
      setShowAddPkg(false)
      refreshPkgs(pkgStorageId)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const doDeletePkg = async (id: string) => {
    if (!pkgStorageId) return
    setBusy('pkg')
    setError(null)
    try {
      await deletePackage(pkgStorageId, id)
      refreshPkgs(pkgStorageId)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const doDownloadPkg = async (id: string) => {
    if (!pkgStorageId) return
    setBusy('pkg')
    setError(null)
    try {
      const d = await downloadPackage(pkgStorageId, id)
      // 1 job por repo único: cada uno se suscribe a su SSE.
      for (const j of d.jobs) attachJob(j.id, j.repo_id, j.files)
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

  const doPause = async (id: string) => {
    try {
      await pauseDownload(id)
      // el SSE manda `paused` de todas formas (y cierra el stream); esto
      // solo refleja el estado sin esperar al evento
      setJobs((js) =>
        js.map((j) => (j.id === id ? { ...j, status: 'paused' } : j)),
      )
    } catch (e) {
      setError(String(e))
    }
  }

  const doResumeOrRetry = async (
    id: string,
    repoId: string,
    filesTotal: number,
    fn: () => Promise<unknown>,
  ) => {
    try {
      await fn()
      setJobs((js) =>
        js.map((j) =>
          j.id === id ? { ...j, status: 'running', error: null } : j,
        ),
      )
      // Re-suscripción: la cola del job sigue viva y el nuevo stream
      // re-emite start/progress desde el punto actual.
      closeJob(id)
      attachJob(id, repoId, filesTotal)
    } catch (e) {
      setError(String(e))
    }
  }

  const doResume = (id: string, repoId: string, filesTotal: number) =>
    doResumeOrRetry(id, repoId, filesTotal, () => resumeDownload(id))

  const doRetry = (id: string, repoId: string, filesTotal: number) =>
    doResumeOrRetry(id, repoId, filesTotal, () => retryDownload(id))

  const gpus = hw?.gpus ?? []

  // Detalle de RAM por módulos (WMI): "4× 16 GB · DDR5 · 5866 MHz · Corsair"
  const ramDetail = (h: Hardware): string => {
    const m = h.ram_modules ?? []
    if (m.length === 0) return ''
    const type = m[0].mem_type ?? ''
    const speed = m[0].speed_mhz
    const mfr = m[0].manufacturer ?? ''
    return [
      `${m.length}× ${fmtBytes(m[0].size_bytes)}`,
      type,
      speed ? `${speed} MHz` : '',
      mfr,
    ].filter(Boolean).join(' · ')
  }

  const cpuDetail = (h: Hardware): string => {
    const c = h.cpu
    if (!c) return ''
    const cores = c.cores > 0 && c.cores !== c.logical
      ? `${c.cores} cores / ${c.logical} hilos`
      : `${c.logical} hilos`
    return [
      c.vendor ?? '',
      cores,
      c.base_mhz ? `base ${(c.base_mhz / 1000).toFixed(1)} GHz` : '',
      c.socket ?? '',
    ].filter(Boolean).join(' · ')
  }
  const activeProfile = profiles.find((p) => p.id === profileId) ?? null
  const manualProfiles = profiles.filter((p) => p.kind === 'manual')

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">
            {/* Logo Glyvex AI (brand kit oficial) — diamante teal + punto naranja (idéntico a ai-suite.glyvexgroup.com) */}
            <svg viewBox="0 0 80 80" width="24" height="24" role="img" aria-label="Glyvex AI">
              <defs>
                <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#0d9488" />
                  <stop offset="50%" stopColor="#06b6d4" />
                  <stop offset="100%" stopColor="#0ea5e9" />
                </linearGradient>
              </defs>
              <polygon points="40,12 66,38 40,72 14,38" fill="url(#logoGrad)" />
              <polygon points="40,12 66,38 40,40" fill="#0d9488" opacity="0.35" />
              <polygon points="40,40 66,38 40,72" fill="#0ea5e9" opacity="0.25" />
              <circle cx="40" cy="38" r="4.5" fill="#f97316" />
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
              {hw.cpu?.name && (
                <div className="hw-item">
                  <span className="hw-icon">🖥️</span>
                  <div>
                    <div className="hw-name">{hw.cpu.name}</div>
                    <div className="hw-meta">{cpuDetail(hw)}</div>
                  </div>
                </div>
              )}
              {gpus.map((g) => (
                <div key={`${g.vendor}-${g.index}`} className="hw-item">
                  <span className="hw-icon">🎮</span>
                  <div>
                    <div className="hw-name">{g.name}</div>
                    <div className="hw-meta">
                      {g.vendor ? `${g.vendor.toUpperCase()} · ` : ''}
                      {g.shared_memory
                        ? 'memoria compartida (sin VRAM dedicada)'
                        : `VRAM ${fmtBytes(g.vram_total_bytes)} · libre ${fmtBytes(g.vram_free_bytes)}`}
                      {g.driver ? ` · driver ${g.driver}` : ''}
                    </div>
                  </div>
                </div>
              ))}
              {gpus.length === 0 && (
                <div className="hw-item">
                  <span className="hw-icon">⚠️</span>
                  <div>
                    <div className="hw-name">Sin GPU detectada</div>
                    <div className="hw-meta">usa el régimen CPU / Offload</div>
                  </div>
                </div>
              )}
              <div className="hw-item">
                <span className="hw-icon">🧠</span>
                <div>
                  <div className="hw-name">RAM {fmtBytes(hw.ram_total_bytes)}</div>
                  <div className="hw-meta">{ramDetail(hw)}</div>
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
            {(activeProfile.cpu?.model || activeProfile.cpu?.vendor) && (
              <div className="hw-item">
                <span className="hw-icon">⚙️</span>
                <div>
                  <div className="hw-name">
                    CPU: {activeProfile.cpu.vendor ? activeProfile.cpu.vendor + ' ' : ''}
                    {activeProfile.cpu.model ?? '—'}
                    {activeProfile.cpu.threads ? ` (${activeProfile.cpu.threads} hilos)` : ''}
                  </div>
                  <div className="hw-meta">declarada manualmente</div>
                </div>
              </div>
            )}
            <div className="hw-item">
              <span className="hw-icon">🧠</span>
              <div>
                <div className="hw-name">
                  RAM {activeProfile.ram_gb} GB
                  {activeProfile.ram_type ? ` ${activeProfile.ram_type}` : ''}
                  {activeProfile.ram_speed_mhz ? ` ${activeProfile.ram_speed_mhz} MT/s` : ''}
                </div>
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
          <div className="addprofile cascade">
            <input
              placeholder="Nombre (p. ej. Server-01)"
              value={pName}
              onChange={(e) => setPName(e.target.value)}
            />
            <div className="row formrow">
              <span className="muted">CPU:</span>
              <select
                value={pCpuVendor}
                onChange={(e) => onCpuVendor(e.target.value)}
              >
                <option value="">— sin CPU —</option>
                {cat && Object.keys(cat.cpus).map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
              <select
                value={pCpuModel}
                onChange={(e) => onCpuModel(e.target.value)}
                disabled={!pCpuVendor}
              >
                <option value="">— modelo —</option>
                {cat &&
                  (cat.cpus[pCpuVendor] ?? []).map((c) => (
                    <option key={c.model} value={c.model}>{c.model}</option>
                  ))}
                {pCpuVendor && <option value="other">Otro… (manual)</option>}
              </select>
              {pCpuModel === 'other' ? (
                <input
                  placeholder="Modelo de CPU (texto libre)"
                  value={pCpuOther}
                  onChange={(e) => setPCpuOther(e.target.value)}
                />
              ) : (
                <input
                  type="number" min="1" step="1" placeholder="Hilos"
                  value={pCpuThreads}
                  onChange={(e) => setPCpuThreads(e.target.value)}
                  disabled={!pCpuModel}
                />
              )}
            </div>
            <div className="row formrow">
              <span className="muted">GPU(s):</span>
              <button className="mini" onClick={addGpuRow}>
                + Agregar GPU
              </button>
              {gpuRows.length === 0 && (
                <span className="muted">sin GPU: perfil solo CPU/RAM</span>
              )}
            </div>
            {gpuRows.map((r, i) => (
              <div className="row formrow" key={i}>
                <span className="muted">GPU {i + 1}:</span>
                <select
                  value={r.vendor}
                  onChange={(e) => onGpuRowVendor(i, e.target.value)}
                >
                  <option value="">— vendor —</option>
                  {cat && Object.keys(cat.gpus).map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
                <select
                  value={r.model}
                  onChange={(e) => onGpuRowModel(i, e.target.value)}
                  disabled={!r.vendor}
                >
                  <option value="">— modelo —</option>
                  {cat &&
                    (cat.gpus[r.vendor] ?? []).map((g) => (
                      <option key={g.model} value={g.model}>{g.model}</option>
                    ))}
                  {r.vendor && <option value="other">Otro… (manual)</option>}
                </select>
                {r.model === 'other' && (
                  <input
                    placeholder="Modelo de GPU (texto libre)"
                    value={r.other}
                    onChange={(e) => onGpuRowField(i, { other: e.target.value })}
                  />
                )}
                <input
                  type="number" min="0.5" step="0.5"
                  placeholder="VRAM GB (autofill, editable)"
                  value={r.vram}
                  onChange={(e) => onGpuRowField(i, { vram: e.target.value })}
                  disabled={!r.model}
                />
                <button
                  className="mini danger"
                  onClick={() => removeGpuRow(i)}
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="row formrow">
              <span className="muted">RAM:</span>
              <input
                type="number" min="1" step="1" placeholder="Capacidad GB"
                value={pRam}
                onChange={(e) => setPRam(e.target.value)}
              />
              <select
                value={pRamType}
                onChange={(e) => onRamType(e.target.value)}
              >
                <option value="">— tipo —</option>
                {cat && Object.keys(cat.ram).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <select
                value={pRamSpeed}
                onChange={(e) => setPRamSpeed(e.target.value)}
                disabled={!pRamType}
              >
                <option value="">— velocidad —</option>
                {cat &&
                  (cat.ram[pRamType] ?? []).map((s) => (
                    <option key={s} value={s}>{s} MT/s</option>
                  ))}
              </select>
            </div>
            <button
              className="primary"
              disabled={
                busy === 'profile' || !pName.trim() ||
                !Number.isFinite(parseFloat(pRam))
              }
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
                  {p.cpu?.model ? ` · CPU ${p.cpu.model}` : ''}
                  {' · '}RAM {p.ram_gb} GB{p.ram_type ? ` ${p.ram_type}` : ''}
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

      {/* Paquetes de modelos por escenario (R12) */}
      <section className="panel packages">
        <h2>Paquetes de modelos</h2>
        <div className="muted small">
          Manifiestos de texto plano para descargar un escenario completo en un
          clic (p. ej. “Escritorio técnico: 3 modelos Q4”). Viven en{' '}
          <span className="mono">{'<storage>\\packajes\\'}</span>: editables y
          copiables entre servers.
        </div>
        {storages.length === 0 ? (
          <div className="muted">
            Agregá un storage primero (en «Storage y librería»): los paquetes
            cuelgan de un storage y ahí caen las descargas.
          </div>
        ) : (
          <>
            <div className="row profilebar">
              <label className="dest">
                Storage:
                <select
                  name="pkgstorage"
                  value={pkgStorageId}
                  onChange={(e) => setPkgStorage(e.target.value)}
                >
                  {storages.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              <button className="mini" onClick={() => setShowAddPkg((v) => !v)}>
                {showAddPkg ? 'Cerrar' : '+ Agregar paquete'}
              </button>
            </div>
            {showAddPkg && (
              <div className="addprofile cascade">
                <div className="row formrow">
                  <input
                    placeholder="Nombre (p. ej. escritorio-tecnico)"
                    value={pkgName}
                    onChange={(e) => setPkgName(e.target.value)}
                  />
                  <input
                    placeholder="Escenario (p. ej. Escritorio técnico: 3 modelos Q4)"
                    value={pkgScenario}
                    onChange={(e) => setPkgScenario(e.target.value)}
                  />
                </div>
                {pkgRows.map((row, i) => (
                  <div key={i} className="row formrow">
                    <input
                      placeholder="repo_id (p. ej. ggml-org/gemma-3-4b-it-GGUF)"
                      value={row.repo}
                      onChange={(e) =>
                        setPkgRows((rs) =>
                          rs.map((r, j) =>
                            j === i ? { ...r, repo: e.target.value } : r,
                          ),
                        )
                      }
                    />
                    <input
                      placeholder="archivo exacto O patrón glob (p. ej. *Q4_K_M.gguf)"
                      value={row.spec}
                      onChange={(e) =>
                        setPkgRows((rs) =>
                          rs.map((r, j) =>
                            j === i ? { ...r, spec: e.target.value } : r,
                          ),
                        )
                      }
                    />
                    <button
                      className="mini danger"
                      disabled={pkgRows.length <= 1}
                      onClick={() =>
                        setPkgRows((rs) => rs.filter((_, j) => j !== i))
                      }
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <div className="row formrow">
                  <button
                    className="mini"
                    onClick={() =>
                      setPkgRows((rs) => [...rs, { repo: '', spec: '' }])
                    }
                  >
                    + entrada
                  </button>
                  <button
                    className="primary"
                    disabled={
                      busy === 'pkg' ||
                      !pkgName.trim() ||
                      pkgRows.every((r) => !r.repo.trim() || !r.spec.trim())
                    }
                    onClick={doAddPkg}
                  >
                    {busy === 'pkg' ? 'Guardando…' : 'Guardar'}
                  </button>
                </div>
              </div>
            )}
            {pkgs.length > 0 && (
              <div className="prof-list">
                {pkgs.map((p) => (
                  <div key={p.id} className="row prof-row">
                    <span className="mono muted">{p.id}.json</span>
                    <b>{p.name}</b>
                    {p.scenario && <span className="muted">— {p.scenario}</span>}
                    <span className="muted">
                      {p.files.length} entradas ·{' '}
                      {new Set(p.files.map((f) => f.repo_id)).size} repos
                    </span>
                    {p.error ? (
                      <span className="muted" title={p.error}>
                        ⚠️ {p.error}
                      </span>
                    ) : (
                      <>
                        <button
                          className="mini"
                          disabled={busy === 'pkg'}
                          onClick={() => doDownloadPkg(p.id)}
                        >
                          ⬇ Descargar
                        </button>
                        <button
                          className="mini danger"
                          disabled={busy === 'pkg'}
                          onClick={() => doDeletePkg(p.id)}
                        >
                          ✕ borrar
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            {pkgs.length === 0 && (
              <div className="muted">
                Sin paquetes en este storage. Crealo desde acá o tirá un
                manifiesto .json en la carpeta{' '}
                <span className="mono">packajes</span>.
              </div>
            )}
          </>
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
                {(j.status === 'running' || j.status === 'queued') && (
                  <button className="mini" style={{ marginLeft: 'auto' }}
                    onClick={() => doPause(j.id)}>
                    Pausar
                  </button>
                )}
                {j.status === 'paused' && (
                  <button className="mini" style={{ marginLeft: 'auto' }}
                    onClick={() => doResume(j.id, j.repo_id, j.filesTotal)}>
                    Reanudar
                  </button>
                )}
                {j.status === 'error' && (
                  <button className="mini" style={{ marginLeft: 'auto' }}
                    onClick={() => doRetry(j.id, j.repo_id, j.filesTotal)}>
                    Reintentar
                  </button>
                )}
              </div>
              {j.status === 'running' || j.status === 'queued' || j.status === 'paused' ? (
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
