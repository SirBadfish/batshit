import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { env } from '$env/dynamic/private'
import { apiKeyService } from '$lib/services/apiKey.server'
import { redis } from '$lib/server/redis'
import { getConfiguredInternalToken } from '$lib/server/services/internalRequestAuth'
import {
  LIVEKIT_NATIVE_SERVER_ENGINE_ID,
  fetchLiveKitServerReady,
  getLocalLiveKitPort,
  getNativeLiveKitInstallStatus,
  inspectLocalLiveKitPortOwner,
  installNativeLiveKitRuntime,
  installLiveKitServerBinary,
  installLiveKitSidecarPackage,
  liveKitServerHttpUrl,
  resolveNativeLiveKitServerInstallRoot,
  resolveNativeLiveKitSidecarInstallRoot,
  startNativeLiveKitServerRuntime,
  type LiveKitNativeInstallResult
} from '$lib/server/services/liveKitNativeRuntimeInstaller'
import {
  DEFAULT_LIVEKIT_AGENT_NAME,
  readLiveKitVoiceRuntimeConfigForUser,
  resolveLiveKitVoiceRuntimeConfigForUser
} from '$lib/server/services/liveKitVoiceRuntime'
import { resolveLiveKitSidecarBatshitBaseUrl } from '$lib/server/services/liveKitSidecarUrls'
import {
  controlRuntimeAddon,
  getRuntimeAddonStatus,
  type RuntimeAddonStatus
} from '$lib/server/services/runtimeAddons'
import { startLocalVoiceRuntime } from '$lib/server/services/voiceLocalEngineSetup'
import {
  isLocalRuntimeProcessAlive,
  listLocalRuntimeLaunchRecords,
  readRuntimeUseState,
  recordVerifiedRuntimeUse,
  resolveVoiceRuntimeRegistryIdentity,
  verifyOwnLaunchServes,
  type OwnLaunchCheck,
  setLocalRuntimeStopChoice,
  stopSolelyOwnedLaunchForRestart,
  type LocalRuntimeEngineRef,
  type SolelyOwnedRestartStop,
  type StoredLocalVoiceRuntimeLaunchRecord
} from '$lib/server/services/voiceRuntimeLaunchRecords'
import {
  normalizeVoiceSettings,
  shouldStopVoiceRuntimeOnShutdown
} from '$lib/utils/voiceSchema'

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

function sidecarRestartRefusal(result: Exclude<SolelyOwnedRestartStop, { stopped: true }>, port: number): string {
  switch (result.refusal) {
    case 'not-started':
      return `LiveKit sidecar is running on port ${port}, but Batshit did not start that process, so it did not restart it. Stop it yourself first.`
    case 'shared':
      return `Batshit did not restart the LiveKit sidecar on port ${port}: another Batshit on this computer, or another engine, also uses it (process ${result.pid}; ${result.recordPaths.join(', ')}). Restart it from the Batshit that started it, or once nothing else uses it.`
    case 'unreadable':
      return `Batshit did not restart the LiveKit sidecar on port ${port}: ${result.reasons.join('; ')}, and Batshit cannot tell whether that record names this sidecar. Repair or remove it, then try again.`
    case 'unverified':
      return `Batshit did not restart the LiveKit sidecar on port ${port}: ${result.reason}. Make sure nothing else uses that port, then try again.`
  }
}

/**
 * Send `signal` to the LiveKit sidecar launch on `port` only when this Batshit alone launched it
 * (`stopSolelyOwnedLaunchForRestart`). The listener can be a child of the launch, so the launch's
 * whole process group gets the signal. `sameAs`: only that very launch, checked afresh.
 */
