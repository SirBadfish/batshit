import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * An API-lane approval resume streams into the message the card was ON — the same id every
 * tab has already marked finished, so the chat page drops every one of its stream events
 * (`ignoreLateEventForFinalizedMessage`). Nothing but the page's old ten-times-a-second
 * refetch of the open chat ever put the resumed reply on screen; that refetch is gone
 * (2026-09-18), so the server says it once, after the write.
 *
 * The pin is about ORDER and the GATE: after the resumed message is in Redis, and only for a
 * resume that has no user turn of its own — a CLI control resume writes a NEW assistant id
 * and streams to the tab normally.
 */
describe('send-routed approval resume contract', () => {
  it('opens an in-place resume after run registration and before provider or tool work', () => {
    const registerAbort = source.indexOf('registerStreamAbort(sessionId, messageId, streamAbortController)')
    const registerSteer = source.indexOf('registerSteerRun(sessionId, {', registerAbort)
    const startDefinition = source.indexOf('ensureStartEmitted = async () => {', registerSteer)
    const resumeGate = source.indexOf('approvalResumeStart &&', startDefinition)
    const earlyStart = source.indexOf('await ensureStartEmitted()', resumeGate)
    const providerStart = source.indexOf('streamResult = await nativeRuntime.streamNativeMode(', earlyStart)

    expect(registerAbort).toBeGreaterThan(-1)
    expect(registerSteer).toBeGreaterThan(registerAbort)
    expect(startDefinition).toBeGreaterThan(registerSteer)
    expect(resumeGate).toBeGreaterThan(startDefinition)
    expect(earlyStart).toBeGreaterThan(resumeGate)
    expect(providerStart).toBeGreaterThan(earlyStart)

    const gateBody = source.slice(resumeGate, earlyStart)
    expect(gateBody).toContain('!groupContext')
    expect(gateBody).toContain('streamMetadata?.groupChat !== true')

    // The same once-only guard serves the early resume and every later chunk/tool path. Provider
    // setup must never replace it and reopen/reset the same message a second time.
    expect(source.split('let startEmitted = false').length - 1).toBe(1)
    expect(source.split('ensureStartEmitted = async () => {').length - 1).toBe(1)
  })

  it('closes an early resume start when provider acquisition fails', () => {
    const helper = source.indexOf('const closeStartedAcquisitionFailure = async (error: unknown) => {')
    const primaryCatch = source.indexOf('} catch (primaryError) {', helper)
    const fallbackCatch = source.indexOf('} catch (fallbackError) {', primaryCatch)

    expect(helper).toBeGreaterThan(-1)
    const helperBody = source.slice(helper, primaryCatch)
    expect(helperBody).toContain('if (!startEmitted) return')
    expect(helperBody).toContain('const interrupted = isStopError(error, [streamAbortSignal, request.signal])')
    expect(helperBody).toContain('if (interrupted) {')
    expect(helperBody).toContain("await finalizeAssistantMessage('error')")
    expect(helperBody).toContain('await streamAdapter.emitComplete({')
    expect(helperBody).toContain('interrupted: true,')
    expect(helperBody.indexOf("await finalizeAssistantMessage('error')"))
      .toBeLessThan(helperBody.indexOf('await streamAdapter.emitComplete({'))
    expect(helperBody.indexOf('await streamAdapter.emitComplete({'))
      .toBeLessThan(helperBody.indexOf('await streamAdapter.emitError({'))
    expect(helperBody).toContain('await streamAdapter.emitError({')
    expect(helperBody).not.toContain('redis.saveMessage')

    const primaryFailureBody = source.slice(primaryCatch, fallbackCatch)
    expect(primaryFailureBody).toContain('if (!fallbackAvailable) {')
    expect(primaryFailureBody).toContain('const terminalError = preserveAcquisitionFailureVersion(primaryError)')
    expect(primaryFailureBody).toContain('await closeStartedAcquisitionFailure(terminalError)')
    expect(primaryFailureBody.indexOf('await closeStartedAcquisitionFailure(terminalError)'))
      .toBeLessThan(primaryFailureBody.indexOf('throw terminalError'))

    const fallbackFailureBody = source.slice(fallbackCatch, source.indexOf('\n  }\n\n  try {', fallbackCatch))
    expect(fallbackFailureBody).toContain('const terminalError = preserveAcquisitionFailureVersion(fallbackError)')
    expect(fallbackFailureBody).toContain('await closeStartedAcquisitionFailure(terminalError)')
    expect(fallbackFailureBody.indexOf('await closeStartedAcquisitionFailure(terminalError)'))
      .toBeLessThan(fallbackFailureBody.indexOf('throw terminalError'))

    const postCatch = source.indexOf('} catch (streamError) {', fallbackCatch)
    const postCatchBody = source.slice(postCatch, source.indexOf('\n        }\n', postCatch))
    expect(postCatchBody).toContain('streamError instanceof ApprovalResumeAcquisitionError')
    expect(postCatchBody).toContain('{ approvalResumeVersion: streamError.approvalResumeVersion }')
  })

  it('tells the tab AFTER the resumed message is saved, and only for an in-place resume', () => {
    const save = source.indexOf('await redis.saveMessage(finalMessage)')
    expect(save).toBeGreaterThan(-1)
    const announce = source.indexOf('if (isApprovalResumeWithoutUserTurn) {', save)
    expect(announce).toBeGreaterThan(save)

    const body = source.slice(announce, announce + 400)
    expect(body).toContain('await publishUserEvent(userId, {')
    expect(body).toContain("type: 'session_messages_changed',")
    expect(body).toContain('sessionId,')
    expect(body).toContain("reason: 'approval_resume',")

    // Nothing between the save and the announcement may end the turn early.
    expect(source.slice(save, announce)).not.toContain('return')
  })

  it('reuses the message the card was on only for an in-place resume', () => {
    // The CLI control resume mints its own ids, so its turn streams to the tab as usual and
    // needs no announcement.
    expect(source).toContain('managedAssistantMessageId = resumeAssistantMessageId')
    expect(source).toContain('const isApprovalResumeWithoutUserTurn =\n    hasToolApprovalResponse && !hasUserTurnContent')
    // Two writers can end an in-place resume: the finalize and the no-output failure writer. The
    // failure writer also announces a turn that failed before its stream opened (bug sweep item 2,
    // 2026-09-18), so its reason is chosen, with the in-place resume keeping `approval_resume`.
    expect(source.split("reason: 'approval_resume',").length - 1).toBe(1)
    expect(source.split("reason: inPlaceResume ? 'approval_resume' : 'turn_failed',").length - 1).toBe(1)
  })
})

