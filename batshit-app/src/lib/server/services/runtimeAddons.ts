import { getCloudflaredRuntimeStatus } from '$lib/server/services/cloudflaredRuntime'
import {
  DOCKER_FBX2VRMA_WORKER_INSTALL_HELP,
  DOCKER_FBX2VRMA_WORKER_MISSING_REASON,
  buildFbx2VrmaWorkerManifest,
  getFbx2VrmaDockerWorkerStatus
} from '$lib/server/services/fbx2vrmaWorker'

export const RUNTIME_ADDON_IDS = [
  'cloudflared',
  'fbx2vrma',
  'audio2face',
  'comfyui-validation',
  'comfyui',
  'local-ai',
  'voice-engines',
  'livekit',
  'agent-browser'
] as const

export type RuntimeAddonId = (typeof RUNTIME_ADDON_IDS)[number]
export type RuntimeAddonRoute = 'sidecar/profile' | 'connect-existing' | 'host-controller/operator' | 'deferred'
export type RuntimeAddonState = 'running' | 'waiting' | 'unavailable' | 'not-applicable'

export type RuntimeAddonCatalogEntry = {
  id: RuntimeAddonId
  title: string
  description: string
  route: RuntimeAddonRoute
  composeProfile: string
  services: string[]
  startCommand: string
  internalUrl: string | null
  browserUrl: string | null
  backupBoundary: string
  controllerRequiredForAutoStart: boolean
}

export type RuntimeAddonStatus = RuntimeAddonCatalogEntry & {
  state: RuntimeAddonState
  running: boolean
  supported: boolean
  dockerUnsupported: boolean
  reason: string | null
  installHelp: string
  observedAt: string
  details: Record<string, any>
}

export type RuntimeAddonOperatorStatus = {
  configured: boolean
  available: boolean
  url: string | null
  reason: string | null
  checkedAt: string
  controls: Array<'start' | 'stop'>
  details?: Record<string, any>
}

export type RuntimeAddonPrepareResult = RuntimeAddonStatus & {
  canStartAutomatically: boolean
  requiresOperator: boolean
  operatorCommand: string
  operator: RuntimeAddonOperatorStatus
  nextSteps: string[]
}

export type RuntimeAddonOperation = 'start' | 'stop'

export type RuntimeAddonOperationResult = {
  success: boolean
  operation: RuntimeAddonOperation
  addonId: RuntimeAddonId
  operator: RuntimeAddonOperatorStatus
  before: RuntimeAddonStatus
  after: RuntimeAddonStatus | null
  alreadySatisfied: boolean
  output?: string
  error?: string
  details?: Record<string, any>
}