async function signalOwnSidecarLaunch(
  port: number,
  listeners: number[],
  signal: NodeJS.Signals,
  sameAs?: StoredLocalVoiceRuntimeLaunchRecord
): Promise<StoredLocalVoiceRuntimeLaunchRecord> {
  const result = await stopSolelyOwnedLaunchForRestart(LIVEKIT_SIDECAR_ENGINE_ID, listeners, async (record) => {
    if (
      sameAs &&
      (record.recordPath !== sameAs.recordPath || record.pid !== sameAs.pid || record.launchedAt !== sameAs.launchedAt)
    ) {
      throw new Error(`The LiveKit sidecar on port ${port} changed while it was stopping, so Batshit did not force it to stop.`)
    }
    try {
      process.kill(-(record.pid as number), signal)
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? error.code : null
      if (code !== 'ESRCH') throw error
    }
  })
  if (!result.stopped) throw new Error(sidecarRestartRefusal(result, port))
  return result.record
}

/**
 * Stop the LiveKit sidecar answering on `port` for a restart (BL-1297). Another Batshit's sidecar,
 * or one the user runs, can answer on the same port: only this Batshit's own launch is signalled,
 * as a process group, and anything else is refused with the reason, signalling nothing. A launch
 * that outlives SIGTERM gets SIGKILL only after the same check passes again on the same launch.
 */
