import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  __resetStreamAbortRegistryForTests,
  abortStream,
  clearSessionTurn,
  getActiveSessionTurn,
  getActiveStream,
  registerSessionTurn,
  registerStreamAbort
} from '../services/streamAbortRegistry'

describe('streamAbortRegistry', () => {
  afterEach(() => {
    vi.useRealTimers()
    // A hard reset, not `clearSessionTurn`: an id-less release no longer deletes a live
    // owned lock, so teardown cannot rely on it.
    __resetStreamAbortRegistryForTests()
  })

  it('allows only one active session turn per session', () => {
    const first = registerSessionTurn('session-1', 'single', 'msg-1')
    const duplicate = registerSessionTurn('session-1', 'group')

    expect(first.ok).toBe(true)
    expect(duplicate.ok).toBe(false)
    if (duplicate.ok) return
    expect(duplicate.existing.kind).toBe('single')
    expect(duplicate.existing.messageId).toBe('msg-1')

    clearSessionTurn('session-1', 'msg-1')

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

    clearSessionTurn('session-1', 'msg-1')

    expect(getActiveSessionTurn('session-1')).toBeNull()
    expect(getActiveStream('session-1')?.messageId).toBe('msg-1')
  })

  it('does not let an unowned release cancel a turn that is still starting', () => {
    // SA-113 F-P1-1. The DM drawer's Stop, the artifact auto-followup and the interrupt
    // route's stale-turn branch all release without a message id. Deleting on their word
    // wiped the lock of a live turn during its setup window, after which the 409 interlock
    // in send-routed is blind and a second turn can start in the same chat.
    registerSessionTurn('session-1', 'single', 'msg-1')

    clearSessionTurn('session-1')

    expect(getActiveSessionTurn('session-1')?.messageId).toBe('msg-1')
  })

  it('still lets the group lane release its own id-less turn', () => {
    // A group turn deliberately registers with no message id, so an id-less release IS its
    // owned release and must keep working.
    registerSessionTurn('session-1', 'group')

    clearSessionTurn('session-1')

    expect(getActiveSessionTurn('session-1')).toBeNull()
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

})
