// Cliente del backend de Glyvex Provisions (FastAPI en 127.0.0.1:8321, vía proxy Vite).
// Solo se usa contra localhost; sin telemetría.

export type Regime = 'gpu' | 'offload' | 'cpu'
export type FitStatus = 'ok' | 'tight' | 'no' | 'na'

export interface Gpu {
  index: number
  name: string
  vendor: 'nvidia' | 'amd' | 'intel' | 'other'
  vram_total_bytes: number
  vram_free_bytes: number
  driver: string | null
  shared_memory?: boolean
  vram_source?: 'nvidia-smi' | 'wmi' | 'catalog' | null
}

export interface Cpu {
  name: string | null
  vendor: string | null
  cores: number
  logical: number
  base_mhz: number | null
  socket: string | null
}

export interface RamModule {
  size_bytes: number
  speed_mhz: number | null
  mem_type: string | null
  manufacturer: string | null
  part_number: string | null
}

export interface Hardware {
  gpus: Gpu[]
  cpu: Cpu | null
  ram_total_bytes: number
  ram_available_bytes: number
  ram_modules: RamModule[]
  cpu_cores: number
  disk_free_bytes: number
  disk_total_bytes: number
  downloads_dir: string
}

export interface ModelHit {
  id: string
  likes: number
  downloads: number
  pipeline_tag: string | null
}

export interface FileRow {
  path: string
  label: string
  size: number
  needed_bytes: number
  capacity_bytes: number
  ratio: number | null
  status: FitStatus
  detail?: string
}

export interface Group {
  kind: string
  name: string
  files: string[]
}

export interface RepoData {
  repo_id: string
  rows: FileRow[]
  groups: Group[]
  hardware: Hardware
  profile?: { id: string; name: string }
}

// Perfiles de hardware (R10): "local" (auto) + manuales (GPU + RAM declaradas)
export interface ProfileGpu {
  name: string
  vram_gb: number
  vendor?: string | null
}

export interface ProfileCpu {
  vendor?: string | null
  model?: string | null
  threads?: number | null
}

export interface Profile {
  id: string
  name: string
  kind: 'auto' | 'manual'
  gpus: ProfileGpu[]
  ram_gb: number
  note: string | null
  // Adición 4d (opcionales: perfiles viejos no los traen)
  cpu?: ProfileCpu | null
  ram_type?: string | null
  ram_speed_mhz?: number | null
}

export interface ProfileIn {
  name: string
  gpus: ProfileGpu[]
  ram_gb: number
  note?: string | null
  cpu?: ProfileCpu | null
  ram_type?: string | null
  ram_speed_mhz?: number | null
}

// Catálogo de hardware (adición 4d): modelos representativos por vendor +
// VRAM mapeada por GPU + velocidades de RAM por tipo.
export interface CatalogCpu {
  model: string
  cores: number
  threads: number
  base_ghz: number
  boost_ghz: number
}

export interface CatalogGpu {
  model: string
  vram_gb: number
}

export interface Catalog {
  cpus: Record<string, CatalogCpu[]>
  gpus: Record<string, CatalogGpu[]>
  ram: Record<string, number[]>
}

// Storage multi-path (R11) + librería local (R9)
export interface Storage {
  id: string
  name: string
  path: string
  note: string | null
}

export interface StorageIn {
  name: string
  path: string
  note?: string | null
}

export interface LibFile {
  path: string
  size: number
  ext: string
  label: string
}

export interface LibModel {
  storage_id: string
  storage_name: string
  model_dir: string
  name: string
  files: LibFile[]
  total_bytes: number
  quants: string[]
}

export interface LibraryData {
  models: LibModel[]
  scanned_storages: number
  scanned_dirs: number
  files: number
  errors: number
  truncated: boolean
}

// Paquetes de modelos por escenario (R12): manifiestos .json en
// <storage>\packajes\ (texto plano, portables entre servers).
export interface PackageFile {
  repo_id: string
  file?: string | null     // archivo exacto (XOR con pattern)
  pattern?: string | null  // glob, p. ej. "*Q4_K_M.gguf"
}

export interface Package {
  id: string
  name: string
  scenario: string | null
  profile: string | null
  files: PackageFile[]
  error: string | null  // manifiesto inválido (se muestra, no se descarga)
}

export interface PackageIn {
  name: string
  scenario?: string | null
  profile?: string | null
  files: PackageFile[]
}

export interface PackageJob {
  id: string
  repo_id: string
  files: number
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    try {
      const body = await r.json()
      if (body.detail) msg = body.detail
    } catch {
      /* sin cuerpo JSON */
    }
    throw new Error(msg)
  }
  return r.json()
}

