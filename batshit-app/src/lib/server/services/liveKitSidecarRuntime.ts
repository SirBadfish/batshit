import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { env } from '$env/dynamic/private'
import { apiKeyService } from '$lib/services/apiKey.server'
import { redis } from '$lib/server/redis'
import { getConfiguredInternalToken } from '$lib/server/services/internalRequestAuth'
import {
  fetchLiveKitServerReady,
  getLocalLiveKitPort,
  getNativeLiveKitInstallStatus,
  inspectLocalLiveKitPortOwner,
  installNativeLiveKitRuntime,
  installLiveKitServerBinary,
  installLiveKitSidecarPackage,
  liveKitServerHttpUrl,
  resolveNativeLiveKitSidecarInstallRoot,
  startNativeLiveKitServerRuntime,
  type LiveKitNativeInstallResult
} from '$lib/server/services/liveKitNativeRuntimeInstaller'
import {
  DEFAULT_LIVEKIT_AGENT_NAME,
  resolveLiveKitVoiceRuntimeConfigForUser
} from '$lib/server/services/liveKitVoiceRuntime'
import { resolveLiveKitSidecarBatshitBaseUrl } from '$lib/server/services/liveKitSidecarUrls'
import {
  controlRuntimeAddon,
  getRuntimeAddonStatus,
  type RuntimeAddonStatus
} from '$lib/server/services/runtimeAddons'
import { startLocalVoiceRuntime } from '$lib/server/services/voiceLocalEngineSetup'
import { normalizeVoiceSettings } from '$lib/utils/voiceSchema'

export const LIVEKIT_SIDECAR_RUNTIME_ID = 'livekit' as const
const LIVEKIT_SIDECAR_ENGINE_ID = 'livekit-sidecar'
const DEFAULT_LIVEKIT_AGENT_PORT = 7899
const DEFAULT_LIVEKIT_SERVER_IMAGE = 'livekit/livekit-server:v1.13.5'
const DEFAULT_DOCKER_LIVEKIT_AGENT_HEALTH_URL = 'http://livekit-agent:7899/worker'
const START_READY_TIMEOUT_MS = 20_000
const START_READY_POLL_INTERVAL_MS = 750
const STOP_READY_TIMEOUT_MS = 5_000
const STOP_READY_POLL_INTERVAL_MS = 250
const DOCKER_LIVEKIT_ADDON_UNAVAILABLE_MESSAGE =
  'LiveKit runs as an optional Docker runtime add-on in Dockerized Batshit. Start the LiveKit add-on, or configure an external LiveKit URL plus API key/secret in Settings -> API Keys.'

const execFileAsync = promisify(execFile)

type LiveKitSidecarStatus =
  | 'ready'
  | 'not-installed'
  | 'not-configured'
  | 'unreachable'
  | 'starting'
  | 'error'

export type LiveKitSidecarRuntimeSummary = {
  id: typeof LIVEKIT_SIDECAR_RUNTIME_ID
  name: 'LiveKit'
  kind: 'voice-session-runtime'
  installed: boolean
  selected: boolean
  autoStartOnLaunch: boolean
  status: LiveKitSidecarStatus
  statusHint: string
  healthUrl: string
  agentName: string | null
  activeJobs?: number | null
  logPath?: string | null
  pid?: number | null
  server?: LiveKitLocalServerSummary
  updateAvailable?: boolean
  installedVersion?: string | null
  targetVersion?: string | null
}

export type LiveKitSidecarStartResult = LiveKitSidecarRuntimeSummary & {
  started: boolean
  alreadyRunning: boolean
  restarted?: boolean
}

