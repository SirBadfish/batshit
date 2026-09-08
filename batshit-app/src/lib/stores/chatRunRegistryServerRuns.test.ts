import { afterEach, describe, expect, it } from 'vitest'

import {
  applyServerRunStatus,
  clearRunRegistryForTest,
  getActiveRunStates,
  getRunState,
  isSessionBusy,
  markStreaming,
  startRun
} from './chatRunRegistry.svelte'
import { evaluateActiveChatCapacity } from '$lib/utils/activeChatCapacity'

/**
 * SA-113 P1 (DL-113-06) — server-started runs in the run registry.
 *
 * Recon 2.4: the run spinner and the three-active-chats cap both read this registry, and
 * it was filled ONLY by the browser's own send path. A woken turn therefore showed no
 * spinner and counted for nothing. These pin the hydration and the one rule that keeps it
 * from stomping a run the user started.
 */

describe('applyServerRunStatus', () => {
  afterEach(() => {
    clearRunRegistryForTest()
  })

  it('marks a session busy so the sidebar spinner shows for a woken turn', () => {
    expect(isSessionBusy('woken')).toBe(false)
    applyServerRunStatus({ sessionId: 'woken', status: 'running' })
    expect(isSessionBusy('woken')).toBe(true)
    expect(getRunState('woken').owner).toBe('server')
    expect(getRunState('woken').status).toBe('streaming')
  })

  it('carries a tooling status through so the spinner label matches', () => {
    applyServerRunStatus({ sessionId: 'woken', status: 'tooling' })
    expect(getRunState('woken').status).toBe('tooling')
  })

  it('counts toward the three-active-chats cap', () => {
    applyServerRunStatus({ sessionId: 'woken-a', status: 'running' })
    applyServerRunStatus({ sessionId: 'woken-b', status: 'running' })
    applyServerRunStatus({ sessionId: 'woken-c', status: 'running' })

    const decision = evaluateActiveChatCapacity({
      activeRuns: getActiveRunStates(),
      currentSessionId: 'a-different-chat'
    })
    expect(decision.allowed).toBe(false)
  })

  it('clears the session on every terminal status', () => {
    for (const status of ['complete', 'failed', 'stopped'] as const) {
      applyServerRunStatus({ sessionId: 'woken', status: 'running' })
      expect(isSessionBusy('woken')).toBe(true)
      applyServerRunStatus({ sessionId: 'woken', status })
      expect(isSessionBusy('woken')).toBe(false)
    }
  })

  it('records a failure so the chat can say what happened', () => {
    applyServerRunStatus({ sessionId: 'woken', status: 'running' })
    applyServerRunStatus({ sessionId: 'woken', status: 'failed' })
    expect(getRunState('woken').lastError).toBe('The woken turn failed.')
  })

  it('never stomps a run the user started in the same chat', () => {
    startRun({ sessionId: 'mine', transport: 'api', activeMessageId: 'msg-1' })
    markStreaming('mine', 'msg-1')

    applyServerRunStatus({ sessionId: 'mine', status: 'running' })
    expect(getRunState('mine').owner).toBe('client')

    applyServerRunStatus({ sessionId: 'mine', status: 'complete' })
    expect(isSessionBusy('mine')).toBe(true)
    expect(getRunState('mine').owner).toBe('client')
  })

  it('ignores a terminal status for a session it never owned', () => {
    applyServerRunStatus({ sessionId: 'never-woken', status: 'complete' })
    expect(getRunState('never-woken').status).toBe('idle')
    expect(getRunState('never-woken').lastError).toBeNull()
  })

  it('ignores a blank session id', () => {
    applyServerRunStatus({ sessionId: '   ', status: 'running' })
    expect(getActiveRunStates()).toHaveLength(0)
  })
})
