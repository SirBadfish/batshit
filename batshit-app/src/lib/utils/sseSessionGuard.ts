export function resolveSseEventSessionId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null

  const event = data as {
    sessionId?: unknown
    session_id?: unknown
    message?: { session_id?: unknown } | null
  }

  if (typeof event.sessionId === 'string' && event.sessionId.trim()) {
    return event.sessionId.trim()
  }
  if (typeof event.session_id === 'string' && event.session_id.trim()) {
    return event.session_id.trim()
  }
  if (event.message && typeof event.message.session_id === 'string' && event.message.session_id.trim()) {
    return event.message.session_id.trim()
  }

  return null
}

export function isSseEventForStaleSession(data: unknown, currentSessionId: string | null): boolean {
  if (!currentSessionId) return false
  const eventSessionId = resolveSseEventSessionId(data)
  return Boolean(eventSessionId && eventSessionId !== currentSessionId)
}
