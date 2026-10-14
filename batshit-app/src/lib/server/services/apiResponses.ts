import { isHttpError, isRedirect, json } from '@sveltejs/kit'

export function apiError(message: string, status = 500, init: ResponseInit = {}): Response {
  return json({ error: message }, { ...init, status })
}

export function apiFailure(
  message: string,
  status = 500,
  details: Record<string, unknown> = {},
  init: ResponseInit = {}
): Response {
  return json({ ...details, success: false, error: message }, { ...init, status })
}

export function unauthorized(): Response {
  return apiError('Unauthorized', 401)
}

export function forbidden(): Response {
  return apiError('Forbidden', 403)
}

/**
 * A service refusal is a plain Error that carries its own 4xx `status`, and often a `code` and
 * `details` (ArtifactsService's "Artifact save blocked: ..." is one). Rethrown from a route it is
 * not a SvelteKit HttpError, so SvelteKit answered 500 "Internal Error" and the sentence was lost
 * (BL-89 follow-up). This is the answer the route meant: the refusal's own status, its sentence as
 * `error`, and its `code` and `details`.
 *
 * Returns null for everything else: a SvelteKit HttpError or redirect (the route rethrows those
 * unchanged), and any error without a 4xx status or a sentence (the route's own 500 applies, so a
 * server failure's message is never passed to the browser).
 */
export function serviceRefusalResponse(err: unknown): Response | null {
  if (!err || typeof err !== 'object') return null
  if (isHttpError(err) || isRedirect(err)) return null
  const { status, message, code, details } = err as {
    status?: unknown
    message?: unknown
    code?: unknown
    details?: unknown
  }
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 499) return null
  if (typeof message !== 'string' || !message.trim()) return null
  return json(
    {
      success: false,
      error: message,
      ...(typeof code === 'string' && code ? { code } : {}),
      ...(details && typeof details === 'object' ? { details } : {})
    },
    { status }
  )
}
