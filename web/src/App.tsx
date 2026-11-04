import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type Catalog,
  type EnginesData,
  type FileRow,
  type Hardware,
  type JobEvent,
  type LibModel,
  type LibraryData,
  type ModelHit,
  type Package,
  type Preset,
  type PresetIn,
  type PresetScenario,
  type Profile,
  type ProfileGpu,
  type Regime,
  type RepoData,
  type Settings,
  type Storage,
  type SessionEvent,
  type SessionInfo,
  type SessionState,
  type SuiteStatus,
  addPackage,
  addProfile,
  addStorage,
  createPreset,
  deletePackage,
  deletePreset,
  deleteProfile,
  deleteStorage,
  downloadPackage,
  fmtBytes,
  getCatalog,
  getEngines,
  getHardware,
  getLibrary,
  getPresets,
  getRepo,
  getSession,
  getSettings,
  getSuiteStatus,
  launchModel,
  listDownloads,
  listPackages,
  listProfiles,
  listStorages,
  openJobEvents,
  openSessionEvents,
  pauseDownload,
  registerSuiteFolder,
  resumeDownload,
  retryDownload,
  saveEngines,
  saveSettings,
  searchModels,
  stopSession,
  submitDownload,
  updatePreset,
} from './api'
import {
  type UpdateInfo,
  checkForUpdate,
  isTauri,
  relaunchApp,
  stopSidecar,
} from './tauri'

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
  multi: 'Multi-GPU (suma VRAM)',
  offload: 'Offload GPU+RAM',
  cpu: 'Solo CPU (RAM)',
}

// U15: estados de la sesión del lanzador (espejo del backend)
const SESSION_STATE_LABELS: Record<SessionState, string> = {
  starting: 'Cargando el modelo…',
  verifying: 'Verificando (primer token)…',
  ready: 'Corriendo',
  failed: 'Falló',
  stopped: 'Detenido',
}

// Formato de porcentaje para el formulario de Ajustes (U6-3): quita el
// ruido de punto flotante (0.95*100 -> "95", 82.5 -> "82.5").
function fmtPct(n: number): string {
  return String(+(Math.round(n * 10) / 10))
}