const RUNTIME_ADDON_CATALOG: RuntimeAddonCatalogEntry[] = [
  {
    id: 'cloudflared',
    title: 'Cloudflared Clip Tunnel',
    description: 'Optional Docker sidecar that gives local Clip URLs a public trycloudflare URL.',
    route: 'sidecar/profile',
    composeProfile: 'cloudflared',
    services: ['cloudflared'],
    startCommand: 'docker compose --env-file .env.docker --profile cloudflared up -d --build',
    internalUrl: 'http://batshit-server:5600',
    browserUrl: null,
    backupBoundary:
      'Runtime status/logs live in the Docker runtime-state volume. Tunnel URLs are ephemeral and are not included in Batshit app backups.',
    controllerRequiredForAutoStart: true
  },
  {
    id: 'fbx2vrma',
    title: 'FBX-to-VRMA Worker',
    description: 'Optional Docker worker that converts Goon Motion Vault .fbx uploads to .vrma.',
    route: 'sidecar/profile',
    composeProfile: 'fbx2vrma',
    services: ['fbx2vrma-worker'],
    startCommand:
      'docker compose --env-file .env.docker --profile fbx2vrma up -d --build fbx2vrma-worker',
    internalUrl: 'http://fbx2vrma-worker:8079',
    browserUrl: null,
    backupBoundary:
      'The worker keeps only temporary conversion files in its Docker volume. Converted VRMA uploads are normal Batshit uploads and are covered by Batshit backup/restore.',
    controllerRequiredForAutoStart: true
  },
  {
    id: 'audio2face',
    title: 'NVIDIA Audio2Face Bridge',
    description:
      'Optional Batshit bridge for a separately installed and licensed NVIDIA Audio2Face-3D NIM v2.0 runtime.',
    route: 'sidecar/profile',
    composeProfile: 'audio2face',
    services: ['audio2face-bridge'],
    startCommand:
      'docker compose --env-file .env.docker --profile audio2face up -d --build audio2face-bridge',
    internalUrl: 'http://audio2face-bridge:8068',
    browserUrl: null,
    backupBoundary:
      'Batshit keeps completed-utterance animation cache entries in a dedicated Docker volume. NVIDIA NIM images, model caches, licenses, GPU runtime state, and TLS credentials remain external and are not included in Batshit backup/restore.',
    controllerRequiredForAutoStart: true
  },
  {
    id: 'comfyui-validation',
    title: 'ComfyUI Validation Sidecar',
    description:
      'Optional Docker sidecar that validates ComfyUI-style artifact URL/proxy/upload/history behavior.',
    route: 'sidecar/profile',
    composeProfile: 'comfyui-validation',
    services: ['comfyui-validation'],
    startCommand:
      'docker compose --env-file .env.docker --profile comfyui-validation up -d --build comfyui-validation',
    internalUrl: 'http://comfyui:8188',
    browserUrl: 'http://localhost:${BATSHIT_DOCKER_COMFYUI_VALIDATION_PORT:-8188}',
    backupBoundary:
      'Validation-sidecar state lives in the Docker comfyui-validation volume. It is runtime fixture data, not part of Batshit app backup/restore.',
    controllerRequiredForAutoStart: true
  },
  {
    id: 'comfyui',
    title: 'ComfyUI / Gradio Artifact Runtime',
    description:
      'Connect-existing route for real ComfyUI, Gradio, Hugging Face-style, or webhook artifact runtimes that run outside the core app container.',
    route: 'connect-existing',
    composeProfile: '',
    services: [],
    startCommand:
      'Run the artifact runtime as an external service or approved sidecar, then configure the artifact with the URL reachable from the Docker app container.',
    internalUrl: null,
    browserUrl: null,
    backupBoundary:
      'External artifact runtime models, uploads, outputs, and service state are outside Batshit app backup/restore unless a specific Batshit-owned sidecar says otherwise.',
    controllerRequiredForAutoStart: false
  },
  {
    id: 'local-ai',
    title: 'Local AI Runtime',
    description:
      'Connect-existing route for Ollama, Docker Model Runner, LM Studio, llama.cpp, vLLM, or a similar OpenAI-compatible local model server.',
    route: 'connect-existing',
    composeProfile: '',
    services: [],
    startCommand:
      'Start or connect your Local AI runtime, then configure it in Settings -> Local AI. Host services should use host.docker.internal from the Docker app container; same-Compose sidecars should use their service name.',
    internalUrl: null,
    browserUrl: null,
    backupBoundary:
      'Batshit backs up the saved runtime URL/settings, but model weights, model caches, and runtime process state stay external.',
    controllerRequiredForAutoStart: false
  },
  {
    id: 'voice-engines',
    title: 'TTS/STT Voice Engines',
    description:
      'Connect-existing route for BYO TTS/STT engines and local voice services. Docker Batshit does not launch host-style voice processes from the core app container.',
    route: 'connect-existing',
    composeProfile: '',
    services: [],
    startCommand:
      'Run the voice engine as an external service or approved sidecar, then register it in Voice Settings with health/synthesis/transcription URLs reachable from the Docker app container.',
    internalUrl: null,
    browserUrl: null,
    backupBoundary:
      'Voice engine registry settings can be backed up by Batshit, but engine installs, model files, cloned voices, and runtime logs stay in the external runtime unless a specific sidecar owns them.',
    controllerRequiredForAutoStart: false
  },
  {
    id: 'livekit',
    title: 'LiveKit Voice Runtime',
    description:
      'Optional Docker voice runtime with a self-hosted LiveKit server plus Batshit LiveKit agent worker.',
    route: 'sidecar/profile',
    composeProfile: 'livekit',
    services: ['livekit', 'livekit-agent'],
    startCommand:
      'docker compose --env-file .env.docker --profile livekit up -d --build livekit livekit-agent',
    internalUrl: 'ws://host.docker.internal:7880',
    browserUrl: 'ws://localhost:7880',
    backupBoundary:
      'LiveKit rooms and worker state are runtime-only. Batshit backups can preserve saved LiveKit connection settings, but not live rooms, TURN/TLS state, or sidecar process state.',
    controllerRequiredForAutoStart: true
  },
  {
    id: 'agent-browser',
    title: 'Agent Browser Runtime',
    description:
      'Optional Docker sidecar that runs the pinned Agent Browser CLI with a local headless browser.',
    route: 'sidecar/profile',
    composeProfile: 'agent-browser',
    services: ['agent-browser'],
    startCommand:
      'docker compose --env-file .env.docker --profile agent-browser up -d --build agent-browser',
    internalUrl: 'http://agent-browser:8091',
    browserUrl: null,
    backupBoundary:
      'Agent Browser sidecar browser profiles/cache live in Docker volumes. Batshit uploads any model-visible screenshot artifacts through normal upload storage.',
    controllerRequiredForAutoStart: true
  }
]

