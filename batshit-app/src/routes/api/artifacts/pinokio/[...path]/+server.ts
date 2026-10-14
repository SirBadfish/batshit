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
const BATSHIT_QUERY_KEYS = ['artifactId', 'userId', 'timeoutMs', 'app']

function parseTimeoutMs(rawValue: string | null): number {
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

  const endpoint = await resolvePinokioAppEndpoint(binding.appId)
  if (!endpoint.ok) {
    return json(
      {
        success: false,
        code: endpoint.code,
        error: endpoint.message,
        artifactId: access.artifact.id,
        app: { id: endpoint.appId, title: endpoint.title, state: endpoint.state ?? null },
        ...(endpoint.reason ? { reason: endpoint.reason } : {})
      },
      { status: endpoint.status }
    )
  }

  const upstreamQuery = new URLSearchParams(url.search)
  for (const key of BATSHIT_QUERY_KEYS) upstreamQuery.delete(key)
  const targetUrl = buildTargetUrl(endpoint.baseUrl, requestPath, upstreamQuery)
  const timeoutMs = parseTimeoutMs(url.searchParams.get('timeoutMs'))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers: buildForwardRequestHeaders(request),
      body: rawBody,
      signal: controller.signal
    })
    return new Response(upstream.body, { status: upstream.status, headers: forwardResponseHeaders(upstream, binding.appId) })
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'AbortError'
    return json(
      {
        success: false,
        code: 'app_unreachable',
        error: timedOut
          ? `${endpoint.title} did not answer within ${timeoutMs} ms.`
          : `${endpoint.title} did not answer: ${error instanceof Error ? error.message : 'unknown error'}.`,
        app: { id: binding.appId, title: endpoint.title }
      },
      { status: timedOut ? 504 : 502 }
    )
  } finally {
    clearTimeout(timer)
  }
}

export const GET: RequestHandler = async ({ request, locals, url, params }) =>
  handlePinokioProxy(request, locals.user?.id ?? null, url, params.path)

export const POST: RequestHandler = async ({ request, locals, url, params }) =>
  handlePinokioProxy(request, locals.user?.id ?? null, url, params.path)