export type LiveKitLocalServerSummary = {
  managed: boolean
  status: 'ready' | 'not-managed' | 'not-installed' | 'unreachable' | 'starting' | 'error'
  statusHint: string
  url: string | null
  containerName: string | null
  image: string | null
  installScope?: 'native-managed' | 'docker-sidecar' | 'external'
  version?: string | null
  binaryPath?: string | null
  logPath?: string | null
  pid?: number | null
  started?: boolean
  alreadyRunning?: boolean
  updateAvailable?: boolean
  targetVersion?: string | null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isContainerizedRuntime(): boolean {
  return process.env.BATSHIT_CONTAINERIZED === '1' || process.env.BATSHIT_RUNTIME_ENV === 'docker'
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseBooleanEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function parseOptionalBooleanEnv(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return null
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false
  }
  return null
}

function resolveAgentHealthPort(): number {
  const source = cleanString(env.LIVEKIT_AGENT_HEALTH_PORT) || cleanString(env.LIVEKIT_AGENT_PORT)
  const parsed = source ? Number.parseInt(source, 10) : DEFAULT_LIVEKIT_AGENT_PORT
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : DEFAULT_LIVEKIT_AGENT_PORT
}

function resolveSidecarInstallRoot(): string {
  const explicit = cleanString(env.LIVEKIT_AGENT_INSTALL_ROOT)
  if (explicit) return path.resolve(explicit)
  return resolveNativeLiveKitSidecarInstallRoot()
}

function resolveSidecarInstallOwnership(): 'batshit-managed' | 'user-managed' {
  return cleanString(env.LIVEKIT_AGENT_INSTALL_ROOT) ? 'user-managed' : 'batshit-managed'
}

function sidecarPackageInstalled(installRoot: string): boolean {
  return (
    existsSync(path.join(installRoot, 'package.json')) &&
    existsSync(path.join(installRoot, 'node_modules', '.bin', 'tsx'))
  )
}

function normalizeHealthPayload(value: unknown): {
  agentName: string | null
  activeJobs: number | null
} {
  const payload =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const agentName = cleanString(payload.agent_name ?? payload.agentName) || null
  const activeJobs =
    typeof payload.active_jobs === 'number'
      ? payload.active_jobs
      : typeof payload.activeJobs === 'number'
        ? payload.activeJobs
        : null
  return { agentName, activeJobs }
}

async function inspectLiveKitSidecarHealth(port = resolveAgentHealthPort()): Promise<{
  ready: boolean
  statusHint: string
  agentName: string | null
  activeJobs: number | null
}> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2_000)

  try {
    const response = await fetch(`http://127.0.0.1:${port}/worker`, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    })
    if (!response.ok) {
      return {
        ready: false,
        statusHint: `LiveKit sidecar health check returned HTTP ${response.status}.`,
        agentName: null,
        activeJobs: null
      }
    }

    const payload = await response.json().catch(() => null)
    const normalized = normalizeHealthPayload(payload)
    return {
      ready: Boolean(normalized.agentName),
      statusHint: normalized.agentName
        ? `Sidecar worker is ready as ${normalized.agentName}.`
        : 'LiveKit sidecar health check did not report an agent name.',
      ...normalized
    }
  } catch (error) {
    return {
      ready: false,
      statusHint: error instanceof Error ? error.message : 'LiveKit sidecar is not reachable.',
      agentName: null,
      activeJobs: null
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function findListenerPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('lsof', [
      '-nP',
      `-iTCP:${port}`,
      '-sTCP:LISTEN',
      '-t'
    ])
    return stdout
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value) && value > 0)
  } catch {
    return []
  }
}

async function waitForSidecarStopped(port: number): Promise<boolean> {
  const deadline = Date.now() + STOP_READY_TIMEOUT_MS
  let health = await inspectLiveKitSidecarHealth(port)
  while (health.ready && Date.now() < deadline) {
    await sleep(STOP_READY_POLL_INTERVAL_MS)
    health = await inspectLiveKitSidecarHealth(port)
  }
  return !health.ready
}

