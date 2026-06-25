import { env } from '$env/dynamic/private'
import type {
  LocalVoiceEngineInstallOwnership,
  VoiceEngineLaunchConfig
} from '$lib/types/voice'

const DEFAULT_OPERATOR_TIMEOUT_MS = 180_000

export type HostVoiceRuntimeStartInput = {
  engineId: string
  installRoot: string
  installOwnership?: LocalVoiceEngineInstallOwnership
  launch: VoiceEngineLaunchConfig
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

async function fetchOperatorJson(path: string, init: RequestInit = {}) {
  const config = resolveOperatorConfig()
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
