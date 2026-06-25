import { json } from '@sveltejs/kit'

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