const DEFAULT_OPERATOR_TIMEOUT_MS = 180_000
const OPERATION_SETTLE_TIMEOUT_MS = 15_000
const OPERATION_SETTLE_INTERVAL_MS = 500
const DEFAULT_AGENT_BROWSER_SIDECAR_URL = 'http://agent-browser:8091'
const DEFAULT_AUDIO2FACE_BRIDGE_URL = 'http://audio2face-bridge:8068'
const DEFAULT_LIVEKIT_BROWSER_URL = 'ws://localhost:7880'
const DEFAULT_LIVEKIT_INTERNAL_URL = 'ws://host.docker.internal:7880'
const DEFAULT_LIVEKIT_AGENT_HEALTH_URL = 'http://livekit-agent:7899/worker'

function isBatshitContainerizedRuntime() {
  return (
    process.env.BATSHIT_CONTAINERIZED === '1' ||
    process.env.BATSHIT_RUNTIME_ENV === 'docker'
  )
}

function normalizeOperatorUrl(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

function resolveOperatorTimeoutMs() {
  const raw = Number(process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 1_000 ? raw : DEFAULT_OPERATOR_TIMEOUT_MS
}

function resolveOperatorConfig() {
  const rawUrl =
    process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_URL?.trim() ||
    process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_URL?.trim()
  const url = normalizeOperatorUrl(rawUrl)
  const token =
    process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN?.trim() ||
    process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN?.trim() ||
    null
  const checkedAt = new Date().toISOString()

  if (!url && !rawUrl?.trim()) {
    return {
      ok: false as const,
      status: {
        configured: false,
        available: false,
        url: null,
        reason: 'Runtime add-on operator is not configured.',
        checkedAt,
        controls: []
      } satisfies RuntimeAddonOperatorStatus
    }
  }

  if (!url) {
    return {
      ok: false as const,
      status: {
        configured: true,
        available: false,
        url: null,
        reason: 'BATSHIT_RUNTIME_ADDON_OPERATOR_URL must be an http(s) URL.',
        checkedAt,
        controls: []
      } satisfies RuntimeAddonOperatorStatus
    }
  }

  if (!token) {
    return {
      ok: false as const,
      status: {
        configured: true,
        available: false,
        url,
        reason: 'BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN is required when the runtime add-on operator is configured.',
        checkedAt,
        controls: []
      } satisfies RuntimeAddonOperatorStatus
    }
  }

  return {
    ok: true as const,
    url,
    token,
    timeoutMs: resolveOperatorTimeoutMs()
  }
}

async function fetchOperatorJson(path: string, init: RequestInit = {}) {
  const config = resolveOperatorConfig()
  if (!config.ok) {
    return {
      ok: false as const,
      status: config.status,
      payload: null,
      statusCode: 0
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const response = await fetch(`${config.url}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {})
      },
      signal: controller.signal
    })
    const payload = (await response.json().catch(() => null)) as Record<string, any> | null
    const checkedAt = new Date().toISOString()
    return {
      ok: response.ok as boolean,
      status: {
        configured: true,
        available: response.ok && payload?.ok !== false,
        url: config.url,
        reason: response.ok
          ? null
          : typeof payload?.error === 'string'
            ? payload.error
            : `Runtime add-on operator returned ${response.status}.`,
        checkedAt,
        controls: Array.isArray(payload?.controls)
          ? payload.controls.filter((entry: unknown): entry is 'start' | 'stop' => entry === 'start' || entry === 'stop')
          : ['start', 'stop'],
        details: payload ?? undefined
      } satisfies RuntimeAddonOperatorStatus,
      payload,
      statusCode: response.status
    }
  } catch (error) {
    const checkedAt = new Date().toISOString()
    return {
      ok: false as const,
      status: {
        configured: true,
        available: false,
        url: config.url,
        reason:
          error instanceof Error
            ? `Runtime add-on operator is unreachable: ${error.message}`
            : 'Runtime add-on operator is unreachable.',
        checkedAt,
        controls: []
      } satisfies RuntimeAddonOperatorStatus,
      payload: null,
      statusCode: 0
    }
  } finally {
    clearTimeout(timeout)
  }
}

function cloneEntry(entry: RuntimeAddonCatalogEntry): RuntimeAddonCatalogEntry {
  return {
    ...entry,
    services: [...entry.services]
  }
}

export function listRuntimeAddonCatalog(): RuntimeAddonCatalogEntry[] {
  return RUNTIME_ADDON_CATALOG.map((entry) => cloneEntry(entry))
}

export function getRuntimeAddonCatalogEntry(addonId: string): RuntimeAddonCatalogEntry | null {
  const normalized = addonId.trim().toLowerCase()
  const entry = RUNTIME_ADDON_CATALOG.find((candidate) => candidate.id === normalized)
  return entry ? cloneEntry(entry) : null
}

function normalizeCloudflaredStatus(
  entry: RuntimeAddonCatalogEntry,
  status: Awaited<ReturnType<typeof getCloudflaredRuntimeStatus>>
): RuntimeAddonStatus {
  const containerized = isBatshitContainerizedRuntime()
  const sidecarRoute = containerized && status.supportLevel === 'docker-sidecar'
  const running = sidecarRoute && status.tunnel.running === true
  return {
    ...cloneEntry(entry),
    state: running ? 'running' : sidecarRoute ? 'waiting' : containerized ? 'unavailable' : 'not-applicable',
    running,
    supported: sidecarRoute,
    dockerUnsupported: containerized && !sidecarRoute,
    reason: running
      ? null
      : status.reason || 'Cloudflared is not running as an optional Docker sidecar.',
    installHelp: status.installHelp || entry.startCommand,
    observedAt: new Date().toISOString(),
    details: {
      supportLevel: status.supportLevel,
      installScope: status.installScope,
      version: status.version,
      command: status.command,
      dockerSidecar: status.dockerSidecar,
      tunnel: status.tunnel
    }
  }
}

async function getCloudflaredAddonStatus(entry: RuntimeAddonCatalogEntry): Promise<RuntimeAddonStatus> {
  const status = await getCloudflaredRuntimeStatus()
  return normalizeCloudflaredStatus(entry, status)
}

async function getFbx2VrmaAddonStatus(entry: RuntimeAddonCatalogEntry): Promise<RuntimeAddonStatus> {
  const worker = await getFbx2VrmaDockerWorkerStatus()
  const running = isBatshitContainerizedRuntime() && worker.running
  return {
    ...cloneEntry(entry),
    state: running ? 'running' : isBatshitContainerizedRuntime() ? 'waiting' : 'not-applicable',
    running,
    supported: running,
    dockerUnsupported: isBatshitContainerizedRuntime() && !running,
    reason: running ? null : DOCKER_FBX2VRMA_WORKER_MISSING_REASON,
    installHelp: DOCKER_FBX2VRMA_WORKER_INSTALL_HELP,
    observedAt: worker.checkedAt,
    details: {
      supportLevel: running ? 'docker-worker' : 'docker-worker-missing',
      worker,
      manifest: running ? buildFbx2VrmaWorkerManifest(worker.health) : null
    }
  }
}

function resolveAudio2FaceBridgeUrl(entry: RuntimeAddonCatalogEntry) {
  return process.env.BATSHIT_AUDIO2FACE_BRIDGE_URL?.trim() || entry.internalUrl || DEFAULT_AUDIO2FACE_BRIDGE_URL
}

async function getAudio2FaceAddonStatus(entry: RuntimeAddonCatalogEntry): Promise<RuntimeAddonStatus> {
  const checkedAt = new Date().toISOString()
  const url = resolveAudio2FaceBridgeUrl(entry)
  const token = process.env.BATSHIT_AUDIO2FACE_BRIDGE_TOKEN?.trim()

  if (!isBatshitContainerizedRuntime()) {
    return {
      ...cloneEntry(entry),
      state: 'not-applicable',
      running: false,
      supported: false,
      dockerUnsupported: false,
      reason: 'Audio2Face bridge add-on status applies to the Docker Compose runtime.',
      installHelp: entry.startCommand,
      observedAt: checkedAt,
      details: { supportLevel: 'docker-sidecar-not-applicable', url }
    }
  }

  if (!token) {
    return {
      ...cloneEntry(entry),
      state: 'waiting',
      running: false,
      supported: true,
      dockerUnsupported: false,
      reason: 'BATSHIT_AUDIO2FACE_BRIDGE_TOKEN is required for the Audio2Face bridge boundary.',
      installHelp: entry.startCommand,
      observedAt: checkedAt,
      details: { supportLevel: 'docker-sidecar-missing-token', url }
    }
  }

  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`
      }
    })
    const payload = (await response.json().catch(() => null)) as Record<string, any> | null
    const bridgeRunning = response.ok && payload?.bridgeRunning === true
    const running = bridgeRunning && payload?.nimReady === true && payload?.ok === true
    return {
      ...cloneEntry(entry),
      state: running ? 'running' : 'waiting',
      running,
      supported: true,
      dockerUnsupported: false,
      reason: running
        ? null
        : typeof payload?.reason === 'string'
          ? payload.reason
          : bridgeRunning
            ? 'Audio2Face bridge is running, but NVIDIA NIM is not ready.'
            : `Audio2Face bridge returned HTTP ${response.status}.`,
      installHelp: entry.startCommand,
      observedAt: checkedAt,
      details: {
        supportLevel: running ? 'docker-sidecar' : 'docker-sidecar-waiting',
        url,
        bridgeRunning,
        nimReady: payload?.nimReady === true,
        version: typeof payload?.version === 'string' ? payload.version : null,
        protocol: typeof payload?.protocol === 'string' ? payload.protocol : null,
        outputFps: typeof payload?.outputFps === 'number' ? payload.outputFps : null,
        cacheSchema: typeof payload?.cacheSchema === 'string' ? payload.cacheSchema : null
      }
    }
  } catch (error) {
    return {
      ...cloneEntry(entry),
      state: 'waiting',
      running: false,
      supported: true,
      dockerUnsupported: false,
      reason:
        error instanceof Error
          ? `Audio2Face bridge is not reachable: ${error.message}`
          : 'Audio2Face bridge is not reachable.',
      installHelp: entry.startCommand,
      observedAt: checkedAt,
      details: { supportLevel: 'docker-sidecar-missing', url, bridgeRunning: false, nimReady: false }
    }
  }
}

function resolveAgentBrowserSidecarUrl(entry: RuntimeAddonCatalogEntry) {
  const configured = process.env.BATSHIT_AGENT_BROWSER_SIDECAR_URL?.trim()
  return configured || entry.internalUrl || DEFAULT_AGENT_BROWSER_SIDECAR_URL
}

function normalizeHttpHealthUrl(value: string): string {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
    parsed.pathname = '/'
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return value
  }
}

