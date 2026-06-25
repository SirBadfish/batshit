import { apiError, forbidden, unauthorized } from '$lib/server/services/apiResponses'
import { redis } from '$lib/server/redis'
import type { User } from '$lib/services/auth.server'
import type { ChatSessionRow } from '$lib/types/database'

type SecurityCheck<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response }

export function requireUser(locals: App.Locals): SecurityCheck<User> {
  if (!locals.user?.id) {
    return { ok: false, response: unauthorized() }
  }

  return { ok: true, value: locals.user }
}

export function requireAdmin(locals: App.Locals): SecurityCheck<User> {
  const user = requireUser(locals)
  if (!user.ok) return user

  if (!user.value.is_admin) {
    return { ok: false, response: forbidden() }
  }

  return user
}

export async function requireOwnedSession(
  sessionId: string | null | undefined,
  userId: string
): Promise<SecurityCheck<ChatSessionRow>> {
  const normalized = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!normalized) {
    return { ok: false, response: apiError('Session ID is required', 400) }
  }

  const session = await redis.getSession(normalized)
  if (!session) {
    return { ok: false, response: apiError('Session not found', 404) }
  }

  if (session.user_id !== userId) {
    return { ok: false, response: forbidden() }
  }

  return { ok: true, value: session }
}

function extractZipUserId(zipData: any): string | null {
  const value = zipData?.metadata?.userId ?? zipData?.metadata?.user_id ?? zipData?.userId ?? zipData?.user_id
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function extractZipSessionId(zipData: any): string | null {
  const value =
    zipData?.metadata?.sessionId ??
    zipData?.metadata?.session_id ??
    zipData?.sessionId ??
    zipData?.session_id
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function canAccessZipData(zipData: any, userId: string): Promise<boolean> {
  if (!zipData || typeof zipData !== 'object') return false

  const zipUserId = extractZipUserId(zipData)
  if (zipUserId) {
    return zipUserId === userId
  }

  const sessionId = extractZipSessionId(zipData)
  if (!sessionId) return false

  const session = await redis.getSession(sessionId)
  return session?.user_id === userId
}

export function normalizeZipIds(rawIds: unknown, maxIds = 100): SecurityCheck<string[]> {
  const ids = Array.isArray(rawIds)
    ? rawIds
    : typeof rawIds === 'string'
      ? rawIds.split(',')
      : []

  const normalized = ids
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter(Boolean)

  if (normalized.length === 0) {
    return { ok: false, response: apiError('No zip IDs provided', 400) }
  }

  if (normalized.length > maxIds) {
    return { ok: false, response: apiError(`Too many zip IDs requested; maximum is ${maxIds}`, 400) }
  }

  return { ok: true, value: normalized }
}
