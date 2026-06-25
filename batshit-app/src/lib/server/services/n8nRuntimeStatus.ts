import { env } from '$env/dynamic/private'
import { apiKeyService } from '$lib/services/apiKey.server'
import {
  isContainerizedRuntime,
  resolveRuntimeN8nBaseUrl
} from '$lib/server/services/runtimeUrlRewrites'

type RuntimeEnv = Partial<Record<string, string | undefined>>

export type N8nRuntimeMode = 'mac-app' | 'docker' | 'native'
export type N8nRuntimeUrlSource = 'saved-api-url' | 'runtime-env' | 'default-localhost'

export type N8nRuntimeStatus = {
  mode: N8nRuntimeMode
  healthy: boolean
  reachable: boolean
  status: number | null
  effectiveUrl: string
  healthUrl: string
  urlSource: N8nRuntimeUrlSource
  apiKeyConfigured: boolean
  error: string | null
  launch: {
    startSupported: false
    browserOpenSupported: false
    reason: string
  }
}

type N8nRuntimeStatusOptions = {
  userId?: string | null
  runtimeEnv?: RuntimeEnv
  fetchImpl?: typeof fetch
}

function runtimeMode(runtimeEnv: RuntimeEnv): N8nRuntimeMode {
  if (runtimeEnv.BATSHIT_RUNTIME_OWNER === 'mac-app') return 'mac-app'
  if (isContainerizedRuntime(runtimeEnv)) return 'docker'
  return 'native'
}

function normalizeN8nBaseUrl(raw: string): string {
  const parsed = new URL(raw)
  parsed.hash = ''
  parsed.search = ''

  const normalizedPath = parsed.pathname.replace(/\/+$/, '')
  if (normalizedPath === '/api/v1' || normalizedPath.startsWith('/api/v1/')) {
    parsed.pathname = '/'
  } else if (normalizedPath === '/webhook' || normalizedPath.startsWith('/webhook/')) {
    parsed.pathname = '/'
  }

  return parsed.toString().replace(/\/+$/, '')
}

async function getSavedValue(service: string, userId?: string | null) {
  if (!userId) return null
  return (await apiKeyService.retrieve(service, userId).catch(() => null))?.trim() || null
}

function launchReason(mode: N8nRuntimeMode) {
  if (mode === 'mac-app') {
    return 'The Mac app connects to an existing n8n instance today; it does not bundle or auto-start n8n yet.'
  }
  if (mode === 'docker') {
    return 'Docker n8n is opt-in through the n8n Compose profile; the app does not start extra n8n containers from inside Batshit.'
  }
  return 'Source-checkout n8n startup is owned by the launcher before the app boots, so Admin cannot safely change it after startup.'
}

export async function getN8nRuntimeStatus(
  options: N8nRuntimeStatusOptions = {}
): Promise<N8nRuntimeStatus> {
  const runtimeEnv = options.runtimeEnv ?? env
  const fetchImpl = options.fetchImpl ?? fetch
  const mode = runtimeMode(runtimeEnv)
  const savedApiUrl = await getSavedValue('n8n_api_url', options.userId)
  const savedApiKey = await getSavedValue('n8n_api_key', options.userId)
  const runtimeApiUrl =
    runtimeEnv.N8N_API_URL?.trim() ||
    runtimeEnv.N8N_URL?.trim() ||
    runtimeEnv.N8N_BASE_URL?.trim() ||
    null
  const resolvedUrl =
    resolveRuntimeN8nBaseUrl(savedApiUrl, runtimeEnv) ||
    savedApiUrl ||
    runtimeApiUrl ||
    'http://localhost:5678'
  const urlSource: N8nRuntimeUrlSource =
    runtimeApiUrl && resolvedUrl === runtimeApiUrl
      ? 'runtime-env'
      : savedApiUrl && resolvedUrl === savedApiUrl
        ? 'saved-api-url'
        : runtimeApiUrl
          ? 'runtime-env'
          : 'default-localhost'
  let effectiveUrl: string

  try {
    effectiveUrl = normalizeN8nBaseUrl(resolvedUrl)
  } catch {
    return {
      mode,
      healthy: false,
      reachable: false,
      status: null,
      effectiveUrl: resolvedUrl,
      healthUrl: resolvedUrl,
      urlSource,
      apiKeyConfigured: Boolean(savedApiKey || runtimeEnv.N8N_API_KEY?.trim()),
      error: `Invalid n8n URL: ${resolvedUrl}`,
      launch: {
        startSupported: false,
        browserOpenSupported: false,
        reason: launchReason(mode)
      }
    }
  }

  const healthUrl = `${effectiveUrl}/healthz`
  try {
    const response = await fetchImpl(healthUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(2500)
    })
    return {
      mode,
      healthy: response.ok,
      reachable: true,
      status: response.status,
      effectiveUrl,
      healthUrl,
      urlSource,
      apiKeyConfigured: Boolean(savedApiKey || runtimeEnv.N8N_API_KEY?.trim()),
      error: response.ok ? null : `n8n health responded with HTTP ${response.status}.`,
      launch: {
        startSupported: false,
        browserOpenSupported: false,
        reason: launchReason(mode)
      }
    }
  } catch (error) {
    return {
      mode,
      healthy: false,
      reachable: false,
      status: null,
      effectiveUrl,
      healthUrl,
      urlSource,
      apiKeyConfigured: Boolean(savedApiKey || runtimeEnv.N8N_API_KEY?.trim()),
      error: error instanceof Error ? error.message : 'n8n did not respond.',
      launch: {
        startSupported: false,
        browserOpenSupported: false,
        reason: launchReason(mode)
      }
    }
  }
}
