import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import { env } from '$env/dynamic/private'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import {
  buildRuntimeUrlAliasMap,
  isRuntimeUrlAliasKey,
  type RuntimeUrlAliasKey,
  type RuntimeExecutionBackend
} from '$lib/utils/runtimeUrlAliases'
import {
  isOpaqueArtifactRuntimeRequest,
  requireArtifactRuntimeClaims,
  resolveArtifactRuntimeClaims
} from '$lib/server/services/artifactRuntimeAuth'

const DEFAULT_PROXY_TIMEOUT_MS = 20_000
const MIN_PROXY_TIMEOUT_MS = 1_000
const MAX_PROXY_TIMEOUT_MS = 60_000
const DEFAULT_BASE_ALIAS: RuntimeUrlAliasKey = 'comfyui_api_desktop'
const FALLBACK_BASE_ALIAS: RuntimeUrlAliasKey = 'comfyui_api_standalone'
const SAFE_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal'])
const DOCKER_SERVICE_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'content-disposition'
]

type ProxyAttempt = {
  targetUrl: string
  success: boolean
  status?: number
  timedOut?: boolean
  error?: string
}

type PromptValidationResult =
  | { ok: true }
  | {
      ok: false
      error: string
      details: Record<string, unknown>
    }

const COMFY_PROMPT_HINTS = {
  workflowFormatTool: 'Check the fabric:sys.comfyui.workflows output field: workflow_format',
  apiShape: 'ComfyUI /prompt expects API prompt node-map shape: { "3": { class_type, inputs }, ... }',
  uiShape:
    'UI workflow graph shape (nodes/links/definitions) is for planning/analysis and must be converted/exported before submit.'
} as const

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

function parseTimeoutMs(rawValue: string | null): number {
  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed)) return DEFAULT_PROXY_TIMEOUT_MS
  return clamp(Math.floor(parsed), MIN_PROXY_TIMEOUT_MS, MAX_PROXY_TIMEOUT_MS)
}

function normalizeWorkflowPath(rawPath: string | undefined): string {
  const trimmed = (rawPath ?? '').trim()
  if (!trimmed) return ''
  return trimmed
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/')
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }

  if (parts[0] === 10) return true
  if (parts[0] === 127) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  return false
}

function isAllowedComfyHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  if (!normalized) return false
  if (SAFE_LOCAL_HOSTS.has(normalized)) return true
  if (env.BATSHIT_CONTAINERIZED === '1' && DOCKER_SERVICE_HOST_PATTERN.test(normalized)) return true
  if (normalized.endsWith('.local')) return true
  if (isPrivateIpv4(normalized)) return true
  return false
}

function normalizeComfyBaseUrl(rawValue: string): string | null {
  const trimmed = rawValue.trim()
  if (!trimmed) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '')
  const hasObjectInfoSuffix = normalizedPath.endsWith('/object_info')
  const basePath = hasObjectInfoSuffix
    ? normalizedPath.slice(0, normalizedPath.length - '/object_info'.length)
    : normalizedPath

  const baseUrl = new URL(parsed.toString())
  baseUrl.pathname = basePath || '/'
  baseUrl.search = ''
  baseUrl.hash = ''

  if (!isAllowedComfyHost(baseUrl.hostname.toLowerCase())) {
    return null
  }

  return baseUrl.toString().replace(/\/$/, '')
}

function buildHostFallbackCandidates(hostname: string): string[] {
  const normalized = hostname.trim().toLowerCase()
  const candidates = [hostname]

  if (normalized === 'host.docker.internal') {
    candidates.push('127.0.0.1', 'localhost')
    return candidates
  }

  if (normalized === '127.0.0.1') {
    candidates.push('localhost', 'host.docker.internal')
    return candidates
  }

  if (normalized === 'localhost') {
    candidates.push('127.0.0.1', 'host.docker.internal')
    return candidates
  }

  return candidates
}

function expandComfyBaseUrlCandidates(baseUrl: string): string[] {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return [baseUrl]
  }

  const expanded: string[] = []
  const seen = new Set<string>()
  for (const hostCandidate of buildHostFallbackCandidates(parsed.hostname)) {
    const candidate = new URL(parsed.toString())
    candidate.hostname = hostCandidate
    const candidateUrl = candidate.toString().replace(/\/$/, '')
    if (seen.has(candidateUrl)) continue
    if (!isAllowedComfyHost(candidate.hostname.toLowerCase())) continue
    seen.add(candidateUrl)
    expanded.push(candidateUrl)
  }

  return expanded.length > 0 ? expanded : [baseUrl]
}

function resolveAliasCandidates(alias: RuntimeUrlAliasKey): string[] {
  const backends: RuntimeExecutionBackend[] = ['local', 'docker_sandbox']
  const seen = new Set<string>()
  const candidates: string[] = []

  for (const backend of backends) {
    const resolved = buildRuntimeUrlAliasMap(backend)[alias]
    const normalized = normalizeComfyBaseUrl(resolved)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    candidates.push(normalized)
  }

  return candidates
}

