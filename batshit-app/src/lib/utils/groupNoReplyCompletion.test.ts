import { describe, expect, it } from 'vitest'
import { isAcceptedGroupNoReplyCompletion } from './groupNoReplyCompletion'

describe('accepted no-stream group result', () => {
  it.each(['skipped', 'unconfirmed', null])('accepts a completed %s outcome, including zero candidates', (replyOutcome) => {
    expect(isAcceptedGroupNoReplyCompletion({ success: true, noReplyStream: true, groupTurnId: 'round', userMessageId: 'u1', replyOutcome }, 'u1')).toBe(true)
  })
  it.each([null, { turnId: 'queued-202' }, { success: false }, { success: true, noReplyStream: false, groupTurnId: 'round', userMessageId: 'u1' }, { success: true, noReplyStream: true, groupTurnId: 'round', userMessageId: 'old' }])('rejects incomplete, streaming, refused or unrelated results', (payload) => {
    expect(isAcceptedGroupNoReplyCompletion(payload, 'u1')).toBe(false)
  })
})