/**
 * The resume CONTINUES the message the card was on (`approvalResumeMessage.ts`): its stream
 * starts empty and `saveMessage` replaces content, so saving it alone dropped the words the
 * agent wrote before the card (measured live 2026-09-18, old and new code alike). The rule
 * lives in the module and is tested there; these pins hold send-routed to it.
 */
describe('send-routed keeps what the message held before the card', () => {
  it('continues the stored message BEFORE the finalize saves it, for an in-place resume only', () => {
    const save = source.indexOf('await redis.saveMessage(finalMessage)')
    const gate = source.lastIndexOf(
      "if (isApprovalResumeWithoutUserTurn && typeof finalMessage.content === 'string') {",
      save
    )
    expect(gate).toBeGreaterThan(-1)
    const body = source.slice(gate, save)
    expect(body).toContain('const priorRecord = approvalResumePrior')
    const frozen = source.indexOf('const approvalResumePrior = isApprovalResumeWithoutUserTurn')
    expect(frozen).toBeGreaterThan(-1)
    expect(frozen).toBeLessThan(source.indexOf('const streamAdapter = new StreamEventAdapter({'))
    expect(body).toContain('const continued = composeInPlaceResumeMessage(priorRecord, {')
    expect(body).toContain('finalMessage.content = continued.content')
    expect(body).toContain('finalMessage.metadata = continued.metadata')
    expect(body).toContain('finalMessage.intermediateSteps = continued.intermediateSteps')
    // The finalMessage it continues is the one about to be saved: nothing is built between.
    expect(source.slice(source.lastIndexOf('const finalMessage: ChatMessage = {', gate), gate)).not.toContain('await ')
  })

  it('keeps the words when a resume fails with nothing produced, and tells the tab', () => {
    const writer = source.indexOf('async function persistFailedAssistantTurn(options: {')
    const end = source.indexOf('\nfunction ', writer + 10)
    const body = source.slice(writer, end)
    expect(body).toContain('inPlaceResume?: boolean')
    expect(body).toContain('const content = resolveFailedTurnContent({')
    expect(body).toContain('prior: inPlaceResume ? await readStoredAssistantRecord(sessionId, messageId) : null,')
    expect(body).toContain('      content,\n')
    const saved = body.indexOf('await redis.saveMessage({')
    const told = body.indexOf("type: 'session_messages_changed',")
    expect(saved).toBeGreaterThan(-1)
    expect(told).toBeGreaterThan(saved)
    expect(body.slice(saved, told)).toContain('if (inPlaceResume || options.noStreamEvent === true) {')
  })

  it('keeps the resume version on both partial and empty failure records', () => {
    const metadata = source.indexOf('const failureRuntimeMetadata = {')
    const partialFailure = source.indexOf('// A failed stream must never erase work', metadata)
    expect(metadata).toBeGreaterThan(-1)
    expect(partialFailure).toBeGreaterThan(metadata)
    expect(source.slice(metadata, partialFailure)).toContain(
      '...(approvalResumeStart ? { approvalResumeVersion: approvalResumeStart.version } : {}),'
    )

    const partialMetadata = source.indexOf('...failureRuntimeMetadata,', partialFailure)
    const emptyFailure = source.indexOf('metadata: failureRuntimeMetadata,', partialMetadata)
    expect(partialMetadata).toBeGreaterThan(partialFailure)
    expect(emptyFailure).toBeGreaterThan(partialMetadata)
  })

  it('marks every failure writer that can end an in-place resume', () => {
    const calls = source.split('await persistFailedAssistantTurn({').slice(1).map((call) => call.slice(0, 900))
    expect(calls).toHaveLength(4)
    const marked = calls.filter((call) => call.includes('inPlaceResume:'))
    // The stream handler's own writer, and both POST-handler writers of a managed run. The
    // fourth is a group speaker's, which never resumes an approval in place.
    expect(marked).toHaveLength(3)
    expect(marked[0]).toContain('inPlaceResume: isApprovalResumeWithoutUserTurn,')
    expect(marked[1]).toContain('inPlaceResume: managedRunIsInPlaceApprovalResume,')
    expect(marked[2]).toContain('inPlaceResume: managedRunIsInPlaceApprovalResume,')
    expect(source).toContain(
      'const managedRunIsInPlaceApprovalResume = isInPlaceApprovalResume({\n          approvalResponseCount: approvalResponseForStream.length,\n          content,\n          controlResumeContent: controlApprovalResumeContent,\n        })'
    )
  })
})
