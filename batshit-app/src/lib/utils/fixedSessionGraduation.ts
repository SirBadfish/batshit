/**
 * SA-104 P6 — Infinite-Session graduation state and window application (client-safe).
 *
 * Graduation is the Infinite-Session window's ONLY relief mechanism (DL-104-07): a
 * completed stretch of conversation moves into the agent's searchable memory (a
 * `memseg:` record, P2) and leaves the live window, replaced by one spliced gist so
 * the narrative never has a hole. The bookmark is an event list riding
 * `session.metadata.fixedSession.graduation` (P0 §5 — the `contextCompaction`
 * precedent; no new Redis key), written ONLY by the server-side graduation writer
 * (`$lib/server/services/memory/memoryGraduation.ts`).
 *
 * `applyFixedSessionGraduationToMessages` is THE window rule. It runs at the same two
 * sites compaction application runs (P0 §1.5): inside the server twin's
 * `buildFormattedChatInput` (load-bearing for approval resumes, which reload raw
 * persisted messages) and inside `buildSessionMessagesForSend` (the one client
 * pre-compile filter every lane, native n8n included, flows through). Application is
 * idempotent — pre-spliced input re-applies as a no-op — and returns the input
 * unchanged for regular sessions (DL-104-12: byte-identical compile).
 *
 * Originals are never destroyed: source messages stay in their Redis keys, the memseg
 * preserves their ids, and only the compiled window excludes them (DL-104-02).
 */

import type { Message } from '$lib/stores/messages.svelte'
import { isFixedSession } from '$lib/utils/fixedSession'

export type FixedSessionGraduationSource =
  | 'nap'
  | 'dreaming'
  | 'idle'
  | 'session_close'
  | 'manual'

export interface FixedSessionGraduationEvent {
  id: string
  createdAt: string
  source: FixedSessionGraduationSource
  /** The episode this event graduated from (open episode for nap step-3 compaction). */
  episodeId: string | null
  /** The searchable memseg record this event's content lives in. */
  segmentId: string
  sourceMessageIds: string[]
  compactedMessageCount: number
  summary: string
  summaryTokenEstimate: number
}

export interface FixedSessionGraduationState {
  version: 1
  events: FixedSessionGraduationEvent[]
}

export interface FixedSessionNapStep3Record {
  segmentId: string
  eventId: string
  compactedMessageCount: number
}

export interface FixedSessionNapRecord {
  id: string
  at: string
  trigger: 'threshold' | 'manual'
  status: 'completed' | 'failed'
  tokensBefore: number | null
  tokensAfter: number | null
  napAtTokens: number | null
  graduatedEpisodeIds: string[]
  segmentIds: string[]
  /** Episodes skipped with a reason (floor protection, recovery hold, empty range). */
  skippedEpisodes: Array<{ episodeId: string; reason: string }>
  rezippedZipCount: number
  compaction: FixedSessionNapStep3Record | null
  error?: string
}

/** Bounded visible nap history on `metadata.fixedSession.naps` (DL-104-07). */
export const FIXED_SESSION_NAP_HISTORY_LIMIT = 20

function isGraduationEvent(value: unknown): value is FixedSessionGraduationEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, any>
  return (
    typeof raw.id === 'string' &&
    typeof raw.createdAt === 'string' &&
    typeof raw.segmentId === 'string' &&
    Array.isArray(raw.sourceMessageIds) &&
    typeof raw.summary === 'string'
  )
}

/** Normalized graduation state from a session record's metadata (never throws). */
export function getFixedSessionGraduationState(
  metadata?: Record<string, any> | null
): FixedSessionGraduationState {
  const raw = metadata?.fixedSession?.graduation
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: 1, events: [] }
  }
  const events = Array.isArray((raw as any).events)
    ? (raw as any).events.filter(isGraduationEvent)
    : []
  return { version: 1, events }
}

export function getGraduatedMessageIds(events: FixedSessionGraduationEvent[]): string[] {
  const ids = new Set<string>()
  for (const event of events) {
    for (const id of event.sourceMessageIds) {
      if (typeof id === 'string' && id.trim()) ids.add(id)
    }
  }
  return Array.from(ids)
}

function describeGraduationSource(source: FixedSessionGraduationSource): string {
  switch (source) {
    case 'nap':
      return 'during a nap'
    case 'dreaming':
      return 'while dreaming'
    case 'idle':
      return 'after an idle gap'
    case 'session_close':
      return 'at session close'
    default:
      return 'manually'
  }
}

