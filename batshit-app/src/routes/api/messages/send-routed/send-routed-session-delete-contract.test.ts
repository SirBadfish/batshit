import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * A chat that is being deleted, or was deleted while this request waited, takes no new turn
 * (2026-09-18).
 *
 * The delete stops the chat's running turn and sweeps only once that turn's request is done;
 * the rules and their tests live in `sessionDeleteTurnStop.ts` and `streamAbortRegistry.ts`
 * (a chat being deleted is MARKED, and the registry refuses a turn while it is). These pins
 * are about the wiring in send-routed, which the module tests cannot see:
 *
 * 1. The mark is read in the synchronous block with the lock check and the registration, so a
 *    turn cannot slip in between a check and its registration.
 * 2. A refusal for a chat being deleted answers "not found", not "a response is running".
 * 3. A request that read the chat before a delete and registered after it (its delete saw no
 *    turn, swept, and removed its mark while this request waited above) re-reads the chat
 *    under its lock, before any of its work. From then on a delete waits for this request.
 */
describe('send-routed: a chat being deleted takes no new turn', () => {
  const finishWait = source.indexOf('\n      const finishWait = await waitForFinishingTurn(sessionId)\n')
  const deletingCheck = source.indexOf(
    '\n    if (isSessionDeleting(sessionId)) {\n      return sessionDeletedResponse()\n    }\n',
    finishWait
  )
  const check = source.indexOf('\n    const activeSessionTurn = getActiveSessionTurn(sessionId)\n', deletingCheck)
  const register = source.indexOf('\n    const sessionTurnRegistration = registerSessionTurn(\n', check)
  const refused = source.indexOf('\n\t    if (!sessionTurnRegistration.ok) {\n', register)
  const keepId = source.indexOf('\n    const sessionTurnId = sessionTurnRegistration.entry.turnId\n', refused)

  it('reads the mark after the waits, in the same synchronous block as the check and the registration', () => {
    expect(finishWait).toBeGreaterThan(-1)
    expect(deletingCheck).toBeGreaterThan(finishWait)
    expect(check).toBeGreaterThan(deletingCheck)
    expect(register).toBeGreaterThan(check)
    expect(source.slice(deletingCheck, register)).not.toContain('await ')
  })

  it('answers a refusal for a chat being deleted as not found', () => {
    expect(refused).toBeGreaterThan(register)
    expect(source.slice(refused, refused + 200)).toContain(
      "\n\t    if (!sessionTurnRegistration.ok) {\n      if (sessionTurnRegistration.reason === 'session_deleting') {\n        return sessionDeletedResponse()\n      }\n"
    )
    const helper = source.indexOf('\nfunction sessionDeletedResponse() {\n')
    expect(helper).toBeGreaterThan(-1)
    const body = source.slice(helper, helper + 500)
    expect(body).toContain("error: 'Session not found or unauthorized'")
    expect(body).toContain("code: 'session_deleted'")
    expect(body).toContain('{ status: 404 }')
  })

  it('answers a request stopped for a delete with the delete’s own words, not "interrupted by user"', () => {
    // The tab that sent the reply shows this while the chat leaves its sidebar.
    expect(source).toContain(
      '\n  const describeInterruption = (): string =>\n    isStoppedForSessionDelete(streamAbortSignal.reason)\n      ? SESSION_DELETED_STOP_MESSAGE\n'
    )
  })

  it('re-reads the chat under its lock before any of its work', () => {
    expect(keepId).toBeGreaterThan(refused)
    const outerTry = source.indexOf('\n    try {\n', keepId)
    expect(outerTry).toBeGreaterThan(keepId)
    expect(source.slice(keepId, outerTry)).not.toContain('await ')
    // The first thing inside the try, ahead of the pre-run sandbox cleanup, so the `finally`
    // below (the only release) lets the lock go.
    const afterTry = source.slice(outerTry, outerTry + 900)
    expect(afterTry).toMatch(
      /^\n {4}try \{\n(?: {6}\/\/[^\n]*\n)*? {6}if \(!\(await redis\.getSession\(sessionId\)\)\) \{\n {8}return sessionDeletedResponse\(\)\n {6}\}\n {6}try \{\n {8}const sandboxCleanupWarnings =\n/
    )
    expect(source.split('releaseSessionTurn(').length - 1).toBe(1)
  })
})

/**
 * A reply stopped because its chat was deleted says so (bug sweep, 2026-09-18).
 *
 * Every tab showing the chat saved the stopped reply back at `end`, and the save route refuses a
 * chat being deleted, so each tab showed a false "Failed to save message to database" beside
 * "Stopped because this chat was deleted." Every stop window (during setup, during early
 * approval-resume acquisition, and mid-reply) marks the reply `chatDeleted` on the `end` (its
 * metadata is the finalize's) and on `complete`. The two request-owned response paths also answer
 * with the `session_deleted` code a send into a deleted chat gets.
 */
describe('send-routed: a reply stopped because its chat was deleted', () => {
  it('marks each stop window in its finalize, complete event, and owned answer', () => {
    expect(source).toContain(
      '\n  const stoppedForDeletedChat = (): boolean => isStoppedForSessionDelete(streamAbortSignal.reason)\n'
    )

    const setupStart = source.indexOf('  const abortedDuringSetup = Boolean(streamAbortSignal.aborted)')
    const setupEnd = source.indexOf('\n  let streamResult: any', setupStart)
    const setupStop = source.slice(setupStart, setupEnd)
    expect(setupStart).toBeGreaterThan(-1)
    expect(setupEnd).toBeGreaterThan(setupStart)
    expect(setupStop).toContain('interruptedDuringSetup: true,')
    expect(setupStop.split("...(stoppedForDeletedChat() ? { chatDeleted: true } : {}),").length - 1).toBe(2)
    expect(setupStop).toContain("...(stoppedForDeletedChat() ? { code: 'session_deleted' } : {}),")

    const earlyStart = source.indexOf('  const closeStartedAcquisitionFailure = async (error: unknown) => {')
    const earlyEnd = source.indexOf('\n  const preserveAcquisitionFailureVersion', earlyStart)
    const earlyStop = source.slice(earlyStart, earlyEnd)
    expect(earlyStart).toBeGreaterThan(-1)
    expect(earlyEnd).toBeGreaterThan(earlyStart)
    expect(earlyStop.split("...(stoppedForDeletedChat() ? { chatDeleted: true } : {}),").length - 1).toBe(2)
    expect(earlyStop).toContain("await finalizeAssistantMessage('error')")
    expect(earlyStop).toContain('await streamAdapter.emitComplete({')

    const replyStart = source.indexOf('    if (isAbortError) {', earlyEnd)
    const replyEnd = source.indexOf('\n    const errorStatus = getFailureStatus(error)', replyStart)
    const midReplyStop = source.slice(replyStart, replyEnd)
    expect(replyStart).toBeGreaterThan(earlyEnd)
    expect(replyEnd).toBeGreaterThan(replyStart)
    expect(midReplyStop.split("...(stoppedForDeletedChat() ? { chatDeleted: true } : {}),").length - 1).toBe(2)
    expect(midReplyStop).toContain("...(stoppedForDeletedChat() ? { code: 'session_deleted' } : {}),")
  })
})

/**
 * A turn that fails before its stream sends anything tells every tab (bug sweep item 2,
 * 2026-09-18). A second tab showing the chat heard no stream event, so it showed the user's words
 * with no reply and no error until it reloaded. The failed-turn writer now says
 * `session_messages_changed` for it, and the page re-reads the chat on screen for any reason.
 */
describe('send-routed: a turn that failed before its stream opened', () => {
  const writer = source.indexOf('async function persistFailedAssistantTurn(options: {')
  const writerBody = source.slice(writer, source.indexOf('\n}\n', writer))

  it('announces the failed turn when no stream event could', () => {
    expect(writerBody).toContain('noStreamEvent?: boolean')
    expect(writerBody).toContain('if (inPlaceResume || options.noStreamEvent === true) {')
    expect(writerBody).toContain("reason: inPlaceResume ? 'approval_resume' : 'turn_failed',")
  })

  it('marks both failures that happen before the stream: the refused answer and a thrown setup', () => {
    const handler = source.indexOf('async function handleSendRoutedRequest(')
    expect(handler).toBeGreaterThan(-1)
    const handlerBody = source.slice(handler)
    expect(handlerBody.split('noStreamEvent: true,').length - 1).toBe(2)

    const refused = handlerBody.indexOf('streamResult.failureHandled !== true')
    const refusedEnd = handlerBody.indexOf('return streamResult.response', refused)
    expect(refused).toBeGreaterThan(-1)
    expect(refusedEnd).toBeGreaterThan(refused)
    expect(handlerBody.slice(refused, refusedEnd)).toContain('noStreamEvent: true,')

    const thrown = handlerBody.indexOf('} catch (streamError) {', refusedEnd)
    const thrownEnd = handlerBody.indexOf('throw streamError', thrown)
    expect(thrown).toBeGreaterThan(refusedEnd)
    expect(thrownEnd).toBeGreaterThan(thrown)
    expect(handlerBody.slice(thrown, thrownEnd)).toContain('noStreamEvent: true,')
  })
})