async function stopLiveKitSidecarOnPort(port: number): Promise<boolean> {
  const currentHealth = await inspectLiveKitSidecarHealth(port)
  if (!currentHealth.ready) return false

  const pids = await findListenerPids(port)
  if (!pids.length) {
    throw new Error(
      `LiveKit sidecar is running on port ${port}, but Batshit could not resolve its process id for restart.`
    )
  }

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? error.code : null
      if (code !== 'ESRCH') throw error
    }
  }

  if (await waitForSidecarStopped(port)) return true

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? error.code : null
      if (code !== 'ESRCH') throw error
    }
  }

  if (await waitForSidecarStopped(port)) return true
  throw new Error(`LiveKit sidecar on port ${port} did not stop before restart timeout.`)
}

async function getOpenAiApiKey(userId: string): Promise<string | null> {
  const fromEnv = cleanString(env.OPENAI_API_KEY)
  if (fromEnv) return fromEnv
  const saved = await apiKeyService.retrieve('openai', userId).catch(() => null)
  return cleanString(saved) || null
}

function getLocalLiveKitServerPort(serverUrl: string): number | null {
  return getLocalLiveKitPort(serverUrl)
}

export function isBatshitManagedLocalLiveKitServerConfig(config: {
  serverUrl: string
}): boolean {
  const explicit = parseOptionalBooleanEnv(
    cleanString(env.LIVEKIT_LOCAL_SERVER_AUTO_START) ||
      cleanString(env.LIVEKIT_SERVER_AUTO_START) ||
      undefined
  )
  if (explicit !== null) return explicit
  return getLocalLiveKitServerPort(config.serverUrl) !== null
}

function liveKitServerImageForDockerAddon(): string {
  return cleanString(env.LIVEKIT_SERVER_IMAGE) || DEFAULT_LIVEKIT_SERVER_IMAGE
}

async function inspectManagedLocalLiveKitServer(config: {
  userId: string
  serverUrl: string
  apiKey: string
  apiSecret: string
}): Promise<LiveKitLocalServerSummary> {
  const port = getLocalLiveKitServerPort(config.serverUrl)
  const managed = isBatshitManagedLocalLiveKitServerConfig(config)
  const nativeStatus = await getNativeLiveKitInstallStatus()
  if (!managed || !port) {
    return {
      managed: false,
      status: 'not-managed',
      statusHint: 'LiveKit server is externally managed.',
      url: null,
      containerName: null,
      image: null,
      installScope: 'external'
    }
  }

  const url = liveKitServerHttpUrl(config.serverUrl, port)
  const ready = await fetchLiveKitServerReady(url)
  const portOwner = ready ? await inspectLocalLiveKitPortOwner(port) : null
  if (ready && portOwner?.dockerOwned) {
    return {
      managed: true,
      status: 'error',
      statusHint: `Native LiveKit cannot use ${url} because port ${port} is owned by Docker (${portOwner.commands.join(', ') || 'docker process'}). Stop the Docker LiveKit container or change the saved LiveKit URL before starting the native runtime.`,
      url,
      containerName: null,
      image: null,
      installScope: 'native-managed',
      version: nativeStatus.serverVersion,
      targetVersion: nativeStatus.version,
      updateAvailable: nativeStatus.serverUpdateAvailable,
      binaryPath: nativeStatus.serverBinaryPath,
      pid: portOwner.pids[0] ?? null,
      alreadyRunning: false
    }
  }
  if (!nativeStatus.serverInstalled) {
    return {
      managed: true,
      status: ready ? 'ready' : 'not-installed',
      statusHint: ready
        ? `Local LiveKit server is reachable at ${url}. Native managed server is not installed, so this listener is externally owned.`
        : 'Native LiveKit server is not installed yet.',
      url,
      containerName: null,
      image: null,
      installScope: 'native-managed',
      version: nativeStatus.serverVersion,
      targetVersion: nativeStatus.version,
      updateAvailable: nativeStatus.serverUpdateAvailable,
      binaryPath: nativeStatus.serverBinaryPath,
      alreadyRunning: ready
    }
  }

  return {
    managed: true,
    status: ready ? 'ready' : 'unreachable',
    statusHint: ready
      ? `Local LiveKit server is reachable at ${url}.`
      : `Local LiveKit server is not reachable at ${url}.`,
    url,
    containerName: null,
    image: null,
    installScope: 'native-managed',
    version: nativeStatus.serverVersion,
    targetVersion: nativeStatus.version,
    updateAvailable: nativeStatus.serverUpdateAvailable,
    binaryPath: nativeStatus.serverBinaryPath,
    alreadyRunning: ready
  }
}

