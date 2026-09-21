import { env } from '$env/dynamic/private'
import type {
  LocalVoiceEngineInstallOwnership,
  VoiceEngineLaunchConfig,
  VoiceEngineRecord
} from '$lib/types/voice'
import { registerRuntimeShutdownTask } from '$lib/server/services/runtimeShutdown'
import { shouldStopVoiceRuntimeOnShutdown } from '$lib/utils/voiceSchema'

const DEFAULT_OPERATOR_TIMEOUT_MS = 180_000
/**
 * The first operator protocol revision (`sandboxRevision` in its `/health`) that records the
 * engines it starts and can stop them (`POST /v1/voice-engines/stop`). A floor, not a twin of
 * the operator's current revision: later revisions keep the stop.
 */
export const HOST_OPERATOR_VOICE_STOP_REVISION = 5
const STOP_SUPPORT_CACHE_MS = 30_000
const STOP_SUPPORT_PROBE_TIMEOUT_MS = 2_000
/**
 * The whole shutdown stop, registry read included. `docker stop` waits 10 s before its
 * SIGKILL, and the operator's own stop needs about 2.5 s (a 2 s SIGTERM grace, then SIGKILL).
 */
export const HOST_VOICE_SHUTDOWN_STOP_TIMEOUT_MS = 5_000
const HOST_VOICE_SHUTDOWN_TASK = 'voice-engines-host-operator'

export type HostVoiceRuntimeStartInput = {
  engineId: string
  installRoot: string
  installOwnership?: LocalVoiceEngineInstallOwnership
  launch: VoiceEngineLaunchConfig
  /** The engine's base URL: the listener the runtime serves, for engines that share it. */
  endpoint?: string | null
  /** "Stop with Batshit" when it started; the choice sent at shutdown is what decides. */
  stopOnShutdown?: boolean
}

/** One engine's "Stop with Batshit" choice, as sent to the operator at shutdown. */
export type HostVoiceRuntimeStopChoice = {
  engineId: string
  endpoint: string | null
  stopOnShutdown: boolean
}

export type HostVoiceRuntimeStopOutcome = {
  pid: number
  engineIds: string[]
  reason?: string
}

export type HostVoiceRuntimeStopResult = {
  stopped: HostVoiceRuntimeStopOutcome[]
  keptRunning: HostVoiceRuntimeStopOutcome[]
  notStopped: HostVoiceRuntimeStopOutcome[]
}

export type HostVoiceRuntimeStartResult = {
  success: boolean
  engineId: string
  pid: number | null
  command?: string
  args?: string[]
  cwd?: string
  installRoot?: string
  logPath?: string
  error?: string
}

export type HostVoiceReferenceAudioInput = {
  profileId: string
  audioBase64: string
  filename?: string | null
  contentType?: string | null
}

export type HostVoiceReferenceAudioResult = {
  success: boolean
  profileId: string
  audioPath: string
  dirPath?: string
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
  const raw = Number(env.BATSHIT_RUNTIME_ADDON_OPERATOR_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 1_000 ? raw : DEFAULT_OPERATOR_TIMEOUT_MS
}

function resolveOperatorConfig() {
  const rawUrl =
    env.BATSHIT_RUNTIME_ADDON_OPERATOR_URL?.trim() ||
    env.BATSHIT_DOCKER_SANDBOX_OPERATOR_URL?.trim()
  const url = normalizeOperatorUrl(rawUrl)
  const token =
    env.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN?.trim() ||
    env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN?.trim() ||
    null

  if (!url) {
    throw new Error('Runtime add-on operator is not configured.')
  }
  if (!token) {
    throw new Error('BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN is required when the runtime add-on operator is configured.')
  }

  return {
    url,
    token,
    timeoutMs: resolveOperatorTimeoutMs()
  }
}

async function fetchOperatorJson(path: string, init: RequestInit = {}, timeoutMs?: number) {
  const config = resolveOperatorConfig()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? config.timeoutMs)

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
    if (!response.ok || payload?.ok === false) {
      throw new Error(
        typeof payload?.error === 'string'
          ? payload.error
          : `Runtime add-on operator returned HTTP ${response.status}.`
      )
    }
    return payload ?? {}
  } finally {
    clearTimeout(timeout)
  }
}