export default function App() {
  const [hw, setHw] = useState<Hardware | null>(null)
  const [regime, setRegime] = useState<Regime>('gpu')
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<ModelHit[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // U13: auto-update (espejo de la Suite T6.1). Inerte fuera de la shell Tauri
  // (en el navegador de dev isTauri() es false y esto nunca se activa).
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [updateState, setUpdateState] = useState<'available' | 'downloading' | 'error'>('available')
  const [updateProgress, setUpdateProgress] = useState(-1) // -1: total aún desconocido
  const [updateError, setUpdateError] = useState('')
  const [updateDismissed, setUpdateDismissed] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void (async () => {
      try {
        // Silencioso a propósito: sin red o sin feed no se molesta al usuario.
        const u = await checkForUpdate()
        if (u && !cancelled) {
          setUpdate(u)
          setUpdateState('available')
        }
      } catch {
        /* el updater no debe romper la app */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const installUpdate = async () => {
    const upd = update
    if (!upd?.downloadAndInstall) return
    setUpdateState('downloading')
    setUpdateProgress(-1)
    setUpdateError('')
    try {
      // El NSIS no puede sobrescribir _internal/ con el backend vivo: pedimos a
      // Rust que lo detenga (stop_sidecar) y NO lo re-levante. La SPA ya está
      // en memoria: la descarga e instalación siguen aunque el backend caiga.
      await stopSidecar()
      let total = 0
      let done = 0
      await upd.downloadAndInstall((ev) => {
        if (ev?.event === 'Started' && ev.data?.contentLength) {
          total = ev.data.contentLength
        } else if (ev?.event === 'Progress') {
          done += ev.data?.chunkLength ?? 0
          if (total) setUpdateProgress(Math.min(100, Math.round((done / total) * 100)))
        } else if (ev?.event === 'Finished') {
          setUpdateProgress(100)
        }
      })
      await relaunchApp()
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message || String(e.stack ?? e) : String(e))
      setUpdateState('error')
    }
  }
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
  // U15: lanzador de modelos (ecosistema Glyvex: Suite + servers R10)
  const [engines, setEngines] = useState<EnginesData | null>(null)
  const [userBin, setUserBin] = useState('')
  const [suiteSt, setSuiteSt] = useState<SuiteStatus | null>(null)
  const [launchModelDir, setLaunchModelDir] = useState('') // de la librería
  const [launchFile, setLaunchFile] = useState('') // .gguf dentro del modelo
  const [launchPath, setLaunchPath] = useState('') // ruta manual (prende si llena)
  const [launchEngine, setLaunchEngine] = useState('auto')
  // U16: presets (cómo lanzar, no qué modelo) + visión + args avanzados
  const [presets, setPresets] = useState<Preset[]>([])
  const [presetEditId, setPresetEditId] = useState('') // '' = creando nuevo
  const [presetName, setPresetName] = useState('')
  const [presetScenario, setPresetScenario] =
    useState<PresetScenario>('chat')
  const [mmprojSel, setMmprojSel] = useState('') // '' | ruta archivo | 'manual'
  const [mmprojManual, setMmprojManual] = useState('')
  const [launchExtra, setLaunchExtra] = useState('')
  const [launchPort, setLaunchPort] = useState('')
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [sessionLog, setSessionLog] = useState<string[]>([])
  const [suiteMsg, setSuiteMsg] = useState('')
  const sessionEsRef = useRef<EventSource | null>(null)
  // Ajustes persistentes (U6-3): umbrales del semáforo, margen, contexto.
  // En la UI los umbrales y el margen se manejan como porcentajes.
  const [adjOk, setAdjOk] = useState('80')
  const [adjTight, setAdjTight] = useState('95')
  const [adjMargin, setAdjMargin] = useState('5')
  const [adjContext, setAdjContext] = useState('8192')
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
    getSettings().then((s) => {
      setAdjOk(fmtPct(s.ok_frac * 100))
      setAdjTight(fmtPct(s.tight_frac * 100))
      setAdjMargin(fmtPct(s.margin_pct))
      setAdjContext(String(s.context))
    }).catch(() => {
      /* backend caído: el formulario queda con los defaults visibles */
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

  // Ajustes (U6-3): persistar y re-calcular la tabla abierta con los
  // nuevos umbrales/margen (el backend aplica los valores a `fit`).
  const doSaveSettings = async () => {
    const body: Settings = {
      context: parseInt(adjContext, 10),
      margin_pct: parseFloat(adjMargin),
      ok_frac: parseFloat(adjOk) / 100,
      tight_frac: parseFloat(adjTight) / 100,
    }
    if (
      !Number.isFinite(body.context) ||
      !Number.isFinite(body.margin_pct) ||
      !Number.isFinite(body.ok_frac) ||
      !Number.isFinite(body.tight_frac)
    ) {
      setError('Ajustes inválidos: completá los cuatro valores numéricos.')
      return
    }
    setBusy('settings')
    setError(null)
    try {
      const s = await saveSettings(body)
      setAdjOk(fmtPct(s.ok_frac * 100))
      setAdjTight(fmtPct(s.tight_frac * 100))
      setAdjMargin(fmtPct(s.margin_pct))
      setAdjContext(String(s.context))
      if (repo) {
        getRepo(repo.repo_id, regime, profileId).then(setRepo).catch(() => {})
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  // -------------------------------------------------------------------------
  // U15: lanzador de modelos (verificación + registro en la Suite)
  // -------------------------------------------------------------------------
  const closeSessionEvents = useCallback(() => {
    sessionEsRef.current?.close()
    sessionEsRef.current = null
  }, [])

  const attachSessionEvents = useCallback(() => {
    closeSessionEvents()
    const es = openSessionEvents((ev: SessionEvent) => {
      if (ev.type === 'log' && ev.line) {
        setSessionLog((l) => [...l.slice(-499), ev.line as string])
      } else if (ev.type === 'state') {
        setSession((s) =>
          s
            ? {
                ...s,
                state: ev.state ?? s.state,
                error: ev.error ?? s.error,
                metrics: ev.metrics ?? s.metrics,
              }
            : s,
        )
        if (ev.state === 'failed' || ev.state === 'stopped') {
          closeSessionEvents()
          // snapshot final: métricas + tail completo (autoridad sobre el log)
          getSession()
            .then((s) => {
              setSession(s)
              setSessionLog(s.log_tail)
            })
            .catch(() => {})
        }
      }
    })
    sessionEsRef.current = es
  }, [closeSessionEvents])

  // Carga inicial del lanzador: engines + Suite + sesión activa (re-attach).
  useEffect(() => {
    getEngines()
      .then((d) => {
        setEngines(d)
        setUserBin(d.user_binary ?? '')
      })
      .catch(() => {})
    getSuiteStatus().then(setSuiteSt).catch(() => {})
    getPresets().then((d) => setPresets(d.presets)).catch(() => {})
    getSession()
      .then((s) => {
        setSession(s)
        setSessionLog(s.log_tail)
        if (s.state !== 'failed' && s.state !== 'stopped') attachSessionEvents()
      })
      .catch(() => {
        setSession(null) // 404: no hay sesión
      })
    return closeSessionEvents
  }, [attachSessionEvents, closeSessionEvents])

  const doSaveUserBinary = async () => {
    setBusy('engines')
    setError(null)
    try {
      await saveEngines(userBin.trim() || null)
      const d = await getEngines()
      setEngines(d)
      setUserBin(d.user_binary ?? '')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const doLaunch = async () => {
    const path = launchPath.trim() || launchFile
    if (!path) {
      setError('Elegí un modelo de la librería (o poné una ruta manual).')
      return
    }
    setBusy('launch')
    setError(null)
    setSuiteMsg('')
    closeSessionEvents()
    setSessionLog([])
    setSession(null)
    try {
      await launchModel({
        model_path: path,
        engine: launchEngine,
        profile_id: profileId,
        regime,
        context: parseInt(adjContext, 10) || 4096,
        port: launchPort.trim() ? parseInt(launchPort, 10) || null : null,
        mmproj: mmprojValue || null,
        extra_args: launchExtra.trim() || null,
      })
      attachSessionEvents()
      getSession().then(setSession).catch(() => {})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const doStop = async () => {
    setBusy('stop')
    setError(null)
    try {
      await stopSession()
      closeSessionEvents()
      getSession()
        .then((s) => {
          setSession(s)
          setSessionLog(s.log_tail)
        })
        .catch(() => {})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // U16: guardar el preset desde el formulario actual (launch sigue explícito)
  const doSavePreset = async () => {
    if (!presetName.trim()) {
      setError('Poné un nombre para el preset.')
      return
    }
    setBusy('preset')
    setError(null)
    const body: PresetIn = {
      name: presetName.trim(),
      scenario: presetScenario,
      engine: launchEngine,
      profile_id: profileId,
      regime,
      context: parseInt(adjContext, 10) || 4096,
      port: launchPort.trim() ? parseInt(launchPort, 10) || null : null,
      mmproj: mmprojValue || null,
      extra_args: launchExtra.trim(),
    }
    try {
      if (presetEditId) await updatePreset(presetEditId, body)
      else await createPreset(body)
      setPresetEditId('')
      setPresetName('')
      const d = await getPresets()
      setPresets(d.presets)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // U16: aplicar preset = rellenar el formulario (no lanza nada)
  const doApplyPreset = (p: Preset) => {
    setLaunchEngine(p.engine)
    setRegime(p.regime)
    setAdjContext(String(p.context))
    setLaunchPort(p.port ? String(p.port) : '')
    setMmprojSel(p.mmproj || '')
    setMmprojManual(p.mmproj || '')
    setLaunchExtra(p.extra_args)
    setPresetScenario(p.scenario)
  }

  const doDeletePreset = async (p: Preset) => {
    if (!window.confirm(`¿Borrar el preset «${p.name}»?`)) return
    setBusy('preset')
    setError(null)
    try {
      await deletePreset(p.id)
      if (presetEditId === p.id) {
        setPresetEditId('')
        setPresetName('')
      }
      const d = await getPresets()
      setPresets(d.presets)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const doRegisterSuite = async () => {
    const dir = selectedModel?.model_dir
    if (!dir || !suiteSt) return
    const ok = window.confirm(
      `Registrar esta carpeta en Glyvex-AI-Suite?\n\n${dir}\n\n` +
        'Se agrega a sus directorios de modelos (permanente) y el modelo ' +
        'aparecerá en el Launcher de la Suite. Provisions no escribe sus ' +
        'archivos: usa su API pública.',
    )
    if (!ok) return
    setBusy('register')
    setSuiteMsg('')
    setError(null)
    try {
      const r = await registerSuiteFolder(dir)
      setSuiteMsg(
        `Registrado: ${r.new_models} modelo(s) nuevo(s) en la Suite ` +
          `(${r.model_dirs.length} carpeta(s) en total).`,
      )
      getSuiteStatus().then(setSuiteSt).catch(() => {})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const sessionActive =
    !!session &&
    (session.state === 'starting' ||
      session.state === 'verifying' ||
      session.state === 'ready')

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

  // U15: modelo elegido en el lanzador. Usa TODA la librería (no el filtro
  // de storage de la tabla) y solo archivos GGUF lanzables (sin mmproj/MTP).
  const selectedModel = (lib?.models ?? []).find(
    (m) => m.model_dir === launchModelDir,
  ) ?? null
  const launchFiles = (selectedModel?.files ?? []).filter(
    (f) =>
      f.ext === '.gguf' &&
      !f.label.startsWith('mmproj') &&
      !f.label.startsWith('MTP'),
  )
  // U16: visión — mmproj disponibles del modelo elegido (de la librería)
  const mmprojFiles = (selectedModel?.files ?? []).filter(
    (f) => f.label.toLowerCase().includes('mmproj'),
  )
  const mmprojValue =
    mmprojSel === 'manual' ? mmprojManual.trim() : mmprojSel

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
            {/* Isotopo Glyvex Provisions (2026-11-02): "descarga en bandeja" — mismo glyph que
                assets/brand/app-icon.svg, recortado al trazo (sin tile) para el lockup del header. */}
            <svg viewBox="176 180 672 672" width="24" height="24" role="img" aria-label="Glyvex Provisions">
              <defs>
                <linearGradient id="logoGrad" x1="208" y1="190" x2="816" y2="842" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#0d9488" />
                  <stop offset="50%" stopColor="#06b6d4" />
                  <stop offset="100%" stopColor="#8b5cf6" />
                </linearGradient>
              </defs>
              <path d="M250 560 V735 Q250 800 315 800 H709 Q774 800 774 735 V560" fill="none" stroke="url(#logoGrad)" strokeWidth="84" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M472 190 H552 V420 H640 L512 585 L384 420 H472 Z" fill="url(#logoGrad)" />
              <circle cx="512" cy="452" r="44" fill="#f97316" />
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

      {/* U13: banner de auto-update (solo aparece si el feed firmado publicó
          una versión nueva; discreto, con opción a posponerlo). */}
      {update && !updateDismissed && (
        <div className={updateState === 'error' ? 'banner update is-error' : 'banner update'}>
          {updateState === 'available' && (
            <>
              <span className="banner-text">
                Glyvex Provisions <strong>{update.version}</strong> está disponible. Puedes
                actualizar sin salir de la app.
              </span>
              <span className="banner-actions">
                <button className="primary" onClick={() => void installUpdate()}>
                  Actualizar y reiniciar
                </button>
                <button className="mini" onClick={() => setUpdateDismissed(true)}>
                  Más tarde
                </button>
              </span>
            </>
          )}
          {updateState === 'downloading' && (
            <span className="banner-text">
              Descargando la actualización…
              {updateProgress >= 0 ? ` ${updateProgress}%` : ''}
            </span>
          )}
          {updateState === 'error' && (
            <>
              <span className="banner-text">La actualización no se pudo completar: {updateError}</span>
              <span className="banner-actions">
                <button className="mini" onClick={() => setUpdateState('available')}>
                  Reintentar
                </button>
              </span>
            </>
          )}
        </div>
      )}

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

      {/* Ajustes persistentes (U6-3): semáforo + margen + contexto */}
      <section className="panel settings">
        <h2>Ajustes (semáforo y contexto)</h2>
        <div className="row profilebar">
          <span className="muted">
            Umbrales del semáforo de la tabla de archivos y margen para buffers
            de cómputo. El contexto (4k/8k/32k) define la KV cache que la
            estimación v2 suma en archivos GGUF (metadatos reales leídos de la
            cabecera del modelo); sin metadatos útiles (difusión, mmproj,
            arquitecturas raras) degrada a tamaño × margen. Se aplican de
            inmediato a la tabla abierta.
          </span>
        </div>
        <div className="row addprofile">
          <label className="dest">
            Verde ≤ %
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={adjOk}
              onChange={(e) => setAdjOk(e.target.value)}
            />
          </label>
          <label className="dest">
            Naranja ≤ %
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={adjTight}
              onChange={(e) => setAdjTight(e.target.value)}
            />
          </label>
          <label className="dest">
            Margen %
            <input
              type="number"
              min={0}
              max={50}
              step={0.5}
              value={adjMargin}
              onChange={(e) => setAdjMargin(e.target.value)}
            />
          </label>
          <label className="dest">
            Contexto:
            <select
              name="adjcontext"
              value={adjContext}
              onChange={(e) => setAdjContext(e.target.value)}
            >
              <option value="4096">4k</option>
              <option value="8192">8k</option>
              <option value="32768">32k</option>
            </select>
          </label>
          <button
            className="primary"
            disabled={busy === 'settings'}
            onClick={doSaveSettings}
          >
            {busy === 'settings' ? 'Guardando…' : 'Guardar ajustes'}
          </button>
        </div>
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

      {/* Lanzador de modelos (U15 — ecosistema Glyvex) */}
      <section className="panel launcher">
        <h2>Lanzador de modelos</h2>
        <div className="muted small">
          Verificación de modelos locales: carga, primer token, tok/s y VRAM
          real (comando mínimo a propósito: si falla, la causa es «no cabe»,
          no un flag). Con Glyvex-AI-Suite abierta podés registrar la carpeta
          del modelo; sin ella, el server queda corriendo en su puerto
          (servers R10). Opciones avanzadas y presets: acá y en la Suite (U16).
        </div>

        {/* Engines (cascada) */}
        <div className="muted small" style={{ marginTop: 8 }}>
          Engine (cascada auto: Suite → binario propio → Ollama)
        </div>
        <div className="engines-list">
          {engines?.engines.engines.map((e) => (
            <span
              key={e.id}
              className={`eng ${e.ok ? 'on' : 'off'}`}
              title={e.accel_warning ?? e.detail ?? e.path ?? e.version ?? e.id}
            >
              <span className="dot" />
              {e.label}
              {e.version ? ` · ${e.version}` : ''}
              {/* U16: backend de aceleración (CUDA/Vulkan/ROCm/SYCL/CPU) */}
              {e.accel ? ` · ${e.accel}` : ''}
              {e.accel_warning ? ' ⚠' : ''}
            </span>
          ))}
          {engines && engines.engines.available.length === 0 && (
            <span className="eng off" style={{ borderStyle: 'dashed' }}>
              sin engines disponibles
            </span>
          )}
        </div>
        <div className="row addprofile">
          <label className="dest" style={{ flex: 1 }}>
            Binario llama-server propio (opcional):
            <input
              name="userbin"
              className="st-path"
              value={userBin}
              onChange={(e) => setUserBin(e.target.value)}
              placeholder="C:\llama.cpp\build\bin\llama-server.exe"
            />
          </label>
          <button onClick={doSaveUserBinary} disabled={busy === 'engines'}>
            {busy === 'engines' ? 'Guardando…' : 'Guardar engine'}
          </button>
        </div>

        {/* U16: presets (cómo lanzar, no qué modelo) */}
        <div className="muted small" style={{ marginTop: 8 }}>
          Presets de lanzamiento (engine, régimen, ctx, mmproj y args — el
          modelo se elige abajo)
        </div>
        {presets.length > 0 && (
          <div className="engines-list">
            {presets.map((p) => (
              <span
                key={p.id}
                className={`eng ${presetEditId === p.id ? 'on' : 'off'}`}
                title={`ctx ${p.context} · ${p.engine} · ${p.regime}${
                  p.port ? ` · puerto ${p.port}` : ''
                }${p.mmproj ? ' · mmproj' : ''}${p.extra_args ? ` · ${p.extra_args}` : ''}`}
              >
                <span className="dot" />
                {p.name}
                <button className="chip tiny" onClick={() => doApplyPreset(p)}>
                  Usar
                </button>
                <button
                  className="chip tiny"
                  onClick={() => {
                    setPresetEditId(p.id)
                    setPresetName(p.name)
                    setPresetScenario(p.scenario)
                  }}
                >
                  Editar
                </button>
                <button
                  className="chip tiny"
                  onClick={() => doDeletePreset(p)}
                  title="Borrar"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="row addprofile">
          <label className="dest" style={{ flex: 1 }}>
            {presetEditId ? 'Editar preset (con el formulario actual):' : 'Nuevo preset (guarda el formulario actual):'}
            <input
              name="presetname"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="p. ej. Visión 8k GPU"
            />
          </label>
          {(['chat', 'vision', 'offload'] as PresetScenario[]).map((sc) => (
            <button
              key={sc}
              className={presetScenario === sc ? 'chip active' : 'chip'}
              onClick={() => setPresetScenario(sc)}
            >
              {sc}
            </button>
          ))}
          <button
            onClick={doSavePreset}
            disabled={busy === 'preset' || !presetName.trim()}
          >
            {presetEditId
              ? 'Actualizar preset'
              : busy === 'preset'
                ? 'Guardando…'
                : 'Guardar preset'}
          </button>
          {presetEditId && (
            <button
              onClick={() => {
                setPresetEditId('')
                setPresetName('')
              }}
            >
              Cancelar
            </button>
          )}
        </div>

        {/* Modelo + parámetros + acción */}
        <div className="row addprofile">
          <label className="dest">
            Modelo:
            <select
              name="launchmodel"
              value={launchModelDir}
              onChange={(e) => {
                setLaunchModelDir(e.target.value)
                setLaunchFile('')
                setLaunchPath('')
                setMmprojSel('')
                setMmprojManual('')
              }}
            >
              <option value="">—</option>
              {(lib?.models ?? []).map((m) => (
                <option key={m.model_dir} value={m.model_dir}>
                  {m.name} ({m.storage_name})
                </option>
              ))}
            </select>
          </label>
          <label className="dest">
            Archivo:
            <select
              name="launchfile"
              value={launchFile}
              onChange={(e) => {
                setLaunchFile(e.target.value)
                setLaunchPath('')
              }}
              disabled={!selectedModel}
            >
              <option value="">—</option>
              {launchFiles.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.label} · {fmtBytes(f.size)}
                </option>
              ))}
            </select>
          </label>
          <label className="dest">
            Engine:
            <select
              name="launchengine"
              value={launchEngine}
              onChange={(e) => setLaunchEngine(e.target.value)}
            >
              <option value="auto">auto (cascada)</option>
              {engines?.engines.available.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          </label>
        </div>
        {/* U16: visión + puerto + args avanzados (free-form) */}
        <div className="row addprofile">
          <label className="dest">
            mmproj (visión):
            <select
              name="launchmmproj"
              value={mmprojSel}
              onChange={(e) => setMmprojSel(e.target.value)}
            >
              <option value="">— (sin mmproj)</option>
              {mmprojFiles.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.label}
                </option>
              ))}
              <option value="manual">Ruta manual…</option>
            </select>
          </label>
          <label className="dest">
            Puerto (auto si vacío):
            <input
              name="launchport"
              value={launchPort}
              onChange={(e) => setLaunchPort(e.target.value)}
              placeholder="8080"
              style={{ width: 70 }}
            />
          </label>
          {mmprojSel === 'manual' && (
            <label className="dest" style={{ flex: 1 }}>
              Ruta del mmproj:
              <input
                name="mmprojmanual"
                className="st-path"
                value={mmprojManual}
                onChange={(e) => setMmprojManual(e.target.value)}
                placeholder="G:\LLM\gguf\modelo\mmproj-BF16.gguf"
              />
            </label>
          )}
        </div>
        <div className="row addprofile">
          <label className="dest" style={{ flex: 1 }}>
            Args extra (free-form, se agregan al comando tal cual):
            <input
              name="launchextra"
              className="st-path mono"
              value={launchExtra}
              onChange={(e) => setLaunchExtra(e.target.value)}
              placeholder="--flash-attn on --jinja"
            />
          </label>
        </div>

        {/* Modelo + parámetros + acción */}
        <div className="row addprofile">
          <label className="dest" style={{ flex: 1 }}>
            …o ruta manual (prevalece sobre la librería):
            <input
              name="launchpath"
              className="st-path"
              value={launchPath}
              onChange={(e) => setLaunchPath(e.target.value)}
              placeholder="D:\modelos\mi-modelo.gguf"
            />
          </label>
          <span className="muted small">
            {REGIME_LABELS[regime]} · {activeProfile?.name ?? 'Esta máquina (auto)'} ·
            ctx {adjContext}
          </span>
          <button
            className="primary"
            onClick={doLaunch}
            disabled={busy === 'launch' || sessionActive}
          >
            {busy === 'launch' ? 'Lanzando…' : 'Lanzar y verificar'}
          </button>
          <button onClick={doStop} disabled={busy === 'stop' || !sessionActive}>
            {busy === 'stop' ? 'Deteniendo…' : 'Detener'}
          </button>
        </div>

        {/* U16: preview del comando (extra_args se ve tal cual) */}
        <div className="muted small mono" style={{ marginTop: 4, wordBreak: 'break-all' }}>
          {launchEngine === 'ollama' ? (
            <>
              $ ollama create prov-&lt;hash&gt; — Modelfile: FROM &lt;modelo&gt; +
              num_ctx {adjContext} (keep_alive -1)
            </>
          ) : (
            <>
              $ llama-server -m &lt;modelo&gt; -c {adjContext} -ngl{' '}
              {regime === 'cpu' ? '0' : regime === 'offload' ? 'auto (VRAM)' : '999'}{' '}
              --host 127.0.0.1 --port {launchPort.trim() || '8080+'}
              {regime === 'multi' ? ' --tensor-split &lt;pesos por VRAM&gt;' : ''}
              {mmprojValue ? ` --mmproj ${mmprojValue}` : ''}
              {launchExtra.trim() ? ` ${launchExtra.trim()}` : ''}
            </>
          )}
        </div>

        {/* Sesión activa */}
        {session && (
          <div className="session">
            <div className={`state ${session.state}`}>
              <span className="dot" />
              {SESSION_STATE_LABELS[session.state]}
            </div>
            <div className="meta">
              <span>{session.id}</span>
              <span>{session.engine_label || session.engine}</span>
              <span>puerto {session.port}</span>
              <span>ctx {session.n_ctx}</span>
              <span>-ngl {session.ngl}</span>
              {session.mmproj && <span>visión (mmproj)</span>}
              {session.extra_args && <span title={session.extra_args}>args extra</span>}
              {session.uptime_s > 0 && <span>{session.uptime_s} s</span>}
            </div>
            {session.ngl_detail && (
              <div className="muted small">{session.ngl_detail}</div>
            )}
            {session.metrics && session.state === 'ready' && (
              <div className="metrics">
                {session.metrics.ttfb_ms != null && (
                  <span className="metric">
                    <span className="k">Primer token</span>{' '}
                    <span className="v">{session.metrics.ttfb_ms} ms</span>
                  </span>
                )}
                {session.metrics.tok_s != null && (
                  <span className="metric">
                    <span className="k">Velocidad</span>{' '}
                    <span className="v">{session.metrics.tok_s} tok/s</span>
                  </span>
                )}
                {session.metrics.vram.map((v) => (
                  <span className="metric" key={v.name}>
                    <span className="k">{v.name}</span>{' '}
                    <span className="v">
                      {v.free_gb}/{v.total_gb} GB libres
                    </span>
                  </span>
                ))}
              </div>
            )}
            {session.error && (
              <div style={{ color: 'var(--no)', fontSize: '0.85rem', marginTop: 6, wordBreak: 'break-all' }}>
                {session.error}
              </div>
            )}
            {session.state === 'ready' && (
              <div className="muted small">
                El server queda corriendo en 127.0.0.1:{session.port} (sobrevive
                al cierre de la GUI; se detiene con «Detener» o al cerrar la app).
              </div>
            )}
            {sessionLog.length > 0 && (
              <pre className="logbox">{sessionLog.slice(-80).join('\n')}</pre>
            )}
          </div>
        )}

        {/* Suite (ecosistema) */}
        <div className="row addprofile" style={{ marginTop: 12 }}>
          <span className="muted">
            Glyvex-AI-Suite:{' '}
            {suiteSt
              ? suiteSt.running
                ? `abierta (v${suiteSt.version ?? '?'}) en 127.0.0.1:${suiteSt.port}${
                    suiteSt.managed_runtime
                      ? ` · runtime gestionado ${suiteSt.managed_runtime.pin}`
                      : ' · sin runtime gestionado'
                  }`
                : 'no abierta'
              : '…'}
          </span>
          {suiteSt?.running ? (
            <button
              onClick={doRegisterSuite}
              disabled={busy === 'register' || !selectedModel}
              title={selectedModel
                ? `Registrar ${selectedModel.model_dir}`
                : 'Primero elegí un modelo de la librería'}
            >
              {busy === 'register' ? 'Registrando…' : 'Registrar en la Suite'}
            </button>
          ) : (
            <button disabled title="Abrí Glyvex-AI-Suite para habilitar el registro">
              Registrar en la Suite
            </button>
          )}
          <button
            onClick={() =>
              window.open(`http://127.0.0.1:${suiteSt?.port ?? 7981}`, '_blank')
            }
          >
            Abrir Suite
          </button>
        </div>
        {suiteMsg && (
          <div className="muted small" style={{ color: 'var(--ok)' }}>
            {suiteMsg}
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
                <th>Estima (margen + KV GGUF)</th>
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
                  <td className="num muted">
                    {fmtBytes(r.needed_bytes)}
                    {r.fit_version === 2 && (
                      <span
                        className="chip tiny"
                        title={`estimación v2: pesos + KV cache real (${fmtBytes(
                          r.kv_bytes ?? 0,
                        )}) para el contexto elegido; detalle en el semáforo`}
                      >
                        v2·GGUF
                      </span>
                    )}
                  </td>
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
