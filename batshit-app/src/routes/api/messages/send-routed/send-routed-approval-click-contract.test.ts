import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * An approval click waits for the reply that raised its card, instead of being refused as a
 * second turn (`approvalClickWait.ts`, where the rule and its tests live).
 *
 * The pins are about ORDER: the wait sits above the lock check, so the check and the
 * registration after it stay one synchronous block; and the lock this request takes says
 * whether it answers an approval, which is what stops a second click on the same card from
 * ever waiting behind the first one and spending the approval twice.
 */
describe('send-routed: an approval click and the turn lock', () => {
  const kind = source.indexOf("\n\t    const sessionTurnKind = groupConfig ? 'group' : 'single'\n")
  const check = source.indexOf('\n    const activeSessionTurn = getActiveSessionTurn(sessionId)\n', kind)
  const register = source.indexOf('\n    const sessionTurnRegistration = registerSessionTurn(\n', check)

  it('waits for the card’s own reply ABOVE the lock check, for a click only', () => {
    expect(kind).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(kind)
    const between = source.slice(kind, check)
    expect(between).toContain(
      '\n    const approvalClick = isApprovalClick({\n      approvalResponseCount: approvalResponse.length,\n      content,\n    })\n'
    )
    expect(between).toContain(
      '\n    if (approvalClick) {\n      const clickWait = await waitForCardReplyToFinish(sessionId, requestedMessageId)\n'
    )
  })

  it('keeps the check and the registration one synchronous block', () => {
    expect(register).toBeGreaterThan(check)
    expect(source.slice(check, register)).not.toContain('await ')
  })

  it('registers a click’s lock as one that answers an approval', () => {
    const call = source.slice(register, register + 400)
    expect(call).toContain('\n      { answersApproval: approvalClick },\n')
    expect(source.split('registerSessionTurn(').length - 1).toBe(1)
  })
})