function buildBaseUrlCandidates(rawBaseUrl: string | null): { baseUrls: string[]; error?: string } {
  const raw = rawBaseUrl?.trim() ?? ''
  const seen = new Set<string>()
  const candidates: string[] = []
  const addCandidate = (candidate: string) => {
    for (const expanded of expandComfyBaseUrlCandidates(candidate)) {
      if (seen.has(expanded)) continue
      seen.add(expanded)
      candidates.push(expanded)
    }
  }

  if (!raw) {
    for (const alias of [DEFAULT_BASE_ALIAS, FALLBACK_BASE_ALIAS]) {
      for (const candidate of resolveAliasCandidates(alias)) {
        addCandidate(candidate)
      }
    }
  } else if (isRuntimeUrlAliasKey(raw)) {
    for (const candidate of resolveAliasCandidates(raw)) {
      addCandidate(candidate)
    }
  } else {
    const normalized = normalizeComfyBaseUrl(raw)
    if (!normalized) {
      return {
        baseUrls: [],
        error:
          'Invalid baseUrl. Use a runtime alias (comfyui_api_desktop/comfyui_api_standalone) or a local/private http(s) ComfyUI URL.'
      }
    }
    addCandidate(normalized)
  }

  if (candidates.length === 0) {
    return {
      baseUrls: [],
      error:
        'No valid ComfyUI base URL candidates were resolved. Verify ComfyUI host/port and proxy baseUrl settings.'
    }
  }

  return { baseUrls: candidates }
}

function isAllowedComfyPath(pathname: string): boolean {
  const normalized = pathname.trim().toLowerCase()
  if (!normalized) return false

  return (
    normalized === 'prompt' ||
    normalized === 'history' ||
    normalized.startsWith('history/') ||
    normalized === 'view' ||
    normalized === 'object_info' ||
    normalized === 'system_stats' ||
    normalized === 'queue' ||
    normalized === 'interrupt' ||
    normalized === 'upload/image' ||
    normalized === 'userdata' ||
    normalized.startsWith('userdata/') ||
    normalized === 'api/userdata' ||
    normalized.startsWith('api/userdata/') ||
    normalized.startsWith('models/')
  )
}

function buildTargetUrl(baseUrl: string, requestPath: string, query: URLSearchParams): string {
  const target = new URL(baseUrl)
  const basePath = target.pathname.replace(/\/+$/, '')
  const cleanPath = requestPath.replace(/^\/+/, '')
  const combinedPath = `${basePath}/${cleanPath}`.replace(/\/{2,}/g, '/')
  target.pathname = combinedPath.startsWith('/') ? combinedPath : `/${combinedPath}`
  target.search = query.toString()
  target.hash = ''
  return target.toString()
}

function buildForwardRequestHeaders(request: Request): Headers {
  const headers = new Headers()
  const accept = request.headers.get('accept')
  if (accept) headers.set('accept', accept)

  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)

  return headers
}