export function buildFixedSessionGraduationSummaryContent(
  event: FixedSessionGraduationEvent
): string {
  return [
    'Graduated episode summary:',
    `Batshit graduated ${event.compactedMessageCount} older message${event.compactedMessageCount === 1 ? '' : 's'} ${describeGraduationSource(event.source)} on ${event.createdAt}. The originals are preserved and searchable through your memory tools (segment ${event.segmentId}); only this gist remains in the live window.`,
    '',
    event.summary.trim()
  ].join('\n')
}

/**
 * The spliced window message. It reuses `contextCompactSummary: true` so the existing
 * chat summary-row rendering and every "never compact/trim a summary" skip rule apply
 * unchanged, and carries `fixedSessionGraduation` identity so the two systems stay
 * distinguishable (packet doc §1.1). Compaction's applier keys on
 * `contextCompactEventId`, this one on `fixedSessionGraduationEventId` — no overlap.
 */
export function createFixedSessionGraduationSummaryMessage(
  event: FixedSessionGraduationEvent
): Message {
  return {
    id: `batshit_fixed_graduation_${event.id}`,
    session_id: '',
    user_id: '',
    role: 'system',
    content: buildFixedSessionGraduationSummaryContent(event),
    timestamp: event.createdAt,
    created_at: event.createdAt,
    metadata: {
      contextCompactSummary: true,
      fixedSessionGraduation: true,
      fixedSessionGraduationEventId: event.id,
      episodeId: event.episodeId,
      segmentId: event.segmentId,
      compactedMessageCount: event.compactedMessageCount,
      sourceMessageIds: event.sourceMessageIds
    }
  }
}

/**
 * Apply the graduation bookmark to a message list: excluded source messages drop out,
 * one gist message splices in at each event's first source position. Mirrors
 * `applyContextCompactionToMessages` (the proven shape) including idempotency and the
 * orphaned-event fallback (events whose sources are all absent still contribute their
 * gist at the front so history stays honest).
 */
export function applyFixedSessionGraduationToMessages(
  messages: Message[],
  session: unknown
): Message[] {
  if (!isFixedSession(session)) return messages
  const metadata = (session as Record<string, any>)?.metadata as Record<string, any> | undefined
  const events = getFixedSessionGraduationState(metadata ?? null).events
  if (!events.length) return messages

  const sortedEvents = [...events].sort((a, b) => {
    const aTime = Date.parse(a.createdAt)
    const bTime = Date.parse(b.createdAt)
    return (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0)
  })
  const messageIds = new Set(messages.map((message) => message.id))
  const sourceToEvent = new Map<string, FixedSessionGraduationEvent>()
  for (const event of sortedEvents) {
    for (const id of event.sourceMessageIds) {
      if (messageIds.has(id) && !sourceToEvent.has(id)) {
        sourceToEvent.set(id, event)
      }
    }
  }

  const insertedEventIds = new Set<string>(
    messages
      .map((message) =>
        typeof message.metadata?.fixedSessionGraduationEventId === 'string'
          ? message.metadata.fixedSessionGraduationEventId
          : ''
      )
      .filter(Boolean)
  )
  const output: Message[] = []
  for (const message of messages) {
    const event = sourceToEvent.get(message.id)
    if (!event) {
      output.push(message)
      continue
    }
    if (!insertedEventIds.has(event.id)) {
      const summaryMessage = createFixedSessionGraduationSummaryMessage(event)
      output.push({
        ...summaryMessage,
        session_id: message.session_id,
        user_id: message.user_id
      })
      insertedEventIds.add(event.id)
    }
  }

  for (const event of sortedEvents) {
    if (!insertedEventIds.has(event.id) && event.sourceMessageIds.length > 0) {
      output.unshift(createFixedSessionGraduationSummaryMessage(event))
      insertedEventIds.add(event.id)
    }
  }

  return output
}

function isNapRecord(value: unknown): value is FixedSessionNapRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, any>
  return typeof raw.id === 'string' && typeof raw.at === 'string' && typeof raw.status === 'string'
}

/** Normalized nap history from a session record's metadata (newest last). */
export function getFixedSessionNapRecords(
  metadata?: Record<string, any> | null
): FixedSessionNapRecord[] {
  const raw = metadata?.fixedSession?.naps
  if (!Array.isArray(raw)) return []
  return raw.filter(isNapRecord)
}
