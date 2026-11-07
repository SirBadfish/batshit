/**
 * SA-072 P2 (DL-10): the same-origin proxy a Pinokio app artifact's panel uses to reach its app.
 *
 * `/api/artifacts/pinokio/<app path>?artifactId=<id>` (the artifact's runtime token names the
 * artifact by itself). The app comes from the artifact's saved `metadata.pinokio_app_id`, so an
 * artifact reaches only its own app. The address is resolved on every call through
 * `pterm status --probe` (kept a few seconds when online); nothing stores a port.
 *
 * - ComfyUI-kind apps follow the ComfyUI proxy's own path allowlist and `/prompt` shape check
 *   (`comfyuiProxyRules.ts`), so the two ComfyUI paths do not fork.
 * - Gradio-kind apps reach the Gradio API (`gradio_api/…`, and the Gradio 4 roots).
 * - Custom-API apps reach any path on the app.
 *
 * An app that is not running answers 503 `{ code: "app_offline", app: { id, title, state } }`,
 * which the Builder Kit turns into a "Start with Pinokio" button (the start itself is the
 * user's click in Batshit's own page, never this route).
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import {
  isOpaqueArtifactRuntimeRequest,
  requireArtifactRuntimeClaims,
  resolveArtifactRuntimeClaims
} from '$lib/server/services/artifactRuntimeAuth'
import {
  buildForwardRequestHeaders,
  buildTargetUrl,
  normalizeWorkflowPath,
  validateComfyPromptBody
} from '$lib/server/artifacts/comfyuiProxyRules'
import { loadPinokioArtifactForUser } from '$lib/server/artifacts/pinokioArtifactAccess'
import { pinokioProxyPathProblem } from '$lib/server/artifacts/pinokioProxyRules'
import { resolvePinokioAppEndpoint } from '$lib/server/services/pinokioAppEndpoint'
import { ownPinokioOperation, pinokioBindingFingerprint } from '$lib/server/services/pinokioAdmission'
import { enterBackupRestoreHttpRequest } from '$lib/server/services/backupRestoreService'

const DEFAULT_PROXY_TIMEOUT_MS = 20_000
const MIN_PROXY_TIMEOUT_MS = 1_000
const MAX_PROXY_TIMEOUT_MS = 60_000
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'content-disposition'
]
/** Batshit's own query parameters, never forwarded to the app. */
const BATSHIT_QUERY_KEYS = ['artifactId', 'userId', 'timeoutMs', 'app', 'machineId', 'revision', 'machineRevision']

function parseTimeoutMs(rawValue: string | null): number {
  if (rawValue === null || !rawValue.trim()) return DEFAULT_PROXY_TIMEOUT_MS
  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed)) return DEFAULT_PROXY_TIMEOUT_MS
  return Math.min(MAX_PROXY_TIMEOUT_MS, Math.max(MIN_PROXY_TIMEOUT_MS, Math.floor(parsed)))
}

function forwardResponseHeaders(upstream: Response, appId: string): Headers {
  const headers = new Headers()
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('x-batshit-pinokio-app', appId)
  return headers
}