function buildForwardResponseHeaders(upstream: Response, resolvedBaseUrl: string): Headers {
  const headers = new Headers()
  for (const headerName of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(headerName)
    if (value) headers.set(headerName, value)
  }
  headers.set('x-batshit-comfyui-base-url', resolvedBaseUrl)
  return headers
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function detectPromptShape(payload: unknown): 'api' | 'ui' | 'unknown' {
  if (!isRecord(payload)) return 'unknown'

  const maybeUi =
    Array.isArray((payload as { nodes?: unknown }).nodes) &&
    ('links' in payload || 'definitions' in payload || 'last_node_id' in payload || 'last_link_id' in payload)
  if (maybeUi) return 'ui'

  const entries = Object.values(payload)
  const hasApiNode = entries.some((node) => {
    if (!isRecord(node)) return false
    return typeof node.class_type === 'string' && isRecord(node.inputs)
  })

  return hasApiNode ? 'api' : 'unknown'
}

function validateComfyPromptBody(rawBody: Buffer | undefined): PromptValidationResult {
  if (!rawBody || rawBody.length === 0) {
    return {
      ok: false,
      error: 'ComfyUI /prompt requires a JSON body with a prompt payload.',
      details: {
        reason: 'missing_body',
        hints: [
          COMFY_PROMPT_HINTS.workflowFormatTool,
          COMFY_PROMPT_HINTS.apiShape
        ]
      }
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return {
      ok: false,
      error: 'ComfyUI /prompt payload must be valid JSON.',
      details: {
        reason: 'invalid_json',
        hints: [COMFY_PROMPT_HINTS.apiShape]
      }
    }
  }

  if (!isRecord(parsed) || !('prompt' in parsed)) {
    return {
      ok: false,
      error: 'ComfyUI /prompt payload must include a top-level "prompt" object.',
      details: {
        reason: 'missing_prompt_field',
        hints: [COMFY_PROMPT_HINTS.apiShape]
      }
    }
  }

  const promptPayload = parsed.prompt
  const promptShape = detectPromptShape(promptPayload)
  if (promptShape === 'api') {
    return { ok: true }
  }

  if (promptShape === 'ui') {
    return {
      ok: false,
      error:
        'ComfyUI /prompt requires API prompt-format payload. Received UI workflow graph format (nodes/links/definitions). Convert or export to API format before submit.',
      details: {
        reason: 'ui_workflow_not_prompt',
        detectedPromptShape: promptShape,
        expectedPromptShape: 'api',
        hints: [
          COMFY_PROMPT_HINTS.workflowFormatTool,
          COMFY_PROMPT_HINTS.uiShape,
          COMFY_PROMPT_HINTS.apiShape
        ]
      }
    }
  }

  return {
    ok: false,
    error:
      'ComfyUI /prompt requires API prompt-format payload where nodes are keyed objects containing { class_type, inputs }.',
    details: {
      reason: 'unknown_prompt_shape',
      detectedPromptShape: promptShape,
      expectedPromptShape: 'api',
      hints: [
        COMFY_PROMPT_HINTS.workflowFormatTool,
        COMFY_PROMPT_HINTS.apiShape
      ]
    }
  }
}

async function handleComfyUiProxy(request: Request, localsUserId: string | null, url: URL, path: string | undefined) {
  const runtimeClaims = isOpaqueArtifactRuntimeRequest(request)
    ? await requireArtifactRuntimeClaims(request)
    : await resolveArtifactRuntimeClaims(request)
  const auth = runtimeClaims
    ? { userId: runtimeClaims.userId, auth: 'runtime' as const }
    : await resolveNativeToolUser({
        request,
        localsUserId,
        claimedUserId: url.searchParams.get('userId')
      })

  if (!auth) {
    return apiFailure('Unauthorized', 401)
  }

  const requestPath = normalizeWorkflowPath(path)
  if (!requestPath || !isAllowedComfyPath(requestPath)) {
    return json(
      {
        success: false,
        error:
          'Unsupported ComfyUI proxy path. Allowed roots: prompt, history, view, models, userdata, object_info, system_stats, queue, interrupt, upload/image.'
      },
      { status: 400 }
    )
  }

  const baseResult = buildBaseUrlCandidates(url.searchParams.get('baseUrl'))
  if (baseResult.error) {
    return json({ success: false, error: baseResult.error }, { status: 400 })
  }

  const upstreamQuery = new URLSearchParams(url.search)
  upstreamQuery.delete('baseUrl')
  upstreamQuery.delete('userId')
  upstreamQuery.delete('timeoutMs')

  const timeoutMs = parseTimeoutMs(url.searchParams.get('timeoutMs'))
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'POST') {
    return json({ success: false, error: 'Only GET and POST are supported.' }, { status: 405 })
  }

  const attempts: ProxyAttempt[] = []
  const forwardHeaders = buildForwardRequestHeaders(request)
  const rawBody =
    method === 'POST'
      ? Buffer.from(await request.arrayBuffer())
      : undefined

  if (method === 'POST' && requestPath.toLowerCase() === 'prompt') {
    const validation = validateComfyPromptBody(rawBody)
    if (!validation.ok) {
      return json(
        {
          success: false,
          error: validation.error,
          details: validation.details
        },
        { status: 400 }
      )
    }
  }

  for (const baseUrl of baseResult.baseUrls) {
    const targetUrl = buildTargetUrl(baseUrl, requestPath, upstreamQuery)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let upstream: Response

    try {
      upstream = await fetch(targetUrl, {
        method,
        headers: forwardHeaders,
        body: rawBody,
        signal: controller.signal
      })
    } catch (error) {
      clearTimeout(timer)
      const isAbort = error instanceof DOMException && error.name === 'AbortError'
      attempts.push({
        targetUrl,
        success: false,
        timedOut: isAbort,
        error: isAbort
          ? `Request timed out after ${timeoutMs}ms.`
          : `Request failed: ${error instanceof Error ? error.message : 'Unknown error.'}`
      })
      continue
    } finally {
      clearTimeout(timer)
    }

    attempts.push({
      targetUrl,
      success: true,
      status: upstream.status
    })

    return new Response(upstream.body, {
      status: upstream.status,
      headers: buildForwardResponseHeaders(upstream, baseUrl)
    })
  }

  return json(
    {
      success: false,
      error: 'Unable to reach ComfyUI from artifact proxy. Verify ComfyUI is running and baseUrl is correct.',
      attempts
    },
    { status: 502 }
  )
}

export const GET: RequestHandler = async ({ request, locals, url, params }) =>
  handleComfyUiProxy(request, locals.user?.id ?? null, url, params.path)

export const POST: RequestHandler = async ({ request, locals, url, params }) =>
  handleComfyUiProxy(request, locals.user?.id ?? null, url, params.path)
