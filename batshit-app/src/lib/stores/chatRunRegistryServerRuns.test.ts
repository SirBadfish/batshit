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

/**
 * SA-114 P3 (DL-114-09) — steerability travels with the run.
 *
 * `requestAgentWakeup` publishes `running` before the transport is known, and send-routed
 * publishes a SECOND `running` once it is. The second must be able to fill the verdict in
 * without the first having blanked it, and neither may erase it on the way past.
 */
describe('steerability on a server run', () => {
  afterEach(() => {
    clearRunRegistryForTest()
  })

  it('starts unknown, which the send button reads as "assume steerable"', () => {
    applyServerRunStatus({ sessionId: 'woken', status: 'running' })
    expect(getRunState('woken').steerable).toBeNull()
    expect(getRunState('woken').steerReason).toBeNull()
  })

  it('fills the verdict in from the second running publish', () => {
    applyServerRunStatus({ sessionId: 'woken', status: 'running' })
    applyServerRunStatus({
      sessionId: 'woken',
      status: 'running',
      steerable: false,
      steerReason: 'This Codex agent runs on the one-shot exec transport.'
    })
    expect(getRunState('woken').steerable).toBe(false)
    expect(getRunState('woken').steerReason).toContain('exec transport')
  })

  it('does not lose a known verdict when a later event omits it', () => {
    applyServerRunStatus({ sessionId: 'woken', status: 'running', steerable: false, steerReason: 'no' })
    applyServerRunStatus({ sessionId: 'woken', status: 'tooling' })
    expect(getRunState('woken').steerable).toBe(false)
    expect(getRunState('woken').steerReason).toBe('no')
  })

  /**
   * F-P3-2 (Faye's review): a steer needs the ASSISTANT message id of the reply it is aimed
   * at, and a tab that did not start the reply learns that id only from the `start` event —
   * which the API lane sends with its first chunk, seconds after the run is registered. A
   * Steer click in that window had no target and fell through to an interrupt. send-routed
   * now puts the id on `session_run_status`, and the registry keeps it.
   */
  it('keeps the assistant message id a server run reports', () => {
    applyServerRunStatus({ sessionId: 'woken', status: 'running' })
    expect(getRunState('woken').activeMessageId).toBeNull()

    applyServerRunStatus({ sessionId: 'woken', status: 'running', messageId: 'msg_a1', steerable: true })
    expect(getRunState('woken').activeMessageId).toBe('msg_a1')
    expect(getRunState('woken').activeStreamMessageIds).toEqual(['msg_a1'])

    // A later status without the id keeps it.
    applyServerRunStatus({ sessionId: 'woken', status: 'tooling' })
    expect(getRunState('woken').activeMessageId).toBe('msg_a1')

    applyServerRunStatus({ sessionId: 'woken', status: 'complete' })
    expect(getRunState('woken').activeMessageId).toBeNull()
  })

  it('forgets the verdict when the run ends, so the next one cannot inherit it', () => {
    applyServerRunStatus({ sessionId: 'woken', status: 'running', steerable: false, steerReason: 'no' })
    applyServerRunStatus({ sessionId: 'woken', status: 'complete' })
    expect(getRunState('woken').steerable).toBeNull()
    applyServerRunStatus({ sessionId: 'woken', status: 'running' })
    expect(getRunState('woken').steerable).toBeNull()
  })
})