async function handlePinokioProxy(request: Request, localsUserId: string | null, url: URL, path: string | undefined) {
  const runtimeClaims = isOpaqueArtifactRuntimeRequest(request)
    ? await requireArtifactRuntimeClaims(request)
    : await resolveArtifactRuntimeClaims(request)
  const auth = runtimeClaims
    ? { userId: runtimeClaims.userId }
    : await resolveNativeToolUser({ request, localsUserId, claimedUserId: url.searchParams.get('userId') })
  if (!auth?.userId) return apiFailure('Unauthorized', 401)

  // A runtime token names its artifact; a second artifact id in the query must agree with it.
  const queryArtifactId = url.searchParams.get('artifactId')?.trim() || null
  if (runtimeClaims && queryArtifactId && queryArtifactId !== runtimeClaims.artifactId) {
    return apiFailure('Artifact runtime token does not match artifact', 403)
  }
  const access = await loadPinokioArtifactForUser(runtimeClaims?.artifactId ?? queryArtifactId, auth.userId)
  if (!access.ok) return json({ success: false, code: access.code, error: access.message }, { status: access.status })
  const { binding } = access

  const requestedApp = url.searchParams.get('app')?.trim()
  if (requestedApp && requestedApp !== binding.appId) {
    return json(
      { success: false, code: 'app_mismatch', error: `This artifact reaches only its own app (${binding.appId}).` },
      { status: 403 }
    )
  }

  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'POST') {
    return json({ success: false, error: 'Only GET and POST are supported.' }, { status: 405 })
  }
  const requestPath = normalizeWorkflowPath(path)
  const pathProblem = pinokioProxyPathProblem(binding.kind, requestPath)
  if (pathProblem) return json({ success: false, code: 'path_not_allowed', error: pathProblem }, { status: 400 })

  const rawBody = method === 'POST' ? Buffer.from(await request.arrayBuffer()) : undefined
  if (binding.kind === 'comfyui' && method === 'POST' && requestPath.toLowerCase() === 'prompt') {
    const validation = validateComfyPromptBody(rawBody)
    if (!validation.ok) {
      return json({ success: false, error: validation.error, details: validation.details }, { status: 400 })
    }
  }

  const requestedMachine = url.searchParams.get('machineId')
  if (requestedMachine !== null && requestedMachine !== (binding.machineId ?? 'local')) {
    return json({ success: false, code: 'machine_mismatch', error: 'This artifact reaches only its saved Pinokio computer.' }, { status: 403 })
  }
  const endWork = enterBackupRestoreHttpRequest()
  if (!endWork) return json({ success: false, code: 'pinokio_restore_in_progress', error: 'Pinokio operations are paused while Batshit restores data.' }, { status: 503 })
  const fingerprint = pinokioBindingFingerprint(access.artifact)
  let operation: ReturnType<typeof ownPinokioOperation> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutMs = parseTimeoutMs(url.searchParams.get('timeoutMs'))
  const controller = new AbortController()
  let finished = false
  let retainedBody = false
  let removeAbort = () => {}
  const finish = () => {
    if (finished) return
    finished = true
    if (timer) clearTimeout(timer)
    removeAbort()
    operation?.close()
    endWork()
  }
  try {
    operation = ownPinokioOperation({ signal: AbortSignal.any([request.signal, controller.signal]), admit: async () => {
      const current = await loadPinokioArtifactForUser(access.artifact.id, auth.userId)
      if (!current.ok || pinokioBindingFingerprint(current.artifact) !== fingerprint ||
        current.binding.appId !== binding.appId || current.binding.machineId !== binding.machineId || current.binding.kind !== binding.kind) {
        throw Object.assign(new Error('This saved Pinokio artifact changed during the request.'), { status: 409 })
      }
    } })
    await operation.assert()
    const endpoint = await resolvePinokioAppEndpoint(binding.appId, { userId: auth.userId, machineId: binding.machineId, signal: operation.signal, admitFetch: () => operation!.assert() })
    if (!endpoint.ok) return json({ success: false, code: endpoint.code, error: endpoint.message, artifactId: access.artifact.id,
      app: { id: endpoint.appId, title: endpoint.title, state: endpoint.state ?? null },
      ...(endpoint.machineId ? { machineId: endpoint.machineId, machineRevision: endpoint.machineRevision } : {}), ...(endpoint.reason ? { reason: endpoint.reason } : {}) }, { status: endpoint.status })
    const requestedRevision = url.searchParams.get('revision') ?? url.searchParams.get('machineRevision')
    if (requestedRevision !== null && requestedRevision !== String(endpoint.machineRevision ?? 0)) return json({ success: false, code: 'machine_mismatch', error: 'The saved Pinokio computer changed; run the artifact again.' }, { status: 409 })
    if (binding.machineId && !endpoint.fetch) throw new Error('The remote app has no bound request policy.')
    const upstreamQuery = new URLSearchParams(url.search)
    for (const key of BATSHIT_QUERY_KEYS) upstreamQuery.delete(key)
    const targetUrl = buildTargetUrl(endpoint.baseUrl, requestPath, upstreamQuery)
    timer = setTimeout(() => controller.abort('pinokio_proxy_timeout'), timeoutMs)
    await operation.assert()
    const upstream = await (endpoint.fetch ?? fetch)(targetUrl, { method, headers: buildForwardRequestHeaders(request), body: rawBody, signal: operation.signal })
    const headers = forwardResponseHeaders(upstream, binding.appId)
    if (!upstream.body) return new Response(null, { status: upstream.status, headers })
    const reader = upstream.body.getReader()
    const abortBody = () => { void reader.cancel(operation!.signal.reason).catch(() => {}).finally(finish) }
    operation.signal.addEventListener('abort', abortBody, { once: true })
    removeAbort = () => operation!.signal.removeEventListener('abort', abortBody)
    const body = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          operation!.signal.throwIfAborted()
          const part = await reader.read()
          operation!.signal.throwIfAborted()
          if (part.done) { output.close(); finish() }
          else output.enqueue(part.value)
        } catch (error) { output.error(error); await reader.cancel(error).catch(() => {}); finish() }
      },
      async cancel(reason) {
        controller.abort(reason)
        try { await reader.cancel(reason) } finally { finish() }
      }
    })
    retainedBody = true
    return new Response(body, { status: upstream.status, headers })
  } catch (error) {
    const timedOut = controller.signal.aborted && !request.signal.aborted
    return json({ success: false, code: 'app_unreachable', error: timedOut ? `The Pinokio app did not answer within ${timeoutMs} ms.` : error instanceof Error ? error.message : 'The Pinokio app did not answer.', app: { id: binding.appId } }, { status: timedOut ? 504 : 502 })
  } finally { if (!retainedBody) finish() }

}

export const GET: RequestHandler = async ({ request, locals, url, params }) =>
  handlePinokioProxy(request, locals.user?.id ?? null, url, params.path)

export const POST: RequestHandler = async ({ request, locals, url, params }) =>
  handlePinokioProxy(request, locals.user?.id ?? null, url, params.path)