function resolveLiveKitBrowserUrl(entry: RuntimeAddonCatalogEntry) {
  return process.env.LIVEKIT_URL?.trim() || process.env.LIVEKIT_WS_URL?.trim() || entry.browserUrl || DEFAULT_LIVEKIT_BROWSER_URL
}

function resolveLiveKitInternalUrl(entry: RuntimeAddonCatalogEntry) {
  return (
    process.env.LIVEKIT_INTERNAL_URL?.trim() ||
    process.env.LIVEKIT_SERVER_INTERNAL_URL?.trim() ||
    entry.internalUrl ||
    DEFAULT_LIVEKIT_INTERNAL_URL
  )
}

function resolveLiveKitAgentHealthUrl() {
  return process.env.LIVEKIT_AGENT_HEALTH_URL?.trim() || DEFAULT_LIVEKIT_AGENT_HEALTH_URL
}

async function fetchLiveKitServerStatus(url: string): Promise<{
  ready: boolean
  statusHint: string
  url: string
}> {
  const healthUrl = normalizeHttpHealthUrl(url)
  try {
    const response = await fetch(healthUrl, {
      headers: { accept: 'text/plain,application/json' }
    })
    return {
      ready: response.ok,
      statusHint: response.ok
        ? `LiveKit server is reachable at ${healthUrl}.`
        : `LiveKit server returned HTTP ${response.status} at ${healthUrl}.`,
      url: healthUrl
    }
  } catch (error) {
    return {
      ready: false,
      statusHint:
        error instanceof Error
          ? `LiveKit server is not reachable at ${healthUrl}: ${error.message}`
          : `LiveKit server is not reachable at ${healthUrl}.`,
      url: healthUrl
    }
  }
}