async function ensureManagedLocalLiveKitServer(config: {
  userId: string
  serverUrl: string
  apiKey: string
  apiSecret: string
  forceRestart?: boolean
}): Promise<LiveKitLocalServerSummary> {
  const inspected = await inspectManagedLocalLiveKitServer(config)
  if (!inspected.managed || (inspected.status === 'ready' && !config.forceRestart)) return inspected

  try {
    const started = await startNativeLiveKitServerRuntime({
      userId: config.userId,
      serverUrl: config.serverUrl,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      forceRestart: config.forceRestart
    })
    return {
      ...inspected,
      status: started.started || started.alreadyRunning ? 'ready' : 'error',
      statusHint: started.statusHint,
      started: started.started,
      alreadyRunning: started.alreadyRunning,
      pid: started.pid,
      logPath: started.logPath
    }
  } catch (error) {
    return {
      ...inspected,
      status: 'error',
      statusHint:
        error instanceof Error ? error.message : 'Failed to start the native LiveKit server.'
    }
  }
}

function appendServerHint(statusHint: string, server: LiveKitLocalServerSummary | null): string {
  if (!server || server.status === 'not-managed') return statusHint
  return `${statusHint} ${server.statusHint}`
}

function dockerLiveKitRuntimeSummaryFromAddon(
  addon: RuntimeAddonStatus | null,
  options: {
    statusOverride?: LiveKitSidecarStatus
    statusHintOverride?: string | null
    started?: boolean
    alreadyRunning?: boolean
    restarted?: boolean
  } = {}
): LiveKitSidecarStartResult {
  const details = addon?.details ?? {}
  const agent = details.agent && typeof details.agent === 'object' ? details.agent : {}
  const server = details.server && typeof details.server === 'object' ? details.server : {}
  const browserUrl =
    typeof details.browserUrl === 'string' && details.browserUrl.trim()
      ? details.browserUrl.trim()
      : cleanString(env.LIVEKIT_URL) || cleanString(env.LIVEKIT_WS_URL) || 'ws://localhost:7880'
  const healthUrl =
    typeof details.agentHealthUrl === 'string' && details.agentHealthUrl.trim()
      ? details.agentHealthUrl.trim()
      : cleanString(env.LIVEKIT_AGENT_HEALTH_URL) || DEFAULT_DOCKER_LIVEKIT_AGENT_HEALTH_URL
  const agentName =
    typeof agent.agentName === 'string' && agent.agentName.trim()
      ? agent.agentName.trim()
      : null
  const activeJobs =
    typeof agent.activeJobs === 'number'
      ? agent.activeJobs
      : typeof agent.active_jobs === 'number'
        ? agent.active_jobs
        : null
  const serverReady = server.ready === true || addon?.running === true
  const runtimeReady = addon?.running === true
  const status: LiveKitSidecarStatus =
    options.statusOverride ?? (runtimeReady ? 'ready' : addon ? 'unreachable' : 'not-configured')
  const statusHint =
    options.statusHintOverride ||
    (runtimeReady
      ? 'LiveKit Docker runtime add-on is ready.'
      : addon?.reason || DOCKER_LIVEKIT_ADDON_UNAVAILABLE_MESSAGE)

  return {
    id: LIVEKIT_SIDECAR_RUNTIME_ID,
    name: 'LiveKit',
    kind: 'voice-session-runtime',
    installed: true,
    selected: false,
    autoStartOnLaunch: false,
    status,
    statusHint,
    healthUrl,
    agentName,
    activeJobs,
    logPath: null,
    pid: null,
    server: {
      managed: true,
      status: serverReady ? 'ready' : 'unreachable',
      statusHint:
        typeof server.statusHint === 'string' && server.statusHint.trim()
          ? server.statusHint.trim()
          : serverReady
            ? `LiveKit server is reachable at ${browserUrl}.`
            : 'LiveKit server is not reachable.',
      url: browserUrl,
      containerName: 'livekit',
      image: liveKitServerImageForDockerAddon(),
      installScope: 'docker-sidecar',
      alreadyRunning: serverReady
    },
    started: options.started ?? false,
    alreadyRunning: options.alreadyRunning ?? runtimeReady,
    restarted: options.restarted
  }
}

