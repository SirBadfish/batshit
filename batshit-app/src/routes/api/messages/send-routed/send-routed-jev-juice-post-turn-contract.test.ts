import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * SA-120 P6 — the after-reply check inside send-routed. The lane's logic has its own suites
 * (`postTurnCheck.jev`, `postTurnCheckState`, `jevJuiceTurn`); these pins hold the WIRING and
 * the ORDER: one turn per send, built from this send's own agent record and history, never for
 * a group speaker; its tail replay composed LAST; the told mark written ONLY at the
 * accepted-send boundary; and the check itself on the ONE after-reply site, after the reply is
 * complete and the snapshot has had its last write, beside smart zip's step with the
 * Execution Viewer rows appended one writer at a time.
 */
describe('send-routed Judge Juice after-reply check contracts', () => {
  const streamStart = source.indexOf('async function handleBatshitAgentStream({')
  const zipTurn = source.indexOf('const jevJuiceSmartZip = jevJuiceGroupSelection', streamStart)
  const checkTurn = source.indexOf('const jevJuicePostTurnCheck = jevJuiceGroupSelection', zipTurn)
  const seam = source.indexOf('const jevJuiceHintProvider = jevJuiceGroupSelection', checkTurn)
  const compile = source.indexOf('await databaseService.buildFormattedChatInput(', seam)
  const compileEnd = source.indexOf("throw new Error('Failed to build formatted chat input for API or CLI agent')", compile)

  it('builds one after-reply turn per send from this send\'s own history, and never for a group speaker', () => {
    expect(streamStart).toBeGreaterThan(-1)
    expect(checkTurn).toBeGreaterThan(zipTurn)
    expect(seam).toBeGreaterThan(checkTurn)

    const turnBody = source.slice(checkTurn, seam)
    expect(turnBody).toContain('? undefined\n    : buildPostTurnCheckTurn({')
    expect(turnBody).toContain('sessionId,')
    expect(turnBody).toContain('agent,')
    expect(turnBody).toContain('history: historyForCompilation,')
    expect(turnBody).toContain('isGroupTurn: Boolean(groupContext) || streamMetadata?.groupChat === true')
    expect(turnBody).toContain("message: typeof messageForCompilation === 'string' ? messageForCompilation : ''")
    expect(source.split('buildPostTurnCheckTurn({').length - 1).toBe(1)
  })

  it('composes its replay last in the one tail provider, and gives the compiler no seam of its own', () => {
    const seamBody = source.slice(seam, compile)
    const zipTail = seamBody.indexOf('jevJuiceSmartZip?.hintProvider,')
    const checkTail = seamBody.indexOf('jevJuicePostTurnCheck?.hintProvider,')
    expect(zipTail).toBeGreaterThan(-1)
    expect(checkTail).toBeGreaterThan(zipTail)
    // The lines ride the existing tail option: no new compiler option exists for this lane.
    const compileOptions = source.slice(compile, compileEnd)
    expect(compileOptions).not.toContain('jevJuicePostTurnCheck')
  })

  it('marks the notes as told only at the accepted-send boundary', () => {
    // BL-527: after the clip/countdown/memory block, not inside it, so a managed CLI
    // control-approval resume (no clip spend) still marks what its compile told.
    const consumeGate = source.indexOf('if (consumeSessionClips && !isApprovalResumeWithoutUserTurn) {\n', compileEnd)
    const zipGate = source.indexOf('if (jevJuiceSmartZip && messageForCompilation && !groupContext) {', consumeGate)
    const checkGate = source.indexOf('if (jevJuicePostTurnCheck && messageForCompilation && !groupContext) {', zipGate)
    const told = source.indexOf('if (toldMessageId) await markPostTurnRecordTold(sessionId, toldMessageId)', checkGate)
    const abortRegistered = source.indexOf('registerStreamAbort(sessionId, messageId, streamAbortController)', consumeGate)

    expect(consumeGate).toBeGreaterThan(compileEnd)
    expect(checkGate).toBeGreaterThan(zipGate)
    expect(told).toBeGreaterThan(checkGate)
    // Still inside the accepted-send block: the stream has not started yet.
    expect(told).toBeLessThan(abortRegistered)
    expect(source.slice(checkGate, told)).toContain('const toldMessageId = jevJuicePostTurnCheck.getToldMessageId()')
    // ONE site marks a record as told.
    expect(source.split('markPostTurnRecordTold(').length - 1).toBe(1)
  })

  it('checks the reply only once it is complete and its snapshot has had its last write, never a silent, paused, or cut reply', () => {
    const finalize = source.indexOf("await finalizeAssistantMessage('postStream')", compileEnd)
    const complete = source.indexOf('await streamAdapter.emitComplete()', finalize)
    const snapshot = source.indexOf("await persistRuntimeSnapshot('succeeded')", complete)
    const awaits = source.indexOf(
      'const replyAwaitsApproval = approvalSummaryIsPending(finishSummary.metadata?.toolApprovals)',
      snapshot
    )
    const gate = source.indexOf(
      '      !silentResponse &&\n      !replyAwaitsApproval &&\n      !replyOutputLimitFailure &&\n      (afterReplySmartZip || afterReplyCheck)\n',
      awaits
    )
    const step = source.indexOf('? afterReplyCheck.runPostTurn({', gate)
    const awaited = source.indexOf('await Promise.all([smartZipStep, postTurnCheckStep])', step)
    const responseBuilt = source.indexOf('const response = json({', step)

    expect(complete).toBeGreaterThan(finalize)
    // The user already has the whole reply before Jev is asked anything.
    expect(snapshot).toBeGreaterThan(complete)
    expect(awaits).toBeGreaterThan(snapshot)
    // BL-527: a reply waiting at a card or cut at the output limit is not finished; neither step runs.
    expect(gate).toBeGreaterThan(awaits)
    expect(step).toBeGreaterThan(gate)
    expect(awaited).toBeGreaterThan(step)
    expect(responseBuilt).toBeGreaterThan(awaited)
    // The run's own answer says the same thing the gate decided.
    expect(source.indexOf('awaitsApproval: replyAwaitsApproval,', responseBuilt)).toBeGreaterThan(responseBuilt)

    // The send's own check, else (BL-527) the check given to a run that finishes an earlier run's reply.
    expect(source).toContain('const afterReplyCheck = jevJuicePostTurnCheck ?? jevJuiceContinuedReply?.postTurnCheck')
    const body = source.slice(step, awaited)
    expect(body).toContain('reply: finishedReply,')
    expect(body).toContain('newZipIds,')
    expect(body).toContain('toolSteps:')
    expect(body).toContain('awaitingApproval: replyAwaitsApproval,')
    // The whole reply: the parts the earlier runs stored ride along.
    expect(body).toContain('earlierParts,')
    // Appending rows is a read-modify-write: this lane appends after smart zip's step settles.
    expect(body).toContain('appendRowsAfter: smartZipStep,')
    // ONE site: never on the error, abort, or interrupted paths.
    expect(source.split('.runPostTurn(').length - 1).toBe(2)
    expect(source.split('afterReplyCheck.runPostTurn(').length - 1).toBe(1)
  })

  it('gives a run that finishes an earlier run\'s reply the after-reply steps alone, from the request that reply answers (BL-527)', () => {
    const continued = source.indexOf('const jevJuiceContinuedReply =', checkTurn)
    expect(continued).toBeGreaterThan(checkTurn)
    expect(continued).toBeLessThan(seam)
    const body = source.slice(continued, seam)
    expect(body).toContain('jevJuiceGroupSelection || !(isApprovalResumeWithoutUserTurn || isContextContinuationRun)')
    expect(body).toContain('? approvalResumeReplyTurn(pausedApprovalTurn, approvalResumePrior)')
    expect(body).toContain(': findContextContinuationTurn(previousMessages, contextContinuationRaw?.previousMessageId),')
    // It reaches the compiler through nothing (no provider before the reply) and the accepted-send
    // boundary through nothing (no told mark): only the after-reply site reads it.
    expect(source.slice(seam, compileEnd)).not.toContain('jevJuiceContinuedReply')
    const uses = source.split('\n').filter((line) => line.includes('jevJuiceContinuedReply') && !line.trim().startsWith('//'))
    expect(uses.map((line) => line.trim())).toEqual([
      'const jevJuiceContinuedReply =',
      'const afterReplySmartZip = jevJuiceSmartZip ?? jevJuiceContinuedReply?.smartZip',
      'const afterReplyCheck = jevJuicePostTurnCheck ?? jevJuiceContinuedReply?.postTurnCheck',
      'const earlierParts = jevJuiceContinuedReply?.earlierParts ?? []'
    ])
  })

  it('never asks the lane directly and never writes its records itself', () => {
    expect(source).not.toContain('computeReplyCheck')
    expect(source).not.toContain('computeStyleCoach')
    expect(source).not.toContain('writePostTurnRecord')
    expect(source).not.toContain('jevJuicePostTurnCheck.hintProvider(')
  })
})
