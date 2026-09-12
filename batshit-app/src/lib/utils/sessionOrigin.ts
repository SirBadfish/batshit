/**
 * SA-113 P1 (DL-113-08) — THE rule for "what started this chat".
 *
 * Almost every Batshit session is started by the user typing. A few are not: a wake-up
 * DM from another agent, or a wake-up webhook. `metadata.origin` records which, so the
 * sidebar can show a small pill, the chat can show a one-line banner, and a filter or
 * auto-folder stays a cheap later change.
 *
 * Two rules matter as much as the shape:
 *
 *  1. **The server owns it.** `POST /api/sessions` is cookie-authenticated and spreads
 *     the request body straight into the record, so a browser could otherwise forge an
 *     origin. The route strips any client-supplied `origin`; only the wake primitive
 *     writes one.
 *  2. **It survives read-spread-write.** `redis.updateSession` replaces `metadata`
 *     wholesale, so a caller that read a session before the wake wrote its origin would
 *     silently strip it on the next agent switch. `resolveSessionOriginMetadataUpdate`
 *     re-attaches the stored block, exactly like `resolveFixedSessionMetadataUpdate`
 *     does for Infinite Sessions.
 *
 * Restating the metadata check anywhere else is a Fragility-Map-class drift risk.
 *
 * No `$lib/server` imports: the sidebar and the chat page load this in the browser.
 */

import { WAKE_SESSION_NAME_MAX_CHARS } from '$lib/utils/dmControl'

export const SESSION_ORIGIN_SCHEMA_VERSION = 1 as const

/**
 * The three sources that can start a chat with nobody typing. A user-typed session has no
 * `origin` block at all.
 *
 * SA-115 added `'schedule'`. Every place that reads a kind is a **lookup keyed by kind**
 * with a neutral fallback, never a binary if/else: the two ternaries that used to live
 * below would have quietly labelled every schedule "Hook", and the sidebar's icon still
 * has to learn the same lesson (`SessionItem.svelte`, P2).
 */
export const SESSION_ORIGIN_KINDS = ['dm', 'webhook', 'schedule'] as const
export type SessionOriginKind = (typeof SESSION_ORIGIN_KINDS)[number]

/** What an origin of each kind is called when its own label is missing. */
const ORIGIN_FALLBACK_LABELS: Record<SessionOriginKind, string> = {
  dm: 'another agent',
  webhook: 'a webhook',
  schedule: 'a schedule'
}

function fallbackLabelFor(kind: SessionOriginKind): string {
  return ORIGIN_FALLBACK_LABELS[kind] ?? 'Batshit'
}

export interface SessionOrigin {
  version: typeof SESSION_ORIGIN_SCHEMA_VERSION
  kind: SessionOriginKind
  /** Human-readable, frozen at creation: "Cooper", or a webhook's name. */
  label: string
  /** The sending agent, for `kind: 'dm'`. */
  agentId?: string
  dmId?: string
  hookId?: string
  /** The schedule that fired, for `kind: 'schedule'`. */
  scheduleId?: string
  at: string
  /** How deep in a wake chain this session sits. 0 means a human or a webhook started it. */
  chainDepth: number
}

function readTrimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * THE reader. Returns a normalized origin, or null for an ordinary user-started session.
 * Tolerant of a missing `version` so a record written by an older build still reads.
 */
export function resolveSessionOrigin(session: unknown): SessionOrigin | null {
  if (!session || typeof session !== 'object') return null
  const metadata = (session as Record<string, any>).metadata
  if (!metadata || typeof metadata !== 'object') return null
  const raw = (metadata as Record<string, any>).origin
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const record = raw as Record<string, any>
  const kind = readTrimmed(record.kind)
  if (!kind || !(SESSION_ORIGIN_KINDS as readonly string[]).includes(kind)) return null

  const chainDepthRaw = record.chainDepth ?? record.chain_depth
  const chainDepth =
    typeof chainDepthRaw === 'number' && Number.isFinite(chainDepthRaw)
      ? Math.max(0, Math.floor(chainDepthRaw))
      : 0

  return {
    version: SESSION_ORIGIN_SCHEMA_VERSION,
    kind: kind as SessionOriginKind,
    label: readTrimmed(record.label) ?? fallbackLabelFor(kind as SessionOriginKind),
    ...(readTrimmed(record.agentId ?? record.agent_id)
      ? { agentId: readTrimmed(record.agentId ?? record.agent_id)! }
      : {}),
    ...(readTrimmed(record.dmId ?? record.dm_id)
      ? { dmId: readTrimmed(record.dmId ?? record.dm_id)! }
      : {}),
    ...(readTrimmed(record.hookId ?? record.hook_id)
      ? { hookId: readTrimmed(record.hookId ?? record.hook_id)! }
      : {}),
    ...(readTrimmed(record.scheduleId ?? record.schedule_id)
      ? { scheduleId: readTrimmed(record.scheduleId ?? record.schedule_id)! }
      : {}),
    at: readTrimmed(record.at) ?? '',
    chainDepth
  }
}

/** Convenience for surfaces that only need "was this started by the user?". */
export function isWokenSession(session: unknown): boolean {
  return resolveSessionOrigin(session) !== null
}