async function resolveRuntimePreferences(userId: string): Promise<{
  selected: boolean
  autoStartOnLaunch: boolean
}> {
  const settings = await redis.getUserSettings(userId).catch(() => null)
  const normalized = normalizeVoiceSettings(settings?.voice_settings)
  return {
    selected: normalized.voiceSessionRuntime === 'livekit',
    autoStartOnLaunch:
      normalized.voiceRuntimes?.livekit?.startup?.autoStartOnLaunch === true ||
      parseBooleanEnv(env.LIVEKIT_AGENT_AUTO_START)
  }
}

export async function getLiveKitSidecarRuntimeSummary(
  userId: string
): Promise<LiveKitSidecarRuntimeSummary> {
  const installRoot = resolveSidecarInstallRoot()
  const installed = sidecarPackageInstalled(installRoot)
  const nativeStatus =
    !isContainerizedRuntime() && resolveSidecarInstallOwnership() === 'batshit-managed'
      ? await getNativeLiveKitInstallStatus()
      : null
  const versionStatus = nativeStatus
    ? {
        updateAvailable: nativeStatus.updateAvailable,
        installedVersion: nativeStatus.sidecarVersion,
        targetVersion: nativeStatus.targetSidecarVersion
      }
    : {}
  const port = resolveAgentHealthPort()
  const healthUrl = `http://127.0.0.1:${port}/worker`

  if (isContainerizedRuntime()) {
    const addon = await getRuntimeAddonStatus(LIVEKIT_SIDECAR_RUNTIME_ID)
    return dockerLiveKitRuntimeSummaryFromAddon(addon)
  }

  const preferences = await resolveRuntimePreferences(userId)

  if (!installed) {
    return {
      id: LIVEKIT_SIDECAR_RUNTIME_ID,
      name: 'LiveKit',
      kind: 'voice-session-runtime',
      installed,
      selected: preferences.selected,
      autoStartOnLaunch: preferences.autoStartOnLaunch,
      status: 'not-installed',
      statusHint: 'LiveKit sidecar package is not installed yet.',
      healthUrl,
      agentName: null,
      activeJobs: null,
      logPath: null,
      pid: null,
      ...versionStatus
    }
  }

  const health = await inspectLiveKitSidecarHealth(port)
  let server: LiveKitLocalServerSummary | null = null
  try {
    const liveKitConfig = await resolveLiveKitVoiceRuntimeConfigForUser(userId)
    server = await inspectManagedLocalLiveKitServer({ userId, ...liveKitConfig })
  } catch (error) {
    return {
      id: LIVEKIT_SIDECAR_RUNTIME_ID,
      name: 'LiveKit',
      kind: 'voice-session-runtime',
      installed,
      selected: preferences.selected,
      autoStartOnLaunch: preferences.autoStartOnLaunch,
      status: 'not-configured',
      statusHint: error instanceof Error ? error.message : 'LiveKit is not configured.',
      healthUrl,
      agentName: health.agentName,
      activeJobs: health.activeJobs,
      logPath: null,
      pid: null,
      ...versionStatus
    }
  }
  const pids = health.ready ? await findListenerPids(port) : []
  const serverBlocksRuntime = server?.managed === true && server.status !== 'ready'
  const status: LiveKitSidecarStatus = health.ready
    ? serverBlocksRuntime
      ? 'unreachable'
      : 'ready'
    : 'unreachable'
  return {
    id: LIVEKIT_SIDECAR_RUNTIME_ID,
    name: 'LiveKit',
    kind: 'voice-session-runtime',
    installed,
    selected: preferences.selected,
    autoStartOnLaunch: preferences.autoStartOnLaunch,
    status,
    statusHint: health.ready
      ? appendServerHint(
          `${health.statusHint} Use Restart after Batshit updates or LiveKit sidecar changes.`,
          server
        )
      : appendServerHint(health.statusHint, server),
    healthUrl,
    agentName: health.agentName,
    activeJobs: health.activeJobs,
    logPath: null,
    pid: pids[0] ?? null,
    server: server ?? undefined,
    ...versionStatus
  }
}

