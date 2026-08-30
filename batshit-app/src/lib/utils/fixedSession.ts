/**
 * SA-104 P5 — Infinite Session state (client-safe).
 *
 * An Infinite Session is an opt-in persistent session type: one agent living in one
 * ongoing conversation (DL-104-12). The state rides `session.metadata.fixedSession`
 * (P0 §5 — the `metadata.contextCompaction` precedent; no new Redis key), and the
 * choice is ONE-WAY: there is no unfix path anywhere in the product.
 *
 * `isFixedSession` is THE rule. Every surface (sidebar section, session menu, route
 * guards, send-routed group refusal, group picker, episode helpers) derives from it;
 * restating the metadata check elsewhere is a Fragility-Map-class drift risk — the
 * same discipline as `resolveAgentMemoryEnabled`.
 */

export const FIXED_SESSION_SCHEMA_VERSION = 1 as const

export interface FixedSessionMetadata {
  version: typeof FIXED_SESSION_SCHEMA_VERSION
  enabled: true
  created_at: string
}

/** True when the session record (or a session-shaped object) is an Infinite Session. */
export function isFixedSession(session: unknown): boolean {
  if (!session || typeof session !== 'object') return false
  const metadata = (session as Record<string, any>).metadata
  if (!metadata || typeof metadata !== 'object') return false
  const fixed = (metadata as Record<string, any>).fixedSession
  return Boolean(fixed && typeof fixed === 'object' && (fixed as Record<string, any>).enabled === true)
}

/** The one agent an Infinite Session was saved with, including legacy metadata fields. */
export function resolveFixedSessionAgentId(session: unknown): string | null {
  if (!isFixedSession(session)) return null
  const record = session as Record<string, any>
  const metadata = record.metadata as Record<string, any>
  for (const value of [
    record.agent_id,
    metadata.last_agent_id,
    metadata.lastAgentId,
    metadata.agent_id,
    metadata.agentId
  ]) {
    if (typeof value !== 'string') continue
    const id = value.trim()
    if (id) return id
  }
  return null
}

/** The stored block written exactly once by the one-way transition route. */
export function buildFixedSessionMetadata(now: Date = new Date()): FixedSessionMetadata {
  return {
    version: FIXED_SESSION_SCHEMA_VERSION,
    enabled: true,
    created_at: now.toISOString()
  }
}

export type FixedSessionUpdateResolution =
  | { ok: true; metadata: Record<string, any> | undefined }
  | { ok: false; error: string }

/**
 * The `PUT /api/sessions/[id]` immutability guard (one-way enforcement, DL-104-12).
 * `redis.updateSession` replaces `metadata` wholesale, so the generic update path
 * must never be able to add, remove, or alter the stored `fixedSession` block:
 *
 * - incoming metadata omitted entirely → untouched (top-level merge keeps existing).
 * - incoming metadata present but MISSING `fixedSession` while the stored session has
 *   one → the stored block is silently re-attached (a legitimate read-spread-write
 *   caller holding a pre-fix snapshot must not strip it).
 * - incoming `fixedSession` differing from the stored one (including adding one) →
 *   rejected; the transition happens only through the dedicated fixed route, and
 *   unfixing never happens.
 * - a metadata write adding `group_chat` to an Infinite Session → rejected (DL-104-12:
 *   group-chat Infinite Sessions are unsupported in v1).
 */
export function resolveFixedSessionMetadataUpdate(
  existingMetadata: unknown,
  incomingMetadata: unknown
): FixedSessionUpdateResolution {
  if (incomingMetadata === undefined) return { ok: true, metadata: undefined }
  if (!incomingMetadata || typeof incomingMetadata !== 'object' || Array.isArray(incomingMetadata)) {
    return { ok: false, error: 'Session metadata must be an object.' }
  }

  const existingFixed =
    existingMetadata && typeof existingMetadata === 'object'
      ? (existingMetadata as Record<string, any>).fixedSession
      : undefined
  const incoming = incomingMetadata as Record<string, any>
  const incomingFixed = incoming.fixedSession

  if (existingFixed === undefined) {
    if (incomingFixed !== undefined) {
      return {
        ok: false,
        error:
          'Infinite Session state can only be set through the dedicated Infinite Session action, not a generic session update.'
      }
    }
    return { ok: true, metadata: incoming }
  }

  if (incomingFixed === undefined) {
    if (incoming.group_chat) {
      return {
        ok: false,
        error: 'Infinite Sessions do not support group chat. Use a regular session for groups.'
      }
    }
    return { ok: true, metadata: { ...incoming, fixedSession: existingFixed } }
  }

  if (JSON.stringify(incomingFixed) !== JSON.stringify(existingFixed)) {
    return {
      ok: false,
      error: 'Infinite Session state is one-way and cannot be changed or removed.'
    }
  }
  if (incoming.group_chat) {
    return {
      ok: false,
      error: 'Infinite Sessions do not support group chat. Use a regular session for groups.'
    }
  }
  return { ok: true, metadata: incoming }
}