async function fetchLiveKitAgentStatus(url: string): Promise<{
  ready: boolean
  statusHint: string
  url: string
  agentName: string | null
  activeJobs: number | null
}> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' }
    })
    const payload = (await response.json().catch(() => null)) as Record<string, any> | null
    const agentName =
      typeof payload?.agent_name === 'string'
        ? payload.agent_name
        : typeof payload?.agentName === 'string'
          ? payload.agentName
          : null
    const activeJobs =
      typeof payload?.active_jobs === 'number'
        ? payload.active_jobs
        : typeof payload?.activeJobs === 'number'
          ? payload.activeJobs
          : null
    const ready = response.ok && Boolean(agentName)
    return {
      ready,
      statusHint: ready
        ? `LiveKit agent worker is registered as ${agentName}.`
        : response.ok
          ? 'LiveKit agent worker health check did not report an agent name.'
          : `LiveKit agent worker returned HTTP ${response.status}.`,
      url,
      agentName,
      activeJobs
    }
  } catch (error) {
    return {
      ready: false,
      statusHint:
        error instanceof Error
          ? `LiveKit agent worker is not reachable at ${url}: ${error.message}`
          : `LiveKit agent worker is not reachable at ${url}.`,
      url,
      agentName: null,
      activeJobs: null
    }
  }
}