export async function startHostVoiceRuntimeViaOperator(
  input: HostVoiceRuntimeStartInput
): Promise<HostVoiceRuntimeStartResult> {
  const payload = await fetchOperatorJson('/v1/voice-engines/start', {
    method: 'POST',
    body: JSON.stringify(input)
  })

  return {
    success: payload.success !== false,
    engineId: typeof payload.engineId === 'string' ? payload.engineId : input.engineId,
    pid: typeof payload.pid === 'number' ? payload.pid : null,
    command: typeof payload.command === 'string' ? payload.command : undefined,
    args: Array.isArray(payload.args) ? payload.args.map((entry) => String(entry)) : undefined,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
    installRoot: typeof payload.installRoot === 'string' ? payload.installRoot : undefined,
    logPath: typeof payload.logPath === 'string' ? payload.logPath : undefined
  }
}

export async function saveHostVoiceReferenceAudioViaOperator(
  input: HostVoiceReferenceAudioInput
): Promise<HostVoiceReferenceAudioResult> {
  const payload = await fetchOperatorJson('/v1/voice-profiles/reference-audio', {
    method: 'POST',
    body: JSON.stringify(input)
  })

  const audioPath = typeof payload.audioPath === 'string' ? payload.audioPath : ''
  if (!audioPath) {
    throw new Error('Runtime add-on operator did not return a host reference-audio path.')
  }

  return {
    success: payload.success !== false,
    profileId: typeof payload.profileId === 'string' ? payload.profileId : input.profileId,
    audioPath,
    dirPath: typeof payload.dirPath === 'string' ? payload.dirPath : undefined
  }
}

// ---- "Stop with Batshit" in Docker ---------------------------------------------------------
//
// The core app container never spawns host processes, so it cannot stop them either: the host
// operator started them, records what it started, and stops them on request (revision 5,
// 2026-09-18). The decision, including "a runtime several engines share stops only if every
// one of them says stop", is the shared module the Mac supervisor and the native launcher use
// (`batshit-mac/scripts/local-voice-runtime-stop.mjs`); the app only sends each engine's choice.

let stopSupportCache: { value: boolean; checkedAt: number } | null = null

/**
 * Can the operator this container talks to stop host voice engines? Only then is "Stop with
 * Batshit" offered in Docker. False when no operator is configured, it does not answer, it is
 * older than revision 5 (`start-docker` replaces it on the next start), or it does not list
 * `stop` among its host voice controls (it runs on Windows, where the stop is not built yet).
 */
export async function hostOperatorCanStopVoiceRuntimes(): Promise<boolean> {
  if (stopSupportCache && Date.now() - stopSupportCache.checkedAt < STOP_SUPPORT_CACHE_MS) {
    return stopSupportCache.value
  }
  let value = false
  try {
    const health = await fetchOperatorJson('/health', { method: 'GET' }, STOP_SUPPORT_PROBE_TIMEOUT_MS)
    value =
      Number(health.sandboxRevision) >= HOST_OPERATOR_VOICE_STOP_REVISION &&
      Array.isArray(health.hostVoiceControls) &&
      health.hostVoiceControls.includes('stop')
  } catch {
    value = false
  }
  stopSupportCache = { value, checkedAt: Date.now() }
  return value
}

export function resetHostOperatorVoiceStopSupportCacheForTests() {
  stopSupportCache = null
}

function readStopOutcomes(value: unknown): HostVoiceRuntimeStopOutcome[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      pid: typeof entry.pid === 'number' ? entry.pid : 0,
      engineIds: Array.isArray(entry.engineIds) ? entry.engineIds.map((id) => String(id)) : [],
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {})
    }))
}