export async function stopLiveKitSidecarOnPort(port: number): Promise<boolean> {
  const currentHealth = await inspectLiveKitSidecarHealth(port)
  if (!currentHealth.ready) return false

  const pids = await findListenerPids(port)
  if (!pids.length) {
    throw new Error(
      `LiveKit sidecar is running on port ${port}, but Batshit could not resolve its process id for restart.`
    )
  }

  const launch = await signalOwnSidecarLaunch(port, pids, 'SIGTERM')
  if (await waitForSidecarStopped(port)) return true

  // Still answering: force only that same launch, with the listener, its group and every record
  // read again now, never a process that changed hands meanwhile.
  const listeners = await findListenerPids(port)
  if (listeners.length === 0) {
    if (await waitForSidecarStopped(port)) return true
    throw new Error(`The LiveKit sidecar on port ${port} still answers, but Batshit can no longer find the process listening there, so it did not force it to stop.`)
  }
  await signalOwnSidecarLaunch(port, listeners, 'SIGKILL', launch)

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

/**
 * The LiveKit agent sidecar serves only the Batshit that launched it: its base URL, service token
 * and LiveKit keys are that Batshit's (BL-1311). So one answering on its port is used only when it
 * is this Batshit's own current launch (`verifyOwnLaunchServes`); anything else is refused with
 * this reason, and never stopped or adopted. A worker no record names is unknown, whoever runs it,
 * and an explicit LIVEKIT_AGENT_INSTALL_ROOT (where the package is) does not change that.
 */
function sidecarNotOwnRefusal(check: Exclude<OwnLaunchCheck, { verified: true }>, port: number): string {
  switch (check.refusal) {
    case 'unknown':
      return `Something already answers on the LiveKit sidecar port ${port}, but no launch record of this Batshit names it, so Batshit cannot tell which Batshit it serves and did not use it. Stop that process, then start LiveKit here.`
    case 'foreign':
      return `Another Batshit's LiveKit agent runs on port ${port} and serves that Batshit (${check.reason}), so this Batshit did not use it. Stop LiveKit there, then start it here.`
    case 'unreadable':
      return `Batshit did not use the LiveKit sidecar on port ${port}: ${check.reason}, so it cannot tell which Batshit it serves. Repair or remove that record, then try again.`
    case 'unverified':
      return `Batshit did not use the LiveKit sidecar on port ${port}: ${check.reason}. Make sure nothing else uses that port, then start LiveKit here.`
    case 'unaddressed':
      return `This Batshit's own LiveKit sidecar on port ${port} was started before its launch record carried its address (${check.reason}). Press Start to restart it so it does.`
  }
}

/**
 * Before a LiveKit voice session dispatches its agent (BL-1311): in native Batshit the agent worker
 * that takes the job must be this Batshit's own current sidecar launch, or the session's compiled
 * instructions and turns could go to a worker serving another Batshit, or to one nobody here can
 * vouch for. Returns null when admitted, else the refusal to show (the caller dispatches nothing).
 * Docker Batshit runs the agent as its LiveKit add-on, a separate contract, so it is not checked
 * here. Limit: this proves this Batshit's own worker runs here; it cannot make LiveKit choose it over
 * another worker registered under the same agent name on a shared server.
 */
export async function refuseLiveKitDispatchUnlessOwnSidecar(): Promise<string | null> {
  if (isContainerizedRuntime()) return null
  const port = resolveAgentHealthPort()
  const listeners = await findListenerPids(port)
  if (listeners.length === 0) {
    return `The LiveKit agent is not running on port ${port}, so Batshit did not send this session to any agent. Start LiveKit in Settings -> Voice -> Voice Runtimes, then try again.`
  }
  const own = await verifyOwnLaunchServes({ engineId: LIVEKIT_SIDECAR_ENGINE_ID, endpoint: liveKitSidecarEndpoint(port), listeners })
  return own.verified ? null : `${sidecarNotOwnRefusal(own, port)} Batshit did not send this session to it.`
}

/** The address a LiveKit sidecar's launch record names: its health port. */
function liveKitSidecarEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`
}

/**
 * Before using a LiveKit server that was already running (BL-1298): record this Batshit's use of
 * it, with its saved "Stop with Batshit" choice, when another Batshit launched it, so that
 * Batshit's quit or restart sees this one. One no record can carry is not used, with what to do;
 * one no Batshit started is used as before and never owned.
 */
async function recordLiveKitServerUse(
  config: { serverUrl: string; stopOnShutdown?: boolean },
  summary: LiveKitLocalServerSummary
): Promise<LiveKitLocalServerSummary> {
  const port = getLocalLiveKitServerPort(config.serverUrl)
  if (!port) return summary
  const use = await recordVerifiedRuntimeUse({
    engineId: LIVEKIT_NATIVE_SERVER_ENGINE_ID,
    endpoint: liveKitServerHttpUrl(config.serverUrl, port),
    stopOnShutdown: config.stopOnShutdown !== false,
    listeners: (await inspectLocalLiveKitPortOwner(port)).pids
  })
  if (use.outcome !== 'unrecordable') return summary
  return {
    ...summary,
    status: 'error',
    statusHint: `Batshit did not use the LiveKit server already running on port ${port}: ${use.reason}. Update that Batshit and restart LiveKit there, or stop LiveKit there, then start LiveKit here again.`
  }
}

async function ensureManagedLocalLiveKitServer(config: {
  userId: string
  serverUrl: string
  apiKey: string
  apiSecret: string
  forceRestart?: boolean
  stopOnShutdown?: boolean
}): Promise<LiveKitLocalServerSummary> {
  const inspected = await inspectManagedLocalLiveKitServer(config)
  if (!inspected.managed) return inspected
  if (inspected.status === 'ready' && !config.forceRestart) return recordLiveKitServerUse(config, inspected)

  try {
    const started = await startNativeLiveKitServerRuntime({
      userId: config.userId,
      serverUrl: config.serverUrl,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      forceRestart: config.forceRestart,
      stopOnShutdown: config.stopOnShutdown
    })
    const summary: LiveKitLocalServerSummary = {
      ...inspected,
      status: started.started || started.alreadyRunning ? 'ready' : 'error',
      statusHint: started.statusHint,
      started: started.started,
      alreadyRunning: started.alreadyRunning,
      pid: started.pid,
      logPath: started.logPath
    }
    // Answering now, after this Batshit's launch or because something answered first: record the
    // use the same way, since the launch can lose the port to another Batshit's LiveKit starting
    // at the same moment (its own launch serving is "own" and records nothing more).
    return started.started || started.alreadyRunning ? await recordLiveKitServerUse(config, summary) : summary
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
  stopOnShutdown: boolean
}> {
  const settings = await redis.getUserSettings(userId).catch(() => null)
  const normalized = normalizeVoiceSettings(settings?.voice_settings)
  return {
    selected: normalized.voiceSessionRuntime === 'livekit',
    autoStartOnLaunch:
      normalized.voiceRuntimes?.livekit?.startup?.autoStartOnLaunch === true ||
      parseBooleanEnv(env.LIVEKIT_AGENT_AUTO_START),
    // "Stop with Batshit" for the LiveKit pair. Absent means stop, which is
    // what quitting the packaged Mac app has always done to both processes.
    stopOnShutdown: shouldStopVoiceRuntimeOnShutdown(normalized.voiceRuntimes?.livekit?.startup)
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
  // An answering sidecar is this Batshit's only when its own current launch serves it (BL-1311).
  const sidecar = health.ready
    ? await verifyOwnLaunchServes({ engineId: LIVEKIT_SIDECAR_ENGINE_ID, endpoint: liveKitSidecarEndpoint(port), listeners: pids })
    : null
  const sidecarRefusal = sidecar && !sidecar.verified ? sidecarNotOwnRefusal(sidecar, port) : null
  const serverBlocksRuntime = server?.managed === true && server.status !== 'ready'
  // Where the running LiveKit's launch records do not hold the saved Stop with Batshit choice
  // (BL-1301), the row says so; a failed read of them is said too, never hidden.
  const stopChoiceGap = await describeLiveKitStopChoiceGap(userId, preferences.stopOnShutdown).catch(
    (error) => `Batshit could not read LiveKit's settings or launch records (${error instanceof Error ? error.message : String(error)}), so it cannot tell whether your Stop with Batshit choice reached them.`
  )
  const status: LiveKitSidecarStatus = health.ready
    ? sidecarRefusal
      ? 'error'
      : serverBlocksRuntime
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
    statusHint: [
      sidecarRefusal
        ? appendServerHint(sidecarRefusal, server)
        : health.ready
          ? appendServerHint(
              `${health.statusHint} Use Restart after Batshit updates or LiveKit sidecar changes.`,
              server
            )
          : appendServerHint(health.statusHint, server),
      stopChoiceGap
    ]
      .filter(Boolean)
      .join(' '),
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
  options: {
    forceRestart?: boolean
    forceServerRestart?: boolean
    /**
     * The user pressed Start: this Batshit's own running sidecar whose launch record carries no
     * address (launched before records carried it) is restarted, so the new launch records it
     * (BL-1311). Never at boot.
     */
    repairOwnLaunch?: boolean
  } = {}
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
    forceRestart: forceServerRestart,
    stopOnShutdown: preferences.stopOnShutdown
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
      // Already running: used only when it is this Batshit's own current launch (BL-1311).
      const own = await verifyOwnLaunchServes({ engineId: LIVEKIT_SIDECAR_ENGINE_ID, endpoint: liveKitSidecarEndpoint(port), listeners: pids })
      const repair = !own.verified && own.refusal === 'unaddressed' && options.repairOwnLaunch === true
      if (!own.verified && !repair) {
        return {
          id: LIVEKIT_SIDECAR_RUNTIME_ID,
          name: 'LiveKit',
          kind: 'voice-session-runtime',
          installed,
          selected: preferences.selected,
          autoStartOnLaunch: preferences.autoStartOnLaunch,
          status: 'error',
          statusHint: appendServerHint(sidecarNotOwnRefusal(own, port), server),
          healthUrl,
          agentName: currentHealth.agentName,
          activeJobs: currentHealth.activeJobs,
          logPath: null,
          pid: pids[0] ?? null,
          started: false,
          alreadyRunning: false,
          server
        }
      }
      if (own.verified) {
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
      // This Batshit's own launch from before its record carried the address: on the user's Start,
      // restart it through the sole-ownership stop, so the new launch records it.
      await stopLiveKitSidecarOnPort(port)
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
      stopOnShutdown: preferences.stopOnShutdown,
      // Recorded so another Batshit that finds it running can record its use of it (BL-1298).
      endpoint: liveKitSidecarEndpoint(port),
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
    // What answers may be another Batshit's sidecar (or another worker) that took the port first:
    // ready only when it is this launch (BL-1311).
    const own = health.ready
      ? await verifyOwnLaunchServes({ engineId: LIVEKIT_SIDECAR_ENGINE_ID, endpoint: liveKitSidecarEndpoint(port), listeners: await findListenerPids(port) })
      : null
    if (own && !own.verified) {
      return {
        id: LIVEKIT_SIDECAR_RUNTIME_ID,
        name: 'LiveKit',
        kind: 'voice-session-runtime',
        installed,
        selected: preferences.selected,
        autoStartOnLaunch: preferences.autoStartOnLaunch,
        status: 'error',
        statusHint: appendServerHint(sidecarNotOwnRefusal(own, port), server),
        healthUrl,
        agentName: health.agentName ?? agentName,
        activeJobs: health.activeJobs,
        logPath: started.logPath,
        pid: started.pid,
        started: false,
        alreadyRunning: false,
        restarted: options.forceRestart,
        server
      }
    }
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

const LIVEKIT_RECORD_IDS = [LIVEKIT_NATIVE_SERVER_ENGINE_ID, LIVEKIT_SIDECAR_ENGINE_ID] as const

/**
 * The LiveKit runtimes this user's Batshit runs natively, as the launch-record tidy's engine
 * references (`pruneLocalRuntimeLaunchRecords`, BL-1300): the sidecar whenever LiveKit is
 * configured, the server when it is the Batshit-managed local one, each at the address its launch
 * records. LiveKit is not a voice engine, so without them the tidy read LiveKit as deleted: it
 * released LiveKit's "keep running" and would drop another Batshit's attach to it. Empty when
 * LiveKit is not configured (then the tidy treats its records as any deleted engine's) or runs in
 * Docker. A settings read that fails throws, and the caller skips that tidy.
 */
export async function resolveLiveKitRuntimeEngineRefs(userId: string): Promise<LocalRuntimeEngineRef[]> {
  if (isContainerizedRuntime()) return []
  const config = await readLiveKitVoiceRuntimeConfigForUser(userId)
  if (!config) return []
  const refs: LocalRuntimeEngineRef[] = [
    {
      id: LIVEKIT_SIDECAR_ENGINE_ID,
      baseUrl: liveKitSidecarEndpoint(resolveAgentHealthPort()),
      localRuntime: { launch: { command: process.execPath } }
    }
  ]
  const port = getLocalLiveKitServerPort(config.serverUrl)
  if (port && isBatshitManagedLocalLiveKitServerConfig(config)) {
    refs.push({
      id: LIVEKIT_NATIVE_SERVER_ENGINE_ID,
      baseUrl: liveKitServerHttpUrl(config.serverUrl, port),
      localRuntime: {
        launch: {
          command: path.join(resolveNativeLiveKitServerInstallRoot(), process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server')
        }
      }
    })
  }
  return refs
}

/**
 * Bring this Batshit's LiveKit launch records in line with the saved "Stop with Batshit" choice
 * (BL-1301); call it only after a save is confirmed. The choice is read from the saved settings
 * (a failed read throws: a default is never written over a saved choice), and read again after
 * writing: a save that landed meanwhile is written too, so two saves close together end with the
 * latest saved choice (at most three rounds, else it is reported). Only this registry's records
 * change (`setLocalRuntimeStopChoice`). Where this Batshit has no live record of the LiveKit
 * server it may be using another Batshit's running one: its use is recorded, verified, with the
 * choice (BL-1298). Never for the sidecar, which serves only the Batshit that launched it (BL-1311). Anything that did not take the choice is returned, and shown in the LiveKit row
 * (`describeLiveKitStopChoiceGap`), never dropped silently.
 */
export async function syncLiveKitStopPreference(userId: string): Promise<{ complete: boolean; problems: string[] }> {
  const savedChoice = async () =>
    shouldStopVoiceRuntimeOnShutdown(normalizeVoiceSettings((await redis.getUserSettings(userId))?.voice_settings).voiceRuntimes?.livekit?.startup)
  let stopOnShutdown = await savedChoice()
  for (let round = 1; ; round += 1) {
    const problems = await applyLiveKitStopChoice(userId, stopOnShutdown)
    const now = await savedChoice()
    if (now === stopOnShutdown) return { complete: problems.length === 0, problems }
    if (round === 3) {
      return { complete: false, problems: [...problems, 'the saved Stop with Batshit choice kept changing while Batshit applied it'] }
    }
    stopOnShutdown = now
  }
}

async function applyLiveKitStopChoice(userId: string, stopOnShutdown: boolean): Promise<string[]> {
  const problems: string[] = []
  for (const ref of await resolveLiveKitRuntimeEngineRefs(userId)) {
    const { live, unreadable } = await setLocalRuntimeStopChoice(ref.id, stopOnShutdown)
    problems.push(...unreadable.map((reason) => `${ref.id}: ${reason}`))
    // The sidecar serves only the Batshit that launched it: never attach to one (BL-1311).
    if (live || !ref.baseUrl || ref.id === LIVEKIT_SIDECAR_ENGINE_ID) continue
    const listeners = await liveKitListeners(ref)
    const use = await recordVerifiedRuntimeUse({ engineId: ref.id, endpoint: ref.baseUrl, stopOnShutdown, listeners })
    if (use.outcome === 'unrecordable') problems.push(`${ref.id}: ${use.reason}`)
  }
  return problems
}

/** The live processes listening at a LiveKit runtime's address. */
async function liveKitListeners(ref: LocalRuntimeEngineRef): Promise<number[]> {
  const port = Number(new URL(ref.baseUrl as string).port)
  return ref.id === LIVEKIT_NATIVE_SERVER_ENGINE_ID ? (await inspectLocalLiveKitPortOwner(port)).pids : findListenerPids(port)
}

/**
 * What the LiveKit row must say about this Batshit's records of the running LiveKit, derived each
 * time from the records themselves (BL-1301, BL-1298): one of its running launch records does not
 * hold the saved "Stop with Batshit" choice; a record cannot be read; or it uses a LiveKit another
 * Batshit started with no record of that use (that Batshit relaunched it over this one's attach,
 * or the use was never recorded), so that Batshit's quit or restart can stop it. Null when none.
 */
async function describeLiveKitStopChoiceGap(userId: string, stopOnShutdown: boolean): Promise<string | null> {
  const registry = await resolveVoiceRuntimeRegistryIdentity()
  for (const id of LIVEKIT_RECORD_IDS) {
    for (const entry of await listLocalRuntimeLaunchRecords(id)) {
      if (entry.unreadable) {
        return `A LiveKit launch record cannot be read (${entry.reason}), so Batshit cannot tell whether your Stop with Batshit choice reached it.`
      }
      if (entry.registry !== registry) continue
      if (isLocalRuntimeProcessAlive(entry.pid) && (entry.stopOnShutdown === false) === stopOnShutdown) {
        return 'Your saved Stop with Batshit choice has not reached the running LiveKit yet, so quitting follows its earlier choice until LiveKit restarts.'
      }
    }
  }
  for (const ref of await resolveLiveKitRuntimeEngineRefs(userId)) {
    // A sidecar that is not this Batshit's own is refused in the row already (BL-1311).
    if (!ref.baseUrl || ref.id === LIVEKIT_SIDECAR_ENGINE_ID) continue
    const state = await readRuntimeUseState(ref.id, await liveKitListeners(ref))
    if (state === 'unrecorded') {
      return `This Batshit uses the running LiveKit server another Batshit started, but has no record of that use, so that Batshit's quit or restart can stop it under this one. Start or Restart LiveKit here to record it.`
    }
    if (state === 'unreadable') {
      return `A LiveKit server launch record cannot be read, so Batshit cannot tell whether your Stop with Batshit choice reached it.`
    }
  }
  return null
}
