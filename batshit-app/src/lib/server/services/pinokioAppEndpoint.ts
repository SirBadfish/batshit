/**
 * SA-072 P2 (DL-10): where a Pinokio app answers RIGHT NOW.
 *
 * A Pinokio app artifact never stores a port as truth. Every call asks `pterm status <id>
 * --probe` (the probe is the reachability check; `ready` alone is Pinokio's launch-lifecycle
 * flag, P0) and uses the `ready_url` it reports. A good answer is kept for a few seconds so a
 * burst of panel requests (a ComfyUI run polls `/history` every second) does not spawn a
 * `pterm` per request; an offline or starting answer is never kept, so a start is seen at once.
 *
 * The address must be this machine or a private network host (the same rule the ComfyUI
 * proxy applies), `localhost` becomes `127.0.0.1` (Node resolves `localhost` to `::1` first
 * while Pinokio apps listen on IPv4), and only the origin is kept: the app's API lives at its
 * root, and a `ready_url` can carry a UI path or query.
 */

import { getPinokioAppStatus, type PinokioAppState, type PinokioUnavailableReason } from './pinokioService'

const ONLINE_CACHE_MS = 5_000

export type PinokioAppEndpointCode =
  | 'app_offline'
  | 'pinokio_unavailable'
  | 'app_not_found'
  | 'app_refused'
  | 'pinokio_error'

export type PinokioAppEndpoint =
  | { ok: true; appId: string; title: string; baseUrl: string }
  | {
      ok: false
      code: PinokioAppEndpointCode
      /** The HTTP status a route answers with: 503 offline/unavailable, 404, 400, or 502. */
      status: number
      appId: string
      title: string | null
      /** `offline` or `starting` for `app_offline`. */
      state?: PinokioAppState
      reason?: PinokioUnavailableReason
      message: string
    }

interface CachedEndpoint {
  expiresAt: number
  value: Extract<PinokioAppEndpoint, { ok: true }>
}

const endpointCache = new Map<string, CachedEndpoint>()

/** Drops a kept address, for one app or for all (tests, and after Batshit starts an app). */
export function forgetPinokioAppEndpoint(appId?: string) {
  if (appId) endpointCache.delete(appId.trim())
  else endpointCache.clear()
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  if (parts[0] === 10 || parts[0] === 127) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
}

function isAllowedPinokioAppHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!normalized) return false
  if (normalized === 'localhost' || normalized === '::1') return true
  if (normalized.endsWith('.local')) return true
  return isPrivateIpv4(normalized)
}

/** The origin Batshit calls for a `ready_url`, or `null` when it is not a local/private http(s) URL. */
export function pinokioReadyUrlToBase(readyUrl: string | null | undefined): string | null {
  if (typeof readyUrl !== 'string' || !readyUrl.trim()) return null
  let parsed: URL
  try {
    parsed = new URL(readyUrl.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!isAllowedPinokioAppHost(parsed.hostname)) return null
  if (parsed.hostname.toLowerCase() === 'localhost') parsed.hostname = '127.0.0.1'
  return parsed.origin
}

export async function resolvePinokioAppEndpoint(appIdInput: string): Promise<PinokioAppEndpoint> {
  const appId = appIdInput.trim()
  const cached = endpointCache.get(appId)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  endpointCache.delete(appId)

  const status = await getPinokioAppStatus({ appId, probe: true })
  if (!status.ok) {
    switch (status.kind) {
      case 'unavailable':
        return {
          ok: false,
          code: 'pinokio_unavailable',
          status: 503,
          appId,
          title: null,
          reason: status.reason,
          message: status.message
        }
      case 'not_found':
        return {
          ok: false,
          code: 'app_not_found',
          status: 404,
          appId,
          title: null,
          message: `Pinokio has no app "${appId}" on this computer. ${status.message}`.trim()
        }
      case 'refused':
        return { ok: false, code: 'app_refused', status: 400, appId, title: null, message: status.message }
      default:
        return { ok: false, code: 'pinokio_error', status: 502, appId, title: null, message: status.message }
    }
  }

  const app = status.value
  if (app.state !== 'online' || app.probe !== true) {
    const starting = app.state === 'starting' || (app.state === 'online' && app.probe !== true)
    return {
      ok: false,
      code: 'app_offline',
      status: 503,
      appId,
      title: app.title,
      state: starting ? 'starting' : 'offline',
      message: starting
        ? `${app.title} is still starting in Pinokio.`
        : `${app.title} is not running in Pinokio.`
    }
  }

  const baseUrl = pinokioReadyUrlToBase(app.readyUrl)
  if (!baseUrl) {
    return {
      ok: false,
      code: 'app_refused',
      status: 400,
      appId,
      title: app.title,
      message: `${app.title} reports an address Batshit will not call (${app.readyUrl ?? 'none'}): only this computer or a private network address.`
    }
  }

  const value = { ok: true as const, appId, title: app.title, baseUrl }
  endpointCache.set(appId, { expiresAt: Date.now() + ONLINE_CACHE_MS, value })
  return value
}

/**
 * The words an AGENT reads when a Pinokio app artifact cannot reach its app: what happened,
 * and the exact next step (the start is the user's Approve click, DL-03).
 */
export function pinokioEndpointAgentMessage(endpoint: Exclude<PinokioAppEndpoint, { ok: true }>): string {
  if (endpoint.code === 'app_offline' && endpoint.state === 'starting') {
    return `${endpoint.message} Check it with fabric:sys.pinokio.app_status (input: { "appId": "${endpoint.appId}" }) and run this artifact again once it is online.`
  }
  if (endpoint.code === 'app_offline') {
    return `${endpoint.message} Start it now with fabric:sys.pinokio.run (input: { "appId": "${endpoint.appId}" }): Batshit shows the user an Approve card for the start, so do not ask in chat first. Then run this artifact again.`
  }
  return endpoint.message
}

/* ------------------------------------------------------------------ *
 * What the app's own API looks like (for an agent writing a recipe)
 * ------------------------------------------------------------------ */

const API_PROBE_TIMEOUT_MS = 8_000
const API_MAX_ENDPOINTS = 12
const API_TEXT_MAX_CHARS = 160

export type PinokioAppApiDescription =
  | {
      kind: 'gradio'
      apiPrefix: string
      endpoints: Array<{
        api_name: string
        parameters: Array<{ name: string; label: string | null; component: string | null; type: string | null; required: boolean; default?: unknown }>
        returns: Array<{ position: number; label: string | null; component: string | null; type: string | null }>
      }>
      hint: string
    }
  | { kind: 'comfyui'; comfyuiVersion: string | null; hint: string }
  | { kind: 'unknown'; hint: string }

function shortText(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > API_TEXT_MAX_CHARS ? `${text.slice(0, API_TEXT_MAX_CHARS)}…` : text
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<Record<string, any> | null> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(API_PROBE_TIMEOUT_MS) })
    if (!response.ok) return null
    const value = await response.json().catch(() => null)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null
  } catch {
    return null
  }
}

