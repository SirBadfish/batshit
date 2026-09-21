import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * An approval is answered ONCE (bug sweep, 2026-09-18). The rule and its tests live in
 * `approvalAnswerRecord.ts` / `toolApprovalState.ts`; these pins are about WHERE send-routed
 * calls it.
 *
 * - Under the click's turn lock (after the registration), so two clicks can never both pass it.
 * - After the three-minute sweep, whose writes it must read and whose late-Approve-to-denial
 *   conversion (`approvalResponseForStream`) is the answer it records.
 * - Before anything runs: a record written after the resumed run started would leave a window
 *   where a stopped run's second click runs the command again.
 */
describe('send-routed: an approval is answered once', () => {
  const register = source.indexOf('\n    const sessionTurnRegistration = registerSessionTurn(\n')
  const analyze = source.indexOf('const approvalState = analyzeApprovalState(approvalHistoryMessages)')
  const lateWarning = source.indexOf("'[Send-Routed] Late approval converted to deny due to timeout'")
  const answer = source.indexOf('const approvalAnswer = await answerApprovalsOnce({')
  const streamMetadata = source.indexOf('const metadataForStream =', answer)

  it('is called once, under the lock, after the three-minute sweep, before the run is built', () => {
    expect(source.split('answerApprovalsOnce(').length - 1).toBe(1)
    expect(register).toBeGreaterThan(-1)
    expect(analyze).toBeGreaterThan(register)
    expect(lateWarning).toBeGreaterThan(analyze)
    expect(answer).toBeGreaterThan(lateWarning)
    expect(streamMetadata).toBeGreaterThan(answer)
  })

  it('records the answers the run will receive, for the card the click names', () => {
    const call = source.slice(answer, answer + 300)
    expect(call).toContain('messageId: requestedMessageId,')
    expect(call).toContain('responses: approvalResponseForStream,')
  })

  it('refuses an answered approval, and fails closed when the record cannot be written', () => {
    const refusals = source.slice(answer, streamMetadata)
    expect(refusals).toContain("code: 'approval_already_answered'")
    expect(refusals).toContain('{ status: 409 }')
    expect(refusals).toContain("code: 'approval_record_failed'")
    expect(refusals).toContain('{ status: 503 }')
  })
})
