/**
 * The ComfyUI proxy's request rules, shared by the plain ComfyUI proxy
 * (`/api/artifacts/comfyui/[...path]`) and the Pinokio app proxy
 * (`/api/artifacts/pinokio/[...path]`) for ComfyUI-kind apps, so the two cannot drift
 * (SA-072 P2, DL-10: ComfyUI artifact code paths do not fork). Moved here unchanged from the
 * ComfyUI route.
 */

export type PromptValidationResult =
  | { ok: true }
  | {
      ok: false
      error: string
      details: Record<string, unknown>
    }

export const COMFY_PROMPT_HINTS = {
  workflowFormatTool: 'Check the fabric:sys.comfyui.workflows output field: workflow_format',
  apiShape: 'ComfyUI /prompt expects API prompt node-map shape: { "3": { class_type, inputs }, ... }',
  uiShape:
    'UI workflow graph shape (nodes/links/definitions) is for planning/analysis and must be converted/exported before submit.'
} as const

export function normalizeWorkflowPath(rawPath: string | undefined): string {
  const trimmed = (rawPath ?? '').trim()
  if (!trimmed) return ''
  return trimmed
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/')
}

export function isAllowedComfyPath(pathname: string): boolean {
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

export function buildTargetUrl(baseUrl: string, requestPath: string, query: URLSearchParams): string {
  const target = new URL(baseUrl)
  const basePath = target.pathname.replace(/\/+$/, '')
  const cleanPath = requestPath.replace(/^\/+/, '')
  const combinedPath = `${basePath}/${cleanPath}`.replace(/\/{2,}/g, '/')
  target.pathname = combinedPath.startsWith('/') ? combinedPath : `/${combinedPath}`
  target.search = query.toString()
  target.hash = ''
  return target.toString()
}

export function buildForwardRequestHeaders(request: Request): Headers {
  const headers = new Headers()
  const accept = request.headers.get('accept')
  if (accept) headers.set('accept', accept)

  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)

  return headers
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function detectPromptShape(payload: unknown): 'api' | 'ui' | 'unknown' {
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

export function validateComfyPromptBody(rawBody: Buffer | undefined): PromptValidationResult {
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