/** Summarizes a Gradio `/info` answer to what a recipe needs. Exported for tests. */
export function summarizeGradioInfo(info: Record<string, any>): Extract<PinokioAppApiDescription, { kind: 'gradio' }>['endpoints'] {
  const named = info.named_endpoints && typeof info.named_endpoints === 'object' ? info.named_endpoints : {}
  return Object.entries(named as Record<string, any>)
    .slice(0, API_MAX_ENDPOINTS)
    .map(([apiName, endpoint]) => ({
      api_name: apiName,
      parameters: (Array.isArray(endpoint?.parameters) ? endpoint.parameters : []).map((parameter: any) => ({
        name: String(parameter?.parameter_name ?? parameter?.label ?? ''),
        label: shortText(parameter?.label),
        component: shortText(parameter?.component),
        type: shortText(parameter?.python_type?.type ?? parameter?.type?.type),
        required: parameter?.parameter_has_default !== true,
        ...(parameter?.parameter_has_default === true ? { default: parameter.parameter_default } : {})
      })),
      returns: (Array.isArray(endpoint?.returns) ? endpoint.returns : []).map((entry: any, position: number) => ({
        position,
        label: shortText(entry?.label),
        component: shortText(entry?.component),
        type: shortText(entry?.python_type?.type ?? entry?.type?.type)
      }))
    }))
}

/**
 * Reads what kind of API a RUNNING app has, so an agent can write its recipe: a Gradio app's
 * named endpoints (`<api prefix>/info`), or that it is ComfyUI (`/system_stats`), or neither.
 * Read-only GETs against the address Pinokio reported; nothing starts.
 */
export async function describePinokioAppApi(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<PinokioAppApiDescription> {
  const config = await getJson(fetchImpl, `${baseUrl}/config`)
  if (config && (typeof config.version === 'string' || Array.isArray(config.components))) {
    const rawPrefix = typeof config.api_prefix === 'string' ? config.api_prefix.trim() : ''
    const apiPrefix = rawPrefix === '/' ? '' : rawPrefix.replace(/\/+$/, '')
    const info = (await getJson(fetchImpl, `${baseUrl}${apiPrefix}/info`)) ?? {}
    return {
      kind: 'gradio',
      apiPrefix,
      endpoints: summarizeGradioInfo(info),
      hint:
        'A Gradio app in Pinokio: build a Pinokio App artifact (brain_type "pinokio_app", metadata.runtime_manager "pinokio", metadata.pinokio_app_id, source_type "gradio"; agents can run it), not a Gradio embed. Its metadata.pinokio_runtime is { api_name, inputs: one entry per parameter, in order: { "field": "<fabricId>" } (add "file": true for an image or file parameter) or { "value": <fixed value> }, and outputs: the "position" of each returned value that is the result, such as [1] (leave out previews, status lines, and slider updates) }. The Artifact Creator\'s runtime-pinokio.md has the full recipe.'
    }
  }
  const stats = await getJson(fetchImpl, `${baseUrl}/system_stats`)
  if (stats && stats.system && typeof stats.system === 'object') {
    return {
      kind: 'comfyui',
      comfyuiVersion: typeof stats.system.comfyui_version === 'string' ? stats.system.comfyui_version : null,
      hint: `ComfyUI in Pinokio: build a Pinokio App artifact (brain_type "pinokio_app", metadata.runtime_manager "pinokio", metadata.pinokio_app_id, source_type "comfyui"; agents can run it), not a plain ComfyUI panel. List and load its saved workflows with fabric:sys.comfyui.workflows (baseUrl: "${baseUrl}"), then store the API-format workflow in metadata.pinokio_runtime.workflow with inputs mapping each fabricId to { node, input }. The Artifact Creator's runtime-pinokio.md has the full recipe.`
    }
  }
  return {
    kind: 'unknown',
    hint: 'Neither ComfyUI nor Gradio answered. If the app has its own HTTP API, use metadata.source_type "custom" and a pinokio_runtime of { "method": "POST", "path": "/its/endpoint" }; the field values are sent as the JSON body.'
  }
}
