import { describe, expect, it } from 'vitest'

import {
  hasInterruptibleActiveResponse,
  isSessionTurnInProgressPayload,
  isLatestSendRun,
  shouldRetryInterruptedSendAfterSessionTurnInProgress,
  shouldBlockSendWhileInFlight
} from './sendInFlightGuards'

describe('sendInFlightGuards', () => {
  it('treats an active stream as interruptible even if request setup is still in flight', () => {
    expect(
      hasInterruptibleActiveResponse({
        activeStreamCount: 1,
        hasAbortController: false
      })
    ).toBe(true)

    expect(
      hasInterruptibleActiveResponse({
        activeStreamCount: 0,
        hasAbortController: true
      })
    ).toBe(true)
  })

  it('blocks duplicate sends only when nothing interruptible is active', () => {
    expect(
      shouldBlockSendWhileInFlight({
        sendInFlight: true,
        hasInterruptibleActiveResponse: false
      })
    ).toBe(true)

    expect(
      shouldBlockSendWhileInFlight({
        sendInFlight: true,
        hasInterruptibleActiveResponse: true
      })
    ).toBe(false)

    expect(
      shouldBlockSendWhileInFlight({
        sendInFlight: false,
        hasInterruptibleActiveResponse: false
      })
    ).toBe(false)
  })

  it('lets only the latest send run clear shared send state', () => {
    expect(
      isLatestSendRun({
        runId: 4,
        latestRunId: 4
      })
    ).toBe(true)

    expect(
      isLatestSendRun({
        runId: 4,
        latestRunId: 5
      })
    ).toBe(false)
  })

  it('recognizes session-turn-in-progress payloads for interrupt retry handling', () => {
    expect(isSessionTurnInProgressPayload({ code: 'session_turn_in_progress' })).toBe(true)
    expect(isSessionTurnInProgressPayload({ code: 'other_error' })).toBe(false)
    expect(isSessionTurnInProgressPayload(null)).toBe(false)
  })

  it('retries session-turn lock conflicts only for interrupted sends', () => {
    expect(
      shouldRetryInterruptedSendAfterSessionTurnInProgress({
        wasInterrupting: true,
        status: 409,
        payload: { code: 'session_turn_in_progress' },
        attemptIndex: 0,
        maxAttempts: 2
      })
    ).toBe(true)

    expect(
      shouldRetryInterruptedSendAfterSessionTurnInProgress({
        wasInterrupting: false,
        status: 409,
        payload: { code: 'session_turn_in_progress' },
        attemptIndex: 0,
        maxAttempts: 2
      })
    ).toBe(false)

    expect(
      shouldRetryInterruptedSendAfterSessionTurnInProgress({
        wasInterrupting: true,
        status: 409,
        payload: { code: 'session_turn_in_progress' },
        attemptIndex: 2,
        maxAttempts: 2
      })
    ).toBe(false)
  })
})