export const getHardware = () =>
  fetch('/api/hardware').then((r) => json<Hardware>(r))

export const getCatalog = () =>
  fetch('/api/catalog').then((r) => json<Catalog>(r))

export const searchModels = (query: string, limit = 20) =>
  fetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit }),
  }).then((r) => json<{ models: ModelHit[] }>(r))

export const getRepo = (repoId: string, regime: Regime, profileId?: string) =>
  fetch(
    `/api/repo/files?repo_id=${encodeURIComponent(repoId)}&regime=${regime}` +
      (profileId ? `&profile=${encodeURIComponent(profileId)}` : ''),
  ).then((r) => json<RepoData>(r))

export const listProfiles = () =>
  fetch('/api/profiles').then((r) => json<{ profiles: Profile[] }>(r))

export const addProfile = (body: ProfileIn) =>
  fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => json<Profile>(r))

export const updateProfile = (id: string, body: ProfileIn) =>
  fetch(`/api/profiles/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => json<Profile>(r))

export const deleteProfile = (id: string) =>
  fetch(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(
    (r) => json<{ ok: boolean }>(r),
  )

export const listStorages = () =>
  fetch('/api/storage').then((r) => json<{ storages: Storage[] }>(r))

export const addStorage = (body: StorageIn) =>
  fetch('/api/storage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => json<Storage>(r))

export const updateStorage = (id: string, body: StorageIn) =>
  fetch(`/api/storage/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => json<Storage>(r))

export const deleteStorage = (id: string) =>
  fetch(`/api/storage/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(
    (r) => json<{ ok: boolean }>(r),
  )

export const getLibrary = (storageId?: string) =>
  fetch(
    '/api/library' +
      (storageId ? `?storage_id=${encodeURIComponent(storageId)}` : ''),
  ).then((r) => json<LibraryData>(r))

export const listPackages = (storageId: string) =>
  fetch(`/api/storage/${encodeURIComponent(storageId)}/packages`).then(
    (r) => json<{ packages: Package[] }>(r),
  )

export const addPackage = (storageId: string, body: PackageIn) =>
  fetch(`/api/storage/${encodeURIComponent(storageId)}/packages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => json<Package>(r))

export const deletePackage = (storageId: string, packageId: string) =>
  fetch(
    `/api/storage/${encodeURIComponent(storageId)}/packages/${encodeURIComponent(packageId)}`,
    { method: 'DELETE' },
  ).then((r) => json<{ ok: boolean }>(r))

export const downloadPackage = (storageId: string, packageId: string) =>
  fetch(
    `/api/storage/${encodeURIComponent(storageId)}/packages/${encodeURIComponent(packageId)}/download`,
    { method: 'POST' },
  ).then((r) => json<{ jobs: PackageJob[]; dest: string }>(r))

export const submitDownload = (repoId: string, files: string[], dest?: string) =>
  fetch('/api/downloads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo_id: repoId, files, dest: dest || undefined }),
  }).then((r) => json<{ id: string }>(r))

export const listDownloads = () =>
  fetch('/api/downloads').then((r) =>
    json<{ jobs: { id: string; repo_id: string; status: string; files: number; error: string | null }[] }>(r),
  )

export const pauseDownload = (jobId: string) =>
  fetch(`/api/downloads/${jobId}/pause`, { method: 'POST' }).then((r) =>
    json<{ id: string; status: string }>(r),
  )

export const resumeDownload = (jobId: string) =>
  fetch(`/api/downloads/${jobId}/resume`, { method: 'POST' }).then((r) =>
    json<{ id: string; status: string }>(r),
  )

export const retryDownload = (jobId: string) =>
  fetch(`/api/downloads/${jobId}/retry`, { method: 'POST' }).then((r) =>
    json<{ id: string; status: string }>(r),
  )

export interface JobEvent {
  type: 'start' | 'progress' | 'log' | 'file_done' | 'paused' | 'done' | 'error'
  path?: string
  done?: number
  total?: number
  index?: number // file_done: archivos completados hasta este evento (1..count)
  count?: number // file_done: total de archivos del job
  msg?: string
  error?: string
  dest?: string
  files?: string[]
}

// SSE de un job. OJO: la cola del job se consume una sola vez, así que solo
// debe haber UN EventSource por job (lo garantiza eventsRef en App.tsx).
export function openJobEvents(
  jobId: string,
  onEvent: (ev: JobEvent) => void,
): EventSource {
  const es = new EventSource(`/api/downloads/${jobId}/events`)
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data))
    } catch {
      /* línea keepalive u otros */
    }
  }
  return es
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(2)} TB`
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${Math.round(n / 1024)} KB`
}
