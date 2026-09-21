import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * A new turn waits for a FINISHING turn instead of being refused (2026-09-18).
 *
 * The rule and its tests live in `finishingTurnWait.ts` and `streamAbortRegistry.ts`
 * (`isSessionTurnFinishing`). These pins are about ORDER and WHO: the wait sits above the lock
 * check, so the check and the registration stay one synchronous block; and an approval click
 * never takes it. A click has its own wait (`approvalClickWait.ts`), which refuses to wait
 * behind a lock that is itself answering an approval. The general wait has no such rule: a
 * second click on the same card, waiting out the first click's after-reply work, would run
 * the approved command twice.
 */
describe('send-routed: a new turn waits for a finishing one', () => {
  const clickBranch = source.indexOf('\n    if (approvalClick) {\n      const clickWait = await waitForCardReplyToFinish(sessionId, requestedMessageId)\n')
  const otherwise = source.indexOf('\n    } else {\n', clickBranch)
  const finishWait = source.indexOf('\n      const finishWait = await waitForFinishingTurn(sessionId)\n', otherwise)
  const check = source.indexOf('\n    const activeSessionTurn = getActiveSessionTurn(sessionId)\n', finishWait)

  it('waits in the branch for everything that is not an approval click', () => {
    expect(clickBranch).toBeGreaterThan(-1)
    expect(otherwise).toBeGreaterThan(clickBranch)
    expect(finishWait).toBeGreaterThan(otherwise)
    // The else belongs to the click branch: nothing else opens between them.
    expect(source.slice(clickBranch + 1, otherwise).split('\n    if (').length - 1).toBe(0)
  })

  it('waits ABOVE the lock check, and only there', () => {
    expect(check).toBeGreaterThan(finishWait)
    expect(source.split('waitForFinishingTurn(').length - 1).toBe(1)
  })
})