async function getLiveKitAddonStatus(entry: RuntimeAddonCatalogEntry): Promise<RuntimeAddonStatus> {
  const checkedAt = new Date().toISOString()
  const browserUrl = resolveLiveKitBrowserUrl(entry)
  const internalUrl = resolveLiveKitInternalUrl(entry)
  const agentHealthUrl = resolveLiveKitAgentHealthUrl()

  if (!isBatshitContainerizedRuntime()) {
    return {
      ...cloneEntry(entry),
      state: 'not-applicable',
      running: false,
      supported: false,
      dockerUnsupported: false,
      reason: 'LiveKit Docker sidecar status applies to the Docker Compose runtime.',
      installHelp: entry.startCommand,
      observedAt: checkedAt,
      details: {
        supportLevel: 'docker-sidecar-not-applicable',
        browserUrl,
        internalUrl,
        agentHealthUrl
      }
    }
  }

  const [server, agent] = await Promise.all([
    fetchLiveKitServerStatus(internalUrl),
    fetchLiveKitAgentStatus(agentHealthUrl)
  ])
  const running = server.ready && agent.ready
  const missingHints = [server, agent]
    .filter((status) => !status.ready)
    .map((status) => status.statusHint)

  return {
    ...cloneEntry(entry),
    state: running ? 'running' : 'waiting',
    running,
    supported: true,
    dockerUnsupported: false,
    reason: running ? null : missingHints.join(' '),
    installHelp: entry.startCommand,
    observedAt: checkedAt,
    details: {
      supportLevel: running ? 'docker-sidecar' : 'docker-sidecar-missing',
      browserUrl,
      internalUrl,
      agentHealthUrl,
      server,
      agent
    }
  }
}

async function getAgentBrowserAddonStatus(entry: RuntimeAddonCatalogEntry): Promise<RuntimeAddonStatus> {
  const checkedAt = new Date().toISOString()
  const url = resolveAgentBrowserSidecarUrl(entry)

  if (!isBatshitContainerizedRuntime()) {
    return {
      ...cloneEntry(entry),
      state: 'not-applicable',
      running: false,
      supported: false,
      dockerUnsupported: false,
      reason: 'Agent Browser sidecar status applies to the Docker Compose runtime.',
      installHelp: entry.startCommand,
      observedAt: checkedAt,
      details: {
        supportLevel: 'docker-sidecar-not-applicable',
        url
      }
    }
  }

  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      headers: { accept: 'application/json' }
    })
    const payload = (await response.json().catch(() => null)) as Record<string, any> | null
    const running = response.ok && payload?.ok !== false
    return {
      ...cloneEntry(entry),
      state: running ? 'running' : 'waiting',
      running,
      supported: true,
      dockerUnsupported: false,
      reason: running
        ? null
        : `Agent Browser sidecar returned HTTP ${response.status}.`,
      installHelp: entry.startCommand,
      observedAt: checkedAt,
      details: {
        supportLevel: running ? 'docker-sidecar' : 'docker-sidecar-missing',
        url,
        version: typeof payload?.version === 'string' ? payload.version : null,
        service: payload?.service ?? null
      }
    }
  } catch (error) {
    return {
      ...cloneEntry(entry),
      state: 'waiting',
      running: false,
      supported: true,
      dockerUnsupported: false,
      reason:
        error instanceof Error
          ? `Agent Browser sidecar is not reachable: ${error.message}`
          : 'Agent Browser sidecar is not reachable.',
      installHelp: entry.startCommand,
      observedAt: checkedAt,
      details: {
        supportLevel: 'docker-sidecar-missing',
        url
      }
    }
  }
}

function resolveComfyUiValidationUrl(entry: RuntimeAddonCatalogEntry) {
  const configured = process.env.BATSHIT_COMFYUI_VALIDATION_URL?.trim()
  return configured || entry.internalUrl || 'http://comfyui:8188'
}

