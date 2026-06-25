import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  abortStream,
  clearN8nPrimaryRun,
  clearSessionTurn,
  clearStreamAbort,
  getActiveN8nPrimaryRun,
  getActiveSessionTurn,
  getActiveStream,
  registerN8nPrimaryRun,
  registerSessionTurn,
  registerStreamAbort
} from '../services/streamAbortRegistry'

describe('streamAbortRegistry', () => {
  afterEach(() => {
    vi.useRealTimers()
    clearSessionTurn('session-1')
    clearSessionTurn('session-2')
    clearStreamAbort('session-1')
    clearStreamAbort('session-2')
    clearN8nPrimaryRun('user-1')
    clearN8nPrimaryRun('user-2')
  })

  it('allows only one active session turn per session', () => {
    const first = registerSessionTurn('session-1', 'single', 'msg-1')
    const duplicate = registerSessionTurn('session-1', 'group')

    expect(first.ok).toBe(true)
    expect(duplicate.ok).toBe(false)
    if (duplicate.ok) return
    expect(duplicate.existing.kind).toBe('single')
    expect(duplicate.existing.messageId).toBe('msg-1')

    clearSessionTurn('session-1')

    const retry = registerSessionTurn('session-1', 'group')
    expect(retry.ok).toBe(true)
    expect(getActiveSessionTurn('session-1')?.kind).toBe('group')
  })

  it('tracks session turns separately from stream abort controllers', () => {
    const controller = new AbortController()

    registerStreamAbort('session-1', 'msg-1', controller)
    registerSessionTurn('session-1', 'single', 'msg-1')

    expect(getActiveStream('session-1')?.messageId).toBe('msg-1')
    expect(getActiveSessionTurn('session-1')?.kind).toBe('single')

    clearSessionTurn('session-1')

    expect(getActiveSessionTurn('session-1')).toBeNull()
    expect(getActiveStream('session-1')?.messageId).toBe('msg-1')
  })

  it('does not clear a session turn for a different message id', () => {
    registerSessionTurn('session-1', 'single', 'msg-1')

    clearSessionTurn('session-1', 'msg-2')

    expect(getActiveSessionTurn('session-1')?.messageId).toBe('msg-1')
  })

  it('releases aborted stream turns after the interrupt grace period', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-07T12:00:00.000Z'))
    const controller = new AbortController()

    registerStreamAbort('session-1', 'msg-1', controller)
    registerSessionTurn('session-1', 'single', 'msg-1')
    expect(abortStream('session-1', 'user')).toEqual({ ok: true, messageId: 'msg-1' })

    vi.advanceTimersByTime(4_999)
    expect(getActiveSessionTurn('session-1')?.messageId).toBe('msg-1')

    vi.advanceTimersByTime(2)
    expect(getActiveSessionTurn('session-1')).toBeNull()
    expect(getActiveStream('session-1')).toBeNull()
  })

  it('keeps setup-only turns briefly before treating them as orphaned', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-07T12:00:00.000Z'))

    registerSessionTurn('session-1', 'single', 'msg-1')

    vi.advanceTimersByTime(119_999)
    expect(getActiveSessionTurn('session-1')?.messageId).toBe('msg-1')

    vi.advanceTimersByTime(2)
    expect(getActiveSessionTurn('session-1')).toBeNull()
  })

  it('allows different sessions to hold independent normal turns', () => {
    const first = registerSessionTurn('session-1', 'single')
    const second = registerSessionTurn('session-2', 'single')

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(getActiveSessionTurn('session-1')?.kind).toBe('single')
    expect(getActiveSessionTurn('session-2')?.kind).toBe('single')
  })

  it('blocks only a second n8n primary run for the same user', () => {
    const first = registerN8nPrimaryRun({
      userId: 'user-1',
      sessionId: 'session-1',
      messageId: 'msg-1',
      agentId: 'agent-1'
    })
    const duplicate = registerN8nPrimaryRun({
      userId: 'user-1',
      sessionId: 'session-2',
      messageId: 'msg-2',
      agentId: 'agent-2'
    })
    const otherUser = registerN8nPrimaryRun({
      userId: 'user-2',
      sessionId: 'session-3',
      messageId: 'msg-3',
      agentId: 'agent-3'
    })

    expect(first.ok).toBe(true)
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) {
      expect(duplicate.existing.sessionId).toBe('session-1')
    }
    expect(otherUser.ok).toBe(true)
    expect(getActiveN8nPrimaryRun('user-1')?.sessionId).toBe('session-1')

    clearN8nPrimaryRun('user-1', 'session-1')

    const retry = registerN8nPrimaryRun({
      userId: 'user-1',
      sessionId: 'session-2',
      messageId: 'msg-2',
      agentId: 'agent-2'
    })

    expect(retry.ok).toBe(true)
    expect(getActiveN8nPrimaryRun('user-1')?.sessionId).toBe('session-2')
  })
})
