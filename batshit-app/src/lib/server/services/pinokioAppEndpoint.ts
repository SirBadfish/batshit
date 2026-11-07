/** Target-bound Pinokio app discovery. Saved control origins never become app origins. */
import { Agent } from 'undici'
import { getPinokioAppStatus, type PinokioAppState, type PinokioUnavailableReason } from './pinokioService'
import { pinokioMachineService } from './pinokioMachineService'
import { LOCAL_PINOKIO_MACHINE_ID, pinokioTargetKey, isPinokioControlHost } from '$lib/pinokio/machines'

const ONLINE_CACHE_MS = 5_000
const APP_PROBE_BUDGET_MS = 8_000
// A dedicated direct dispatcher prevents environment proxy credentials or DNS retargeting.
const appDispatcher = new Agent({ connect: { timeout: APP_PROBE_BUDGET_MS } })

export type PinokioAppEndpointCode = 'app_offline' | 'pinokio_unavailable' | 'app_not_found' | 'app_refused' | 'pinokio_error'
export interface PinokioEndpointOptions {
  userId?: string
  machineId?: string
  revision?: number
  signal?: AbortSignal
  /** Server-owned saved Artifact/actor admission, never taken from an HTTP body. */
  admitFetch?: () => Promise<void>
}
interface OnlineEndpoint {
  ok: true
  appId: string
  title: string
  baseUrl: string
  machineId?: string
  machineRevision?: number
  machineLabel?: string
  /** Exact native aliases reported by this app, used only to normalize its file route. */
  nativeReadyOrigins?: string[]
  /** Present only for a remote target; every app request must use this pinned reader. */
  fetch?: typeof fetch
}
export type PinokioAppEndpoint = OnlineEndpoint | {
  ok: false
  code: PinokioAppEndpointCode
  status: number
  appId: string
  title: string | null
  state?: PinokioAppState
  reason?: PinokioUnavailableReason
  machineId?: string
  machineRevision?: number
  machineLabel?: string
  message: string
}
const endpointCache = new Map<string, { expiresAt: number; value: OnlineEndpoint }>()

/** Drop every machine-qualified entry for this app; restore drops the complete cache. */
export function forgetPinokioAppEndpoint(appId?: string) {
  if (!appId) return endpointCache.clear()
  for (const [key, entry] of endpointCache) if (entry.value.appId === appId.trim()) endpointCache.delete(key)
}
function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 127 || isPinokioControlHost(hostname)
}
/** Preserve the accepted local ready_url policy, including its IPv4 localhost normalization. */
export function pinokioReadyUrlToBase(readyUrl: string | null | undefined): string | null {
  if (typeof readyUrl !== 'string' || !readyUrl.trim()) return null
  try {
    const url = new URL(readyUrl.trim())
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (!['http:', 'https:'].includes(url.protocol) || !(host === 'localhost' || host === '::1' || host.endsWith('.local') || isPrivateIpv4(host))) return null
    if (host === 'localhost') url.hostname = '127.0.0.1'
    return url.origin
  } catch { return null }
}
function remoteAppUrl(raw: string, host: string): URL | null {
  try {
    const url = new URL(raw)
    return ['http:', 'https:'].includes(url.protocol) && isPinokioControlHost(host) && url.hostname === host && !url.username && !url.password && !url.hash ? url : null
  } catch { return null }
}
function nativeAlias(raw: string | null): string[] {
  if (!raw) return []
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return []
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '::'].includes(host) ? [url.origin] : []
  } catch { return [] }
}
function refused(message: string): never { throw Object.assign(new Error(message), { status: 409 }) }
function failureMessage(cause: unknown): string {
  if (cause && typeof cause === 'object') {
    const value = cause as { message?: unknown; body?: { message?: unknown } }
    if (typeof value.message === 'string') return value.message
    if (typeof value.body?.message === 'string') return value.body.message
  }
  return 'The saved Pinokio target could not be admitted.'
}