/**
 * Ask the operator to stop what it started, given every engine's choice. It stops a process
 * only when every engine that uses it says stop (an engine it recorded that the app no longer
 * names has no saved choice, so it stops), and only when the process still matches its record.
 */
export async function stopHostVoiceRuntimesViaOperator(
  engines: HostVoiceRuntimeStopChoice[],
  options: { timeoutMs?: number } = {}
): Promise<HostVoiceRuntimeStopResult> {
  const payload = await fetchOperatorJson(
    '/v1/voice-engines/stop',
    { method: 'POST', body: JSON.stringify({ engines }) },
    options.timeoutMs ?? HOST_VOICE_SHUTDOWN_STOP_TIMEOUT_MS
  )
  return {
    stopped: readStopOutcomes(payload.stopped),
    keptRunning: readStopOutcomes(payload.keptRunning),
    notStopped: readStopOutcomes(payload.notStopped)
  }
}

function hostOperatorConfigured(): boolean {
  return Boolean(
    env.BATSHIT_RUNTIME_ADDON_OPERATOR_URL?.trim() || env.BATSHIT_DOCKER_SANDBOX_OPERATOR_URL?.trim()
  )
}

function withinDeadline<T>(work: Promise<T>, deadline: number, what: string): Promise<T> {
  const remaining = Math.max(0, deadline - Date.now())
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took longer than the shutdown allows`)), remaining)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * The container is shutting down: stop the host voice engines it started, as each engine's
 * "Stop with Batshit" choice says (absent means stop). Bounded, so a missing or hung operator
 * never holds shutdown up; whatever it could not stop is logged and keeps running on the host.
 */
export async function stopHostVoiceRuntimesAtShutdown(
  listEngines: () => Promise<VoiceEngineRecord[]>,
  options: { timeoutMs?: number; log?: Pick<Console, 'info' | 'warn'> } = {}
): Promise<HostVoiceRuntimeStopResult | null> {
  const log = options.log ?? console
  // Without an operator nothing can have been started on the host, so there is nothing to stop.
  if (!hostOperatorConfigured()) return null
  const deadline = Date.now() + (options.timeoutMs ?? HOST_VOICE_SHUTDOWN_STOP_TIMEOUT_MS)
  try {
    const engines = await withinDeadline(listEngines(), deadline, 'Reading the voice engines')
    const choices = engines
      .filter((engine) => engine.localRuntime?.launch?.command)
      .map((engine) => ({
        engineId: engine.id,
        endpoint: engine.baseUrl ?? null,
        stopOnShutdown: shouldStopVoiceRuntimeOnShutdown(engine.localRuntime?.startup)
      }))
    const result = await stopHostVoiceRuntimesViaOperator(choices, {
      timeoutMs: Math.max(1, deadline - Date.now())
    })
    for (const outcome of result.stopped) {
      log.info(`[voice-runtime] Stopped host voice engine ${outcome.engineIds.join(', ')} (pid ${outcome.pid}).`)
    }
    for (const outcome of result.keptRunning) {
      log.info(
        `[voice-runtime] Left host voice engine ${outcome.engineIds.join(', ')} running: ${outcome.reason ?? 'kept'}.`
      )
    }
    for (const outcome of result.notStopped) {
      log.warn(
        `[voice-runtime] Could not stop host voice engine ${outcome.engineIds.join(', ')} (pid ${outcome.pid}): ${outcome.reason ?? 'unknown reason'}.`
      )
    }
    return result
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log.warn(
      `[voice-runtime] Could not stop host voice engines through the Docker helper: ${reason}. They keep running on the host until stopped there.`
    )
    return null
  }
}

/** Stop the host voice engines when this container shuts down (SIGTERM, `docker stop`). */
export function registerHostVoiceRuntimeShutdown(listEngines: () => Promise<VoiceEngineRecord[]>) {
  registerRuntimeShutdownTask(HOST_VOICE_SHUTDOWN_TASK, async () => {
    await stopHostVoiceRuntimesAtShutdown(listEngines)
  })
}