export function buildSessionOrigin(input: {
  kind: SessionOriginKind
  label: string
  agentId?: string | null
  dmId?: string | null
  hookId?: string | null
  scheduleId?: string | null
  chainDepth: number
  now?: Date
}): SessionOrigin {
  return {
    version: SESSION_ORIGIN_SCHEMA_VERSION,
    kind: input.kind,
    label: input.label.trim().slice(0, 120) || fallbackLabelFor(input.kind),
    ...(readTrimmed(input.agentId) ? { agentId: readTrimmed(input.agentId)! } : {}),
    ...(readTrimmed(input.dmId) ? { dmId: readTrimmed(input.dmId)! } : {}),
    ...(readTrimmed(input.hookId) ? { hookId: readTrimmed(input.hookId)! } : {}),
    ...(readTrimmed(input.scheduleId) ? { scheduleId: readTrimmed(input.scheduleId)! } : {}),
    at: (input.now ?? new Date()).toISOString(),
    chainDepth: Math.max(0, Math.floor(input.chainDepth))
  }
}

/** Sidebar pill tooltip and chat banner text — one wording, used by both surfaces. */
export function describeSessionOrigin(origin: SessionOrigin): string {
  switch (origin.kind) {
    case 'dm':
      return `Started by a DM from ${origin.label}`
    case 'webhook':
      return `Started by webhook "${origin.label}"`
    case 'schedule':
      return `Started by the "${origin.label}" schedule`
    default:
      return 'Started by Batshit'
  }
}

/** The icon-only sidebar pill's short label. */
export function sessionOriginPillLabel(origin: SessionOrigin): string {
  switch (origin.kind) {
    case 'dm':
      return 'DM'
    case 'webhook':
      return 'Hook'
    case 'schedule':
      return 'Clock'
    default:
      return 'Auto'
  }
}

/** DL-113-08: a meaningful auto-name instead of a bare timestamp. */
export function buildWokenSessionName(input: {
  kind: SessionOriginKind
  label: string
  subject?: string | null
}): string {
  const label = input.label.trim() || fallbackLabelFor(input.kind)
  const subject = readTrimmed(input.subject)
  let name: string
  switch (input.kind) {
    case 'dm':
      name = subject ? `DM from ${label}: ${subject}` : `DM from ${label}`
      break
    case 'schedule':
      name = `Schedule: ${label}`
      break
    default:
      name = `Webhook: ${label}`
      break
  }
  return name.length > WAKE_SESSION_NAME_MAX_CHARS
    ? `${name.slice(0, WAKE_SESSION_NAME_MAX_CHARS - 1).trimEnd()}…`
    : name
}

export type SessionOriginUpdateResolution =
  | { ok: true; metadata: Record<string, any> | undefined }
  | { ok: false; error: string }

/**
 * Generic `PUT /api/sessions/[id]` cannot create, change, or remove an origin: it is
 * written once by the server at creation and is a fact about history.
 *
 * Four branches, mirroring `resolveFixedSessionMetadataUpdate`:
 *  - incoming metadata absent  → leave `updates.metadata` alone
 *  - incoming metadata invalid → reject
 *  - no stored origin          → reject a client-supplied one, otherwise pass through
 *  - stored origin present     → re-attach it when omitted; reject a DIFFERENT one
 */
export function resolveSessionOriginMetadataUpdate(
  existingMetadata: unknown,
  incomingMetadata: unknown
): SessionOriginUpdateResolution {
  if (incomingMetadata === undefined) return { ok: true, metadata: undefined }
  if (
    incomingMetadata === null ||
    typeof incomingMetadata !== 'object' ||
    Array.isArray(incomingMetadata)
  ) {
    return { ok: false, error: 'Session metadata must be an object.' }
  }

  const incoming = incomingMetadata as Record<string, any>
  const existing =
    existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata)
      ? (existingMetadata as Record<string, any>)
      : {}

  const storedOrigin = existing.origin
  const hasStored = Boolean(storedOrigin && typeof storedOrigin === 'object')
  const incomingOrigin = incoming.origin
  const hasIncoming = incomingOrigin !== undefined

  if (!hasStored) {
    if (hasIncoming && incomingOrigin !== null) {
      return {
        ok: false,
        error: 'Session origin is set by Batshit when a wake-up starts a chat and cannot be added afterwards.',
        }
    }
    return { ok: true, metadata: incoming }
  }

  if (!hasIncoming) {
    // The common read-spread-write case: re-attach silently.
    return { ok: true, metadata: { ...incoming, origin: storedOrigin } }
  }

  if (JSON.stringify(incomingOrigin) !== JSON.stringify(storedOrigin)) {
    return {
      ok: false,
      error: 'Session origin records what started this chat and cannot be changed or removed.'
    }
  }

  return { ok: true, metadata: incoming }
}

/**
 * `POST /api/sessions` spreads the request body into the record, so the create route
 * strips any client-supplied origin before it reaches Redis. Returns metadata safe to
 * store, or `undefined` when there was none.
 */
export function stripClientSuppliedOrigin(
  metadata: unknown
): Record<string, any> | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return metadata === undefined ? undefined : (metadata as any)
  }
  const record = metadata as Record<string, any>
  if (!('origin' in record)) return record
  const { origin: _ignored, ...rest } = record
  return rest
}
