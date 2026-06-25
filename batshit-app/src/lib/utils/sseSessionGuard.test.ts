import { describe, expect, it } from 'vitest'
import { isSseEventForStaleSession, resolveSseEventSessionId } from './sseSessionGuard'

describe('sseSessionGuard', () => {
  it('resolves session IDs from known SSE event shapes', () => {
    expect(resolveSseEventSessionId({ sessionId: 'session-a' })).toBe('session-a')
    expect(resolveSseEventSessionId({ session_id: 'session-b' })).toBe('session-b')
    expect(resolveSseEventSessionId({ message: { session_id: 'session-c' } })).toBe('session-c')
  })

  it('treats events for another active session as stale', () => {
    expect(isSseEventForStaleSession({ sessionId: 'old-session' }, 'new-session')).toBe(true)
    expect(isSseEventForStaleSession({ sessionId: 'new-session' }, 'new-session')).toBe(false)
  })

  it('does not reject events without session identity or without an active current session', () => {
    expect(isSseEventForStaleSession({ type: 'chunk' }, 'new-session')).toBe(false)
    expect(isSseEventForStaleSession({ sessionId: 'old-session' }, null)).toBe(false)
  })
})
