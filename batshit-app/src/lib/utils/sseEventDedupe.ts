const MAX_SSE_EVENT_IDS_PER_SESSION = 1000

export function resolveSseEventId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const event = data as {
    sseEventId?: unknown
    sse_event_id?: unknown
    metadata?: {
      sseEventId?: unknown
      sse_event_id?: unknown
    } | null
  }

  const candidates = [
    event.sseEventId,
    event.sse_event_id,
    event.metadata?.sseEventId,
    event.metadata?.sse_event_id
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }

  return null
}

export class SseEventDeduper {
  private seenBySession = new Map<string, Set<string>>()

  shouldProcess(sessionId: string, data: unknown): boolean {
    const eventId = resolveSseEventId(data)
    if (!eventId) return true

    const seen = this.seenBySession.get(sessionId) ?? new Set<string>()
    if (seen.has(eventId)) return false

    seen.add(eventId)
    while (seen.size > MAX_SSE_EVENT_IDS_PER_SESSION) {
      const oldest = seen.values().next().value
      if (!oldest) break
      seen.delete(oldest)
    }
    this.seenBySession.set(sessionId, seen)
    return true
  }

  clearSession(sessionId: string) {
    this.seenBySession.delete(sessionId)
  }
}
