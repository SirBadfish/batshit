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
describe('send-routed Jev Juice after-reply check contracts', () => {
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
    const consumeGate = source.indexOf('if (consumeSessionClips) {\n    await consumePostCompileSessionClips(sessionId)', compileEnd)
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

  it('checks the reply only once it is complete and its snapshot has had its last write, never a silent or paused reply', () => {
    const finalize = source.indexOf("await finalizeAssistantMessage('postStream')", compileEnd)
    const complete = source.indexOf('await streamAdapter.emitComplete()', finalize)
    const snapshot = source.indexOf("await persistRuntimeSnapshot('succeeded')", complete)
    const gate = source.indexOf('if (!silentResponse && (jevJuiceSmartZip || jevJuicePostTurnCheck)) {', snapshot)
    const step = source.indexOf('? jevJuicePostTurnCheck.runPostTurn({', gate)
    const awaited = source.indexOf('await Promise.all([smartZipStep, postTurnCheckStep])', step)
    const responseBuilt = source.indexOf('const response = json({', step)

    expect(complete).toBeGreaterThan(finalize)
    // The user already has the whole reply before Jev is asked anything.
    expect(snapshot).toBeGreaterThan(complete)
    expect(gate).toBeGreaterThan(snapshot)
    expect(step).toBeGreaterThan(gate)
    expect(awaited).toBeGreaterThan(step)
    expect(responseBuilt).toBeGreaterThan(awaited)

    const body = source.slice(step, awaited)
    expect(body).toContain('reply: finishedReply,')
    expect(body).toContain('newZipIds,')
    expect(body).toContain('toolSteps:')
    // A reply that stopped for an approval is not finished; there is nothing to check yet.
    expect(body).toContain('streamedApprovalRequests.size > 0 || Boolean(finishSummary.metadata?.toolApprovals)')
    // Appending rows is a read-modify-write: this lane appends after smart zip's step settles.
    expect(body).toContain('appendRowsAfter: smartZipStep,')
    // ONE site: never on the error, abort, or interrupted paths.
    expect(source.split('jevJuicePostTurnCheck.runPostTurn(').length - 1).toBe(1)
  })

  it('never asks the lane directly and never writes its records itself', () => {
    expect(source).not.toContain('computeReplyCheck')
    expect(source).not.toContain('computeStyleCoach')
    expect(source).not.toContain('writePostTurnRecord')
    expect(source).not.toContain('jevJuicePostTurnCheck.hintProvider(')
  })
})
