import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'

const MAX_CLIENT_EVENT_BYTES = 32 * 1024
const MAX_TEXT_LENGTH = 2_000
const MAX_STACK_LENGTH = 4_000

function sanitizeText(value: unknown, maxLength = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, maxLength)
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') return value.slice(0, MAX_TEXT_LENGTH)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    if (depth >= 2) return `[array:${value.length}]`
    return value.slice(0, 20).map((entry) => sanitizeValue(entry, depth + 1))
  }
  if (typeof value === 'object') {
    if (depth >= 2) return '[object]'
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value).slice(0, 40)) {
      output[key.slice(0, 80)] = sanitizeValue(entry, depth + 1)
    }
    return output
  }
  return String(value).slice(0, MAX_TEXT_LENGTH)
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  const raw = await request.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_CLIENT_EVENT_BYTES) {
    return json({ error: 'Client event is too large' }, { status: 413 })
  }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const event = {
    at: new Date().toISOString(),
    userId: user.value.id,
    kind: sanitizeText(body.kind, 120) ?? 'client-event',
    scope: sanitizeText(body.scope, 120),
    message: sanitizeText(body.message),
    path: sanitizeText(body.path, 500),
    phase: sanitizeText(body.phase, 120),
    errorName: sanitizeText(body.errorName, 120),
    stack: sanitizeText(body.stack, MAX_STACK_LENGTH),
    details: sanitizeValue(body.details)
  }

  console.warn('[ClientEvent]', JSON.stringify(event))

  return json({ ok: true })
}
