// Cliente del backend de Glyvex Provisions (FastAPI en 127.0.0.1:8321, vía proxy Vite).
// Solo se usa contra localhost; sin telemetría.

export type Regime = 'gpu' | 'offload' | 'cpu'
export type FitStatus = 'ok' | 'tight' | 'no' | 'na'

export interface Gpu {
  index: number
  name: string
  vram_total_bytes: number
  vram_free_bytes: number
  driver: string
}

export interface Hardware {
  gpus: Gpu[]
  ram_total_bytes: number
  ram_available_bytes: number
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
}

export interface Profile {
  id: string
  name: string
  kind: 'auto' | 'manual'
  gpus: ProfileGpu[]
  ram_gb: number
  note: string | null
}

export interface ProfileIn {
  name: string
  gpus: ProfileGpu[]
  ram_gb: number
  note?: string | null
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

export interface JobEvent {
  type: 'start' | 'progress' | 'log' | 'done' | 'error'
  path?: string
  done?: number
  total?: number
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