async function getComfyUiValidationAddonStatus(entry: RuntimeAddonCatalogEntry): Promise<RuntimeAddonStatus> {
  const checkedAt = new Date().toISOString()
  const url = resolveComfyUiValidationUrl(entry)

  if (!isBatshitContainerizedRuntime()) {
    return {
      ...cloneEntry(entry),
      state: 'not-applicable',
      running: false,
      supported: false,
      dockerUnsupported: false,
      reason: 'ComfyUI validation sidecar status applies to the Docker Compose runtime.',
      installHelp: entry.startCommand,
      observedAt: checkedAt,
      details: {
        supportLevel: 'docker-sidecar-not-applicable',
        url
      }
    }
  }

  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/system_stats`, {
      headers: { accept: 'application/json' }
    })
    const payload = (await response.json().catch(() => null)) as Record<string, any> | null
    const running = response.ok
    return {
      ...cloneEntry(entry),
      state: running ? 'running' : 'waiting',
      running,
      supported: running,
      dockerUnsupported: !running,
      reason: running
        ? null
        : `ComfyUI validation sidecar returned HTTP ${response.status}.`,
      installHelp: entry.startCommand,
      observedAt: checkedAt,
      details: {
        supportLevel: running ? 'docker-sidecar' : 'docker-sidecar-missing',
        url,
        systemStats: payload
      }
    }
  } catch (error) {
    return {
      ...cloneEntry(entry),
      state: 'waiting',
      running: false,
      supported: false,
      dockerUnsupported: true,
      reason:
        error instanceof Error
          ? `ComfyUI validation sidecar is not reachable: ${error.message}`
          : 'ComfyUI validation sidecar is not reachable.',
      installHelp: entry.startCommand,
      observedAt: checkedAt,
      details: {
        supportLevel: 'docker-sidecar-missing',
        url
      }
    }
  }
}

function getCatalogOnlyAddonStatus(entry: RuntimeAddonCatalogEntry): RuntimeAddonStatus {
  const checkedAt = new Date().toISOString()
  const containerized = isBatshitContainerizedRuntime()
  const deferred = entry.route === 'deferred'

  return {
    ...cloneEntry(entry),
    state: !containerized ? 'not-applicable' : deferred ? 'unavailable' : 'waiting',
    running: false,
    supported: false,
    dockerUnsupported: containerized,
    reason: !containerized
      ? `${entry.title} Docker add-on status applies to the Docker Compose runtime.`
      : deferred
        ? entry.startCommand
        : `${entry.title} uses a connect-existing route. Configure a reachable external service or approved sidecar, then validate the feature-specific health path.`,
    installHelp: entry.startCommand,
    observedAt: checkedAt,
    details: {
      supportLevel: deferred ? 'docker-deferred' : 'connect-existing',
      route: entry.route
    }
  }
}

export async function getRuntimeAddonStatus(addonId: string): Promise<RuntimeAddonStatus | null> {
  const entry = getRuntimeAddonCatalogEntry(addonId)
  if (!entry) return null

  if (entry.id === 'cloudflared') return await getCloudflaredAddonStatus(entry)
  if (entry.id === 'fbx2vrma') return await getFbx2VrmaAddonStatus(entry)
  if (entry.id === 'audio2face') return await getAudio2FaceAddonStatus(entry)
  if (entry.id === 'agent-browser') return await getAgentBrowserAddonStatus(entry)
  if (entry.id === 'comfyui-validation') return await getComfyUiValidationAddonStatus(entry)
  if (entry.id === 'livekit') return await getLiveKitAddonStatus(entry)
  return getCatalogOnlyAddonStatus(entry)
}

export async function listRuntimeAddons(options: {
  includeStatus?: boolean
} = {}): Promise<Array<RuntimeAddonCatalogEntry | RuntimeAddonStatus>> {
  if (!options.includeStatus) return listRuntimeAddonCatalog()
  return await Promise.all(
    RUNTIME_ADDON_CATALOG.map(async (entry) => (await getRuntimeAddonStatus(entry.id)) ?? cloneEntry(entry))
  )
}

export async function getRuntimeAddonOperatorStatus(): Promise<RuntimeAddonOperatorStatus> {
  const result = await fetchOperatorJson('/health')
  return result.status
}

export async function prepareRuntimeAddon(addonId: string): Promise<RuntimeAddonPrepareResult | null> {
  const status = await getRuntimeAddonStatus(addonId)
  if (!status) return null
  const operator = await getRuntimeAddonOperatorStatus()
  const operatorStartSupported = status.controllerRequiredForAutoStart === true
  const canStartAutomatically = operatorStartSupported && operator.available && !status.running
  const requiresOperator = operatorStartSupported && !status.running

  let nextSteps: string[]
  if (status.running) {
    nextSteps = [
      `${status.title} is already running.`,
      'Keep using the existing sidecar unless you intentionally change .env.docker or compose profiles.'
    ]
  } else if (status.route === 'connect-existing') {
    nextSteps = [
      'Run or connect the runtime outside the core app container, then save the reachable URL/credentials in the matching Batshit settings area.',
      'Use host.docker.internal for host services called by the app container, or a Compose service name for sidecars on the same Compose network.',
      'Re-check the feature-specific health/status path before claiming the runtime is ready.'
    ]
  } else if (status.route === 'deferred') {
    nextSteps = [
      `${status.title} is intentionally deferred in Docker.`,
      'Do not install host-style binaries inside the core app container or invent ad hoc Docker commands.',
      'Use a documented connect-existing path only if one exists for the specific runtime.'
    ]
  } else if (canStartAutomatically) {
    nextSteps = [
      'Call the approved runtime_addon_start action for this add-on.',
      'After it starts, re-check this add-on status from Batshit before claiming it is ready.',
      'Do not run arbitrary Docker or Compose commands from inside the core app container.'
    ]
  } else {
    nextSteps = [
      'Ask the user/operator to run the approved Compose command from the folder containing compose.yaml and .env.docker.',
      'After it starts, re-check this add-on status from Batshit before claiming it is ready.',
      'Do not run arbitrary Docker or Compose commands from inside the core app container.'
    ]
  }

  return {
    ...status,
    canStartAutomatically,
    requiresOperator,
    operatorCommand: status.startCommand,
    operator,
    nextSteps
  }
}

export async function controlRuntimeAddon(
  addonId: string,
  operation: RuntimeAddonOperation
): Promise<RuntimeAddonOperationResult | null> {
  const before = await getRuntimeAddonStatus(addonId)
  if (!before) return null

  const alreadySatisfied =
    (operation === 'start' && before.running) || (operation === 'stop' && !before.running)
  const operator = await getRuntimeAddonOperatorStatus()
  const operatorStartSupported = before.controllerRequiredForAutoStart === true

  if (alreadySatisfied) {
    return {
      success: true,
      operation,
      addonId: before.id,
      operator,
      before,
      after: before,
      alreadySatisfied
    }
  }

  if (!operatorStartSupported) {
    return {
      success: false,
      operation,
      addonId: before.id,
      operator,
      before,
      after: null,
      alreadySatisfied: false,
      error:
        before.route === 'deferred'
          ? `${before.title} is deferred in Docker. ${before.startCommand}`
          : `${before.title} uses a connect-existing route. Batshit cannot ${operation} that external runtime from the core app container; use prepare for setup guidance.`
    }
  }

  if (!operator.available) {
    return {
      success: false,
      operation,
      addonId: before.id,
      operator,
      before,
      after: null,
      alreadySatisfied: false,
      error:
        operator.reason ||
        'Runtime add-on operator is unavailable. Prepare the add-on to get the manual Compose command.'
    }
  }

  const result = await fetchOperatorJson(`/v1/addons/${before.id}/${operation}`, {
    method: 'POST',
    body: JSON.stringify({
      addonId: before.id,
      operation
    })
  })
  const payload = result.payload ?? {}
  const operatorSucceeded = result.ok && payload?.ok !== false
  const after = operatorSucceeded
    ? await waitForRuntimeAddonOperation(before.id, operation)
    : await getRuntimeAddonStatus(before.id)
  const settled = after ? runtimeAddonOperationMatches(operation, after) : false
  const success = operatorSucceeded && settled

  return {
    success,
    operation,
    addonId: before.id,
    operator: result.status,
    before,
    after,
    alreadySatisfied: false,
    output: typeof payload?.output === 'string' ? payload.output : undefined,
    error: success
      ? undefined
      : typeof payload?.error === 'string'
        ? payload.error
        : operatorSucceeded
          ? `${before.title} did not ${operation === 'start' ? 'become ready' : 'stop'} within ${
              OPERATION_SETTLE_TIMEOUT_MS / 1000
            } seconds after the operator completed.`
          : result.status.reason || `Runtime add-on operator failed to ${operation} ${before.id}.`,
    details: payload
  }
}

function runtimeAddonOperationMatches(operation: RuntimeAddonOperation, status: RuntimeAddonStatus) {
  return operation === 'start' ? status.running === true : status.running === false
}

async function waitForRuntimeAddonOperation(
  addonId: RuntimeAddonId,
  operation: RuntimeAddonOperation
): Promise<RuntimeAddonStatus | null> {
  const deadline = Date.now() + OPERATION_SETTLE_TIMEOUT_MS
  let latest: RuntimeAddonStatus | null = null

  while (Date.now() <= deadline) {
    latest = await getRuntimeAddonStatus(addonId)
    if (!latest || runtimeAddonOperationMatches(operation, latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, OPERATION_SETTLE_INTERVAL_MS))
  }

  return latest
}

export async function startRuntimeAddon(addonId: string) {
  return await controlRuntimeAddon(addonId, 'start')
}

export async function stopRuntimeAddon(addonId: string) {
  return await controlRuntimeAddon(addonId, 'stop')
}
