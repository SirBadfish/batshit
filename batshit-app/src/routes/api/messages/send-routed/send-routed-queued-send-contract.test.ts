import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * BL-4 — a send that meets another turn waits for it instead of being refused.
 *
 * The rules live in `queuedSendRules.ts` (who waits, the cap, the history the waiting turn
 * compiles), `streamAbortRegistry.ts` (the line, and the lock handed to its head in the same step
 * that frees it) and `queuedSendKeeper.ts` (a send that will not run keeps its words at the end
 * of the chat). These pins are the wiring those tests cannot see: WHERE send-routed asks, and in
 * what order. They are pinned from the start of the line, so a disabling prefix breaks them.
 */
describe('send-routed: a send that meets another turn waits in the line (BL-4)', () => {
  const queueable = source.indexOf('\n    const queueableSend = isQueueableSend({\n')
  const finishWait = source.indexOf('\n      const finishWait = await waitForFinishingTurn(sessionId)\n', queueable)
  const savedRead = source.indexOf('\n    const savedUserMessage = queueableSend\n', finishWait)
  const decision = source.indexOf('\n      const queueDecision = decideQueuedSend({\n', savedRead)
  const enqueue = source.indexOf('\n        const queuedTurn = queueSessionTurn(sessionId, {\n', decision)
  const handover = source.indexOf('\n          const handover = await queuedTurn.outcome\n', enqueue)
  const handed = source.indexOf('\n            handedTurn = handover.entry\n', handover)
  const deletingCheck = source.indexOf(
    '\n    if (isSessionDeleting(sessionId)) {\n      return sessionDeletedResponse()\n    }\n',
    handed
  )
  const lockCheck = source.indexOf(
    '\n    if (activeSessionTurn && activeSessionTurn !== handedTurn) {\n',
    deletingCheck
  )
  const register = source.indexOf('\n    const sessionTurnRegistration = registerSessionTurn(\n', lockCheck)

  it('asks only for the page’s own ordinary send, and never for a woken turn or a click', () => {
    expect(queueable).toBeGreaterThan(-1)
    expect(finishWait).toBeGreaterThan(queueable)
    const call = source.slice(queueable, queueable + 400)
    expect(call).toContain('\n      prefersRespondAsync: acceptTurn !== null,\n')
    expect(call).toContain('\n      approvalClick,\n')
    expect(call).toContain('\n      wake: metadata?.wake,\n')
  })

  // BL-906 (b): a send made while its tab still drew the reply belongs behind that reply. It
  // must not wait ABOVE the lock for a finishing turn: it would then meet a free chat and run
  // beside the card that reply raised (or end the line's hold). It joins the line instead, and
  // the finishing request's own end holds it at the card. A send made after the tab saw the
  // reply end still waits for the finishing turn, as the user's new message (BL-455).
  it('a send made while its tab drew the reply joins the line instead of waiting for a finishing turn (BL-906 b)', () => {
    const branch = source.indexOf('\n    } else if (queueableSend && sentWhileReplyRan(messages, requestedMessageId)) {\n', queueable)
    expect(branch).toBeGreaterThan(queueable)
    expect(finishWait).toBeGreaterThan(branch)
    expect(source.slice(branch, finishWait)).not.toContain('await ')
  })

  it('reads the saved message first, then decides and enqueues with nothing awaiting between', () => {
    expect(savedRead).toBeGreaterThan(queueable)
    expect(decision).toBeGreaterThan(savedRead)
    expect(enqueue).toBeGreaterThan(decision)
    expect(source.slice(decision, enqueue)).not.toContain('await ')
  })

  it('waits for its turn ABOVE the synchronous lock block, and nothing awaits between the handover and the claim', () => {
    expect(handover).toBeGreaterThan(enqueue)
    expect(handed).toBeGreaterThan(handover)
    expect(deletingCheck).toBeGreaterThan(handed)
    expect(lockCheck).toBeGreaterThan(deletingCheck)
    expect(register).toBeGreaterThan(lockCheck)
    expect(source.slice(handed, register)).not.toContain('await ')
    // Taken right where it is handed, before anything else runs: the request's own claim.
    expect(source.slice(handover, handed + '\n            handedTurn = handover.entry\n'.length)).toContain(
      '\n          if (claimQueuedSessionTurn(sessionId, handover.entry)) {\n            tookTheChat = true\n            handedTurn = handover.entry\n'
    )
    // The head claims the lock it was handed through the one registration call.
    expect(source.slice(register, register + 400)).toContain(
      '\n      { answersApproval: approvalClick },\n      handedTurn,\n    )\n'
    )
  })

  it('a chat being deleted answers not found, and a kept send keeps its words and says so', () => {
    const outcomes = source.slice(handover, handed)
    expect(outcomes).toContain(
      "\n          if (handover.kind === 'cancelled') {\n            tookTheChat = true\n            return sessionDeletedResponse()\n          }\n"
    )
    expect(outcomes).toContain(
      "\n          if (handover.kind === 'keep') {\n            if (claimQueuedSessionTurn(sessionId, handover.entry)) {\n              tookTheChat = true\n"
    )
    const keep = outcomes.indexOf("\n          if (handover.kind === 'keep') {\n")
    expect(outcomes.indexOf('\n              await keepQueuedSendAtEnd({\n', keep)).toBeGreaterThan(keep)
    expect(outcomes).toContain(
      '\n            return json(buildQueuedSendKeptAnswer(handover.reason), { status: 409 })\n'
    )
  })

  it('a send over the cap holds the backup-restore gate until its later move is done (review finding 3)', () => {
    // Answered at once, its message moves later, detached from any request: it holds the
    // gate itself, as a turn that outlives its request does (respond-async).
    const overflow = source.slice(decision, handover)
    const hold = overflow.indexOf(
      "\n        const releaseKeepWork = queueDecision === 'overflow' ? enterBackupRestoreHttpRequest() : null\n"
    )
    const enqueued = overflow.indexOf('\n        const queuedTurn = queueSessionTurn(sessionId, {\n')
    expect(hold).toBeGreaterThan(-1)
    expect(enqueued).toBeGreaterThan(hold)
    expect(overflow).toContain(
      "\n        if (queueDecision === 'overflow' && !releaseKeepWork) {\n          return json(buildQueuedSendOverflowAnswer({ keptInLine: false }), { status: 409 })\n        }\n"
    )
    expect(overflow).toContain('\n              } finally {\n                releaseKeepWork?.()\n              }\n')
  })

  it('every way out before the claim lets the send’s place go, and nothing else does (second review)', () => {
    const guarded = source.slice(enqueue, handed + 200)
    expect(guarded).toContain('\n        let tookTheChat = false\n        try {\n')
    expect(source.slice(handed, register)).toContain(
      '\n        } finally {\n          if (!tookTheChat) abandonQueuedSessionTurn(sessionId, queuedTurn)\n        }\n'
    )
  })

  it('the queued run tells the tabs its message is back only after its "Queued" bubble', () => {
    expect(source).toContain(
      "\n        await queuedNoticeSent\n        await forwardQueuedSendEvent(request, {\n          type: 'user_message',\n"
    )
    // BL-713: a kept send's own "Not sent" receipt goes between its bubble and its words (the
    // interrupt route says a Stop's; the handler tests prove the order for the other reasons).
    expect(source).toContain('\n                after: keptNotice,\n')
    expect(source).toContain(
      "\n                handover.reason === 'stopped'\n                  ? queuedNoticeSent\n                  : Promise.resolve(queuedNoticeSent).then(() =>\n"
    )
  })

  it('shows every tab the queued bubble, filed under the reply it waits for', () => {
    const published = source.slice(enqueue, handover)
    expect(published).toContain("\n            type: 'steer_queued',\n")
    expect(published).toContain('\n            steerId: namedUserMessageId,\n')
    expect(published).toContain("\n            deliver: 'end',\n")
    expect(published).toContain('\n            queuedSend: {\n')
    // Never awaited before the wait: the chat may be handed over while it is in flight.
    expect(published).toContain('\n          queuedNoticeSent = forwardSessionEvent({\n')
    expect(published).not.toContain('await forwardSessionEvent(')
  })

  it('moves the message to the end, promotes it, and compiles the merged history when its turn comes', () => {
    const tryStart = source.indexOf('\n    try {\n', register)
    const moved = source.indexOf(
      '\n        const movedUserMessage = await redis.moveMessageToEnd(sessionId, queuedUserMessageId)\n',
      tryStart
    )
    const revealed = source.indexOf(
      '\n        revealQueuedUserMessage(sessionId, queuedUserMessageId)\n',
      moved
    )
    const userMessage = source.indexOf("\n          type: 'user_message',\n", revealed)
    const promoted = source.indexOf("\n          type: 'steer_promoted',\n", userMessage)
    const merged = source.indexOf('\n        turnMessages = mergeQueuedSendHistory({\n', promoted)
    expect(moved).toBeGreaterThan(tryStart)
    expect(revealed).toBeGreaterThan(moved)
    expect(userMessage).toBeGreaterThan(revealed)
    expect(promoted).toBeGreaterThan(userMessage)
    expect(merged).toBeGreaterThan(promoted)
  })

  it('moves a resent message only after what its tab knew was said since, dated when its tab sent it', () => {
    const branch = source.indexOf('\n      } else if (namesSavedUserMessage) {\n')
    expect(branch).toBeGreaterThan(-1)
    const body = source.slice(branch, source.indexOf('\n      const hasUserTurnContent =\n', branch))
    // Measured live: a fresh send moved after another tab's message was restamped later than
    // the reply its own tab had added, and that tab drew its reply above its question.
    expect(body).toContain('\n          shouldMoveSentMessageToEnd({\n')
    expect(body).toContain(
      '\n            createdAt: resentMessageCreatedAt(requestCopy, (savedUserMessage as any)?.created_at),\n'
    )
    expect(body).not.toContain('client.lRange(`messages:${sessionId}`, -1, -1)')
  })

  it('every turn leaves out the messages other sends are still waiting to send', () => {
    expect(source).toContain(
      '\n      let turnMessages: any[] = (Array.isArray(messages) ? messages : []).filter(\n        (message: any) =>\n          !(typeof message?.id === \'string\' && isUserMessageQueued(sessionId, message.id)),\n      )\n'
    )
    // And every read of the request's history after the lock reads the turn's history instead.
    expect(source).toContain('\n          turnMessages,\n          persistedMessages,\n')
    expect(source).toContain('\n            messages: turnMessages,\n            metadata: metadataForStream,\n')
    expect(source).toContain('\n        let managedMessages: any[] = turnMessages\n')
  })
})