export async function resolvePinokioAppEndpoint(appIdInput: string, options: PinokioEndpointOptions = {}): Promise<PinokioAppEndpoint> {
  const appId = appIdInput.trim()
  const remote = options.machineId !== undefined && options.machineId !== LOCAL_PINOKIO_MACHINE_ID
  let scope: { machineId?: string; machineRevision?: number; machineLabel?: string } = {}
  try {
    options.signal?.throwIfAborted()
    await options.admitFetch?.()
    options.signal?.throwIfAborted()
    if (!remote && options.revision !== undefined && options.revision !== 0) refused('A target revision requires its saved Pinokio computer.')
    if (!remote && options.machineId === undefined && options.revision !== undefined) refused('A target revision requires its saved Pinokio computer.')
    if (remote && !options.userId) refused('A signed-in owner is required for a saved Pinokio computer.')
    // Resolve before cache access, even when a previous run reached this app moments ago.
    const target = remote
      ? options.revision === undefined
        ? await pinokioMachineService.resolveCurrent(options.userId!, options.machineId)
        : await pinokioMachineService.resolve(options.userId!, { machineId: options.machineId!, revision: options.revision })
      : null
    options.signal?.throwIfAborted()
    if (remote && target?.kind !== 'remote') refused('Choose a confirmed saved remote Pinokio computer.')
    const saved = target?.kind === 'remote' ? target : null
    if (saved) scope = { machineId: saved.id, machineRevision: saved.revision, machineLabel: saved.label }
    const assertTarget = async () => {
      options.signal?.throwIfAborted()
      await options.admitFetch?.()
      options.signal?.throwIfAborted()
      if (saved) {
        const current = await pinokioMachineService.resolve(options.userId!, { machineId: saved.id, revision: saved.revision })
        options.signal?.throwIfAborted()
        if (current.kind !== 'remote' || current.id !== saved.id || current.revision !== saved.revision || current.controlHost !== saved.controlHost || current.controlPort !== saved.controlPort || current.controlProtocol !== saved.controlProtocol) refused('This Pinokio computer changed during the run. Run the Artifact again.')
      }
      await options.admitFetch?.()
      options.signal?.throwIfAborted()
    }
    const bind = (value: OnlineEndpoint): OnlineEndpoint => {
      if (!saved) return value
      const boundFetch: typeof fetch = async (resource, init = {}) => {
        if (typeof resource !== 'string' && !(resource instanceof URL)) refused('Pinokio app requests must use a bound app URL.')
        const raw = String(resource)
        const url = new URL(raw, value.baseUrl)
        if (url.origin !== value.baseUrl || url.username || url.password || url.hash || raw.startsWith('//')) refused('This request leaves the saved Pinokio app origin.')
        await assertTarget()
        const headers = new Headers(init.headers)
        for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-batshit-service-token']) headers.delete(name)
        const signal = init.signal && options.signal ? AbortSignal.any([init.signal, options.signal]) : init.signal ?? options.signal
        signal?.throwIfAborted()
        const response = await fetch(url.toString(), { ...init, signal, headers, credentials: 'omit', redirect: 'error', dispatcher: appDispatcher } as RequestInit)
        if (signal?.aborted) { await response.body?.cancel().catch(() => {}); signal.throwIfAborted() }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel()
          refused('The Pinokio app redirected its response; Batshit did not follow it.')
        }
        return response
      }
      return { ...value, fetch: boundFetch }
    }
    const key = pinokioTargetKey(options.userId ?? '', { machineId: saved?.id ?? LOCAL_PINOKIO_MACHINE_ID, revision: saved?.revision ?? 0, appId })
    const cached = endpointCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      await assertTarget()
      return bind({ ...cached.value, ...scope })
    }
    endpointCache.delete(key)
    const status = await getPinokioAppStatus({ appId, probe: true, ...(saved ? { userId: options.userId, machineId: saved.id, revision: saved.revision, signal: options.signal } : {}) })
    await assertTarget()
    if (!status.ok) {
      const code = status.kind === 'unavailable' ? 'pinokio_unavailable' : status.kind === 'not_found' ? 'app_not_found' : status.kind === 'refused' ? 'app_refused' : 'pinokio_error'
      return { ok: false, code, status: status.kind === 'unavailable' ? 503 : status.kind === 'not_found' ? 404 : status.kind === 'refused' ? 400 : 502, appId, title: null, ...scope, message: status.message, ...(status.kind === 'unavailable' ? { reason: status.reason } : {}) }
    }
    const app = status.value
    if (app.state !== 'online' || (!saved && app.probe !== true)) {
      const starting = app.state === 'starting' || app.state === 'online'
      return { ok: false, code: 'app_offline', status: 503, appId, title: app.title, ...scope, state: starting ? 'starting' : 'offline', message: `${app.title} is ${starting ? 'still starting' : 'not running'} in Pinokio.` }
    }
    let value: OnlineEndpoint
    if (!saved) {
      const baseUrl = pinokioReadyUrlToBase(app.readyUrl)
      if (!baseUrl) return { ok: false, code: 'app_refused', status: 400, appId, title: app.title, message: `${app.title} reports an address Batshit will not call (${app.readyUrl ?? 'none'}): only this computer or a private network address.` }
      value = { ok: true, appId, title: app.title, baseUrl, nativeReadyOrigins: nativeAlias(app.readyUrl) }
    } else {
      const candidates = [...new Set(app.externalReadyUrls ?? [])].map(raw => remoteAppUrl(raw, saved.controlHost)).filter((url): url is URL => !!url)
      const deadline = Date.now() + APP_PROBE_BUDGET_MS
      let reached: URL | null = null
      for (const candidate of candidates) {
        if (Date.now() >= deadline) break
        const probe = bind({ ok: true, appId, title: app.title, baseUrl: candidate.origin })
        let response: Response | undefined
        try {
          response = await probe.fetch!(candidate.toString(), { method: 'GET', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
          if (response.ok) reached = candidate
        } catch { options.signal?.throwIfAborted() }
        finally { await response?.body?.cancel().catch(() => {}) }
        await assertTarget()
        if (reached) break
      }
      if (!reached) return { ok: false, code: 'app_offline', status: 503, appId, title: app.title, ...scope, state: 'starting', message: `${app.title} has no advertised app address reachable from Batshit on ${saved.label}.` }
      value = { ok: true, appId, title: app.title, baseUrl: reached.origin, ...scope, nativeReadyOrigins: nativeAlias(app.readyUrl) }
    }
    endpointCache.set(key, { expiresAt: Date.now() + ONLINE_CACHE_MS, value })
    return bind(value)
  } catch (error) {
    if (options.signal?.aborted) throw error
    return { ok: false, code: 'app_refused', status: (error as {status?:number})?.status ?? 400, appId, title: null, ...scope, message: failureMessage(error) }
  }
}