async function waitForSidecarReady(
  port: number
): Promise<Awaited<ReturnType<typeof inspectLiveKitSidecarHealth>>> {
  const deadline = Date.now() + START_READY_TIMEOUT_MS
  let health = await inspectLiveKitSidecarHealth(port)
  while (!health.ready && Date.now() < deadline) {
    await sleep(START_READY_POLL_INTERVAL_MS)
    health = await inspectLiveKitSidecarHealth(port)
  }
  return health
}

export async function startLiveKitSidecarRuntime(
  userId: string,
  options: { forceRestart?: boolean; forceServerRestart?: boolean } = {}
): Promise<LiveKitSidecarStartResult> {
  const installRoot = resolveSidecarInstallRoot()
  let installed = sidecarPackageInstalled(installRoot)
  const port = resolveAgentHealthPort()
  const healthUrl = `http://127.0.0.1:${port}/worker`

  if (isContainerizedRuntime()) {
    const before = await getRuntimeAddonStatus(LIVEKIT_SIDECAR_RUNTIME_ID)
    if (options.forceRestart && before?.running) {
      const stopped = await controlRuntimeAddon(LIVEKIT_SIDECAR_RUNTIME_ID, 'stop')
      if (!stopped?.success) {
        return dockerLiveKitRuntimeSummaryFromAddon(stopped?.after ?? before, {
          statusOverride: 'error',
          statusHintOverride: stopped?.error || 'Failed to stop the LiveKit Docker add-on.',
          restarted: true
        })
      }
    }

    const started = await controlRuntimeAddon(LIVEKIT_SIDECAR_RUNTIME_ID, 'start')
    const addon = started?.after ?? (await getRuntimeAddonStatus(LIVEKIT_SIDECAR_RUNTIME_ID))
    return dockerLiveKitRuntimeSummaryFromAddon(addon, {
      statusOverride: started?.success === false ? 'error' : undefined,
      statusHintOverride: started?.success === false ? started.error : null,
      started: started?.success === true && started.alreadySatisfied !== true,
      alreadyRunning: started?.alreadySatisfied === true || addon?.running === true,
      restarted: options.forceRestart
    })
  }

  const preferences = await resolveRuntimePreferences(userId)

  if (resolveSidecarInstallOwnership() === 'batshit-managed') {
    const nativeStatus = await getNativeLiveKitInstallStatus()
    if (!nativeStatus.sidecarInstalled || nativeStatus.sidecarUpdateAvailable) {
      await installLiveKitSidecarPackage()
      installed = true
    }
  }

  if (!installed) {
    return {
      id: LIVEKIT_SIDECAR_RUNTIME_ID,
      name: 'LiveKit',
      kind: 'voice-session-runtime',
      installed,
      selected: preferences.selected,
      autoStartOnLaunch: preferences.autoStartOnLaunch,
      status: 'not-installed',
      statusHint: 'LiveKit sidecar package is not installed yet.',
      healthUrl,
      agentName: null,
      activeJobs: null,
      logPath: null,
      pid: null,
      started: false,
      alreadyRunning: false
    }
  }

  let liveKitConfig
  try {
    liveKitConfig = await resolveLiveKitVoiceRuntimeConfigForUser(userId)
  } catch (error) {
    return {
      id: LIVEKIT_SIDECAR_RUNTIME_ID,
      name: 'LiveKit',
      kind: 'voice-session-runtime',
      installed,
      selected: preferences.selected,
      autoStartOnLaunch: preferences.autoStartOnLaunch,
      status: 'not-configured',
      statusHint: error instanceof Error ? error.message : 'LiveKit is not configured.',
      healthUrl,
      agentName: null,
      activeJobs: null,
      logPath: null,
      pid: null,
      started: false,
      alreadyRunning: false,
      restarted: options.forceRestart
    }
  }

  let forceServerRestart = options.forceServerRestart === true
  if (
    resolveSidecarInstallOwnership() === 'batshit-managed' &&
    isBatshitManagedLocalLiveKitServerConfig(liveKitConfig)
  ) {
    const nativeStatus = await getNativeLiveKitInstallStatus()
    if (!nativeStatus.serverInstalled || nativeStatus.serverUpdateAvailable) {
      const serverPort = getLocalLiveKitServerPort(liveKitConfig.serverUrl)
      const serverWasRunning = serverPort
        ? await fetchLiveKitServerReady(liveKitServerHttpUrl(liveKitConfig.serverUrl, serverPort))
        : false
      await installLiveKitServerBinary()
      forceServerRestart =
        forceServerRestart || (nativeStatus.serverUpdateAvailable && serverWasRunning)
    }
  }

  const currentHealth = await inspectLiveKitSidecarHealth(port)
  const server = await ensureManagedLocalLiveKitServer({
    userId,
    ...liveKitConfig,
    forceRestart: forceServerRestart
  })
  const serverBlocksRuntime = server.managed && server.status !== 'ready'
  if (serverBlocksRuntime) {
    return {
      id: LIVEKIT_SIDECAR_RUNTIME_ID,
      name: 'LiveKit',
      kind: 'voice-session-runtime',
      installed,
      selected: preferences.selected,
      autoStartOnLaunch: preferences.autoStartOnLaunch,
      status: 'error',
      statusHint: server.statusHint,
      healthUrl,
      agentName: liveKitConfig.agentName ?? DEFAULT_LIVEKIT_AGENT_NAME,
      activeJobs: null,
      logPath: null,
      pid: null,
      started: false,
      alreadyRunning: false,
      restarted: options.forceRestart,
      server
    }
  }

  if (currentHealth.ready) {
    if (options.forceRestart || server.started === true) {
      await stopLiveKitSidecarOnPort(port)
    } else {
      const pids = await findListenerPids(port)
      return {
        id: LIVEKIT_SIDECAR_RUNTIME_ID,
        name: 'LiveKit',
        kind: 'voice-session-runtime',
        installed,
        selected: preferences.selected,
        autoStartOnLaunch: preferences.autoStartOnLaunch,
        status: 'ready',
        statusHint: appendServerHint(
          `${currentHealth.statusHint} Use Restart after Batshit updates or LiveKit sidecar changes.`,
          server
        ),
        healthUrl,
        agentName: currentHealth.agentName,
        activeJobs: currentHealth.activeJobs,
        logPath: null,
        pid: pids[0] ?? null,
        started: false,
        alreadyRunning: true,
        server
      }
    }
  }

  const agentName = liveKitConfig.agentName ?? DEFAULT_LIVEKIT_AGENT_NAME
  const openAiKey = await getOpenAiApiKey(userId)
  const serviceToken = getConfiguredInternalToken()
  if (!serviceToken) {
    return {
      id: LIVEKIT_SIDECAR_RUNTIME_ID,
      name: 'LiveKit',
      kind: 'voice-session-runtime',
      installed,
      selected: preferences.selected,
      autoStartOnLaunch: preferences.autoStartOnLaunch,
      status: 'not-configured',
      statusHint:
        'BATSHIT_TOKEN or MCP_GATEWAY_AUTH_TOKEN is required for LiveKit bridge turn submission.',
      healthUrl,
      agentName,
      activeJobs: null,
      logPath: null,
      pid: null,
      started: false,
      alreadyRunning: false,
      restarted: options.forceRestart,
      server
    }
  }

  try {
    const started = await startLocalVoiceRuntime({
      userId,
      engineId: LIVEKIT_SIDECAR_ENGINE_ID,
      installRoot,
      installOwnership: resolveSidecarInstallOwnership(),
      launch: {
        command: process.execPath,
        args: ['node_modules/tsx/dist/cli.mjs', 'src/livekit-agent-sidecar.ts', 'start'],
        cwd: '.',
        env: {
          NODE_OPTIONS: '--no-warnings',
          NODE_NO_WARNINGS: '1',
          LIVEKIT_URL: liveKitConfig.serverUrl,
          LIVEKIT_API_KEY: liveKitConfig.apiKey,
          LIVEKIT_API_SECRET: liveKitConfig.apiSecret,
          LIVEKIT_VOICE_AGENT_NAME: agentName,
          LIVEKIT_AGENT_MODE: cleanString(env.LIVEKIT_AGENT_MODE) || 'batshit-bridge',
          LIVEKIT_AGENT_HEALTH_PORT: String(port),
          LIVEKIT_AGENT_BATSHIT_TOKEN: serviceToken,
          LIVEKIT_AGENT_BATSHIT_BASE_URL: resolveLiveKitSidecarBatshitBaseUrl(env),
          BATSHIT_FRONTEND_URL: resolveLiveKitSidecarBatshitBaseUrl(env),
          ...(openAiKey ? { OPENAI_API_KEY: openAiKey } : {})
        }
      }
    })

    const health = await waitForSidecarReady(port)
    return {
      id: LIVEKIT_SIDECAR_RUNTIME_ID,
      name: 'LiveKit',
      kind: 'voice-session-runtime',
      installed,
      selected: preferences.selected,
      autoStartOnLaunch: preferences.autoStartOnLaunch,
      status: health.ready ? 'ready' : 'error',
      statusHint: health.ready
        ? appendServerHint(health.statusHint, server)
        : appendServerHint(
            'Batshit launched the LiveKit sidecar, but it did not become ready before timeout.',
            server
          ),
      healthUrl,
      agentName: health.agentName ?? agentName,
      activeJobs: health.activeJobs,
      logPath: started.logPath,
      pid: started.pid,
      started: health.ready,
      alreadyRunning: false,
      restarted: options.forceRestart,
      server
    }
  } catch (error) {
    return {
      id: LIVEKIT_SIDECAR_RUNTIME_ID,
      name: 'LiveKit',
      kind: 'voice-session-runtime',
      installed,
      selected: preferences.selected,
      autoStartOnLaunch: preferences.autoStartOnLaunch,
      status: 'error',
      statusHint: error instanceof Error ? error.message : 'Failed to start LiveKit sidecar.',
      healthUrl,
      agentName,
      activeJobs: null,
      logPath: null,
      pid: null,
      started: false,
      alreadyRunning: false,
      restarted: options.forceRestart,
      server
    }
  }
}

export async function installLiveKitSidecarRuntime(userId: string): Promise<{
  install: LiveKitNativeInstallResult
  runtime: LiveKitSidecarStartResult
}> {
  const before = await getNativeLiveKitInstallStatus()
  const install = await installNativeLiveKitRuntime(userId)
  const runtime = await startLiveKitSidecarRuntime(userId, {
    forceRestart: true,
    forceServerRestart: before.serverUpdateAvailable
  })
  return { install, runtime }
}

export async function autoStartLiveKitSidecarRuntime(
  userId: string
): Promise<LiveKitSidecarStartResult | null> {
  const preferences = await resolveRuntimePreferences(userId)
  if (!preferences.autoStartOnLaunch) return null
  return startLiveKitSidecarRuntime(userId)
}
