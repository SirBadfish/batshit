import { afterEach, describe, expect, it } from 'vitest'

import {
  clearRunRegistryForTest,
  getActiveRunStates,
  markComplete,
  startRun
} from '$lib/stores/chatRunRegistry.svelte'
import {
  evaluateActiveChatCapacity,
  MAX_PARALLEL_ACTIVE_CHAT_RUNS
} from './activeChatCapacity'

describe('evaluateActiveChatCapacity', () => {
  afterEach(() => {
    clearRunRegistryForTest()
  })

  it('allows a third active chat but blocks a fourth new chat', () => {
    startRun({ sessionId: 'session-a', transport: 'api', activeMessageId: 'msg-a' })
    startRun({ sessionId: 'session-b', transport: 'cli', activeMessageId: 'msg-b' })

    expect(
      evaluateActiveChatCapacity({
        activeRuns: getActiveRunStates(),
        currentSessionId: 'session-c'
      })
    ).toEqual({ allowed: true })

    startRun({ sessionId: 'session-c', transport: 'api', activeMessageId: 'msg-c' })
    const decision = evaluateActiveChatCapacity({
      activeRuns: getActiveRunStates(),
      currentSessionId: 'session-d'
    })

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.activeRunCount).toBe(MAX_PARALLEL_ACTIVE_CHAT_RUNS)
      expect(decision.reason).toBe('active-chat-capacity')
    }
  })

  it('allows a same-session follow-up because it does not increase active chat count', () => {
    startRun({ sessionId: 'session-a', transport: 'api', activeMessageId: 'msg-a' })
    startRun({ sessionId: 'session-b', transport: 'cli', activeMessageId: 'msg-b' })
    startRun({ sessionId: 'session-c', transport: 'api', activeMessageId: 'msg-c' })

    expect(
      evaluateActiveChatCapacity({
        activeRuns: getActiveRunStates(),
        currentSessionId: 'session-b'
      })
    ).toEqual({ allowed: true })
  })

  it('releases capacity as soon as an active run completes', () => {
    startRun({ sessionId: 'session-a', transport: 'api', activeMessageId: 'msg-a' })
    startRun({ sessionId: 'session-b', transport: 'cli', activeMessageId: 'msg-b' })
    startRun({ sessionId: 'session-c', transport: 'api', activeMessageId: 'msg-c' })

    expect(
      evaluateActiveChatCapacity({
        activeRuns: getActiveRunStates(),
        currentSessionId: 'session-d'
      }).allowed
    ).toBe(false)

    markComplete('session-b')

    expect(
      evaluateActiveChatCapacity({
        activeRuns: getActiveRunStates(),
        currentSessionId: 'session-d'
      })
    ).toEqual({ allowed: true })
  })
})