/**
 * The words an AGENT reads when a Pinokio app artifact cannot reach its app: what happened,
 * and the exact next step (the start is the user's Approve click, DL-03).
 */
export function pinokioEndpointAgentMessage(endpoint: Exclude<PinokioAppEndpoint, { ok: true }>): string {
  const target = endpoint.machineId ? { machineId: endpoint.machineId, revision: endpoint.machineRevision } : {}
  if (endpoint.code === 'app_offline' && endpoint.state === 'starting') {
    return `${endpoint.message} Check it with fabric:sys.pinokio.app_status (input: ${JSON.stringify({ appId: endpoint.appId, ...target })}) and run this artifact again once Batshit can reach its app.`
  }
  if (endpoint.code === 'app_offline' && endpoint.machineId) {
    return `${endpoint.message} Read a fresh start preview with fabric:sys.pinokio.app_status (input: ${JSON.stringify({ appId: endpoint.appId, ...target, previewStart: true })}). Start this same saved computer with fabric:sys.pinokio.run using the preview's machineId, revision (machineRevision), launchFingerprint and alsoStarts. Batshit shows the user an Approve card, so do not ask in chat first. Then run this artifact again.`
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
  } catch (cause) {
    if ((cause && typeof cause === 'object' && ('status' in cause || 'code' in cause)) || (cause instanceof Error && cause.name === 'AbortError')) throw cause
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
export async function describePinokioAppApi(baseUrl: string, fetchImpl: typeof fetch = fetch, options: { machineId?: string } = {}): Promise<PinokioAppApiDescription> {
  const targetHint = options.machineId ? ` For this saved computer set metadata.pinokio_machine_id to ${JSON.stringify(options.machineId)}; do not save a revision or address.` : ''
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
        'A Gradio app in Pinokio: build a Pinokio App artifact (brain_type "pinokio_app", metadata.runtime_manager "pinokio", metadata.pinokio_app_id, source_type "gradio"; agents can run it), not a Gradio embed. Its metadata.pinokio_runtime is { api_name, inputs: one entry per parameter, in order: { "field": "<fabricId>" } (add "file": true for an image or file parameter) or { "value": <fixed value> }, and outputs: the "position" of each returned value that is the result, such as [1] (leave out previews, status lines, and slider updates) }. The Artifact Creator\'s runtime-pinokio.md has the full recipe.' + targetHint
    }
  }
  const stats = await getJson(fetchImpl, `${baseUrl}/system_stats`)
  if (stats && stats.system && typeof stats.system === 'object') {
    return {
      kind: 'comfyui',
      comfyuiVersion: typeof stats.system.comfyui_version === 'string' ? stats.system.comfyui_version : null,
      hint: `ComfyUI in Pinokio: build a Pinokio App artifact (brain_type "pinokio_app", metadata.runtime_manager "pinokio", metadata.pinokio_app_id, source_type "comfyui"; agents can run it), not a plain ComfyUI panel. List and load its saved workflows with fabric:sys.comfyui.workflows (baseUrl: "${baseUrl}"), then store the API-format workflow in metadata.pinokio_runtime.workflow with inputs mapping each fabricId to { node, input }. The Artifact Creator's runtime-pinokio.md has the full recipe.${targetHint}`
    }
  }
  return {
    kind: 'unknown',
    hint: 'Neither ComfyUI nor Gradio answered. If the app has its own HTTP API, use metadata.source_type "custom" and a pinokio_runtime of { "method": "POST", "path": "/its/endpoint" }; the field values are sent as the JSON body.' + targetHint
  }
}
