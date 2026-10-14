import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync('src/routes/+page.svelte', 'utf8')

/**
 * BL-4 — the page's half of a send that met another turn.
 *
 * The server holds the send until the chat is free and reuses the message the page saved. The
 * page's decisions are functions in `steerControl.ts` and the store (`steerInbox.svelte.ts`),
 * where their tests live; this file is a 8,600-line component, so these pins can only say WHERE
 * the page asks, and they are pinned from the line start so a disabling prefix breaks them.
 */
describe('the page and a queued send (BL-4)', () => {
  it('tells the server which message it saved, so a queued send reuses it', () => {
    expect(page).toContain('\n            userMessageId: userId,\n')
  })

  it('takes a queued send out of the list and shows its bubble, marked as a queued send', () => {
    const handler = page.indexOf("\n    } else if (data.type === 'steer_queued') {\n")
    const next = page.indexOf("\n    } else if (data.type === 'queued_send_dropped') {\n", handler)
    expect(handler).toBeGreaterThan(-1)
    expect(next).toBeGreaterThan(handler)
    const body = page.slice(handler, next)
    const notice = body.indexOf('\n      const queuedSendNotice = readQueuedSendNotice(data)\n')
    const removal = body.indexOf(
      '\n      if (queuedSendNotice) takeQueuedSendOutOfTheList(eventSessionContext, queuedSendNotice)\n'
    )
    const bubble = body.indexOf('\n      steerInbox.applySteerQueued({\n')
    expect(notice).toBeGreaterThan(-1)
    expect(removal).toBeGreaterThan(notice)
    expect(bubble).toBeGreaterThan(removal)
    expect(body).toContain('\n        queuedSend: queuedSendNotice !== null,\n')
  })

  it('turns bubbles into receipts when the server says it will not send them', () => {
    const handler = page.indexOf("\n    } else if (data.type === 'queued_send_dropped') {\n")
    expect(page.slice(handler, handler + 600)).toContain('\n      steerInbox.applySteerDropped({\n')
  })

  it('settles a kept message’s receipt when its words come back into the chat', () => {
    const handler = page.indexOf("\n    } else if (data.type === 'user_message' && data.message) {\n")
    // Up to and including the newline that closes the branch.
    const body = page.slice(handler, page.indexOf("\n    } else if (data.type === 'steer_queued') {\n", handler) + 1)
    expect(body).toContain(
      '\n        messageStore.updateMessage(incoming.id, normalizedUserMessage)\n        settleKeptReceipt(incoming.id)\n        return\n'
    )
    expect(body).toContain(
      '\n      messageStore.addMessage(normalizedUserMessage)\n      settleKeptReceipt(incoming.id)\n'
    )
  })

  it('a Send now of a kept message goes the ordinary way, and writes nothing twice', () => {
    expect(page).toContain(
      '\n\t    const managedBusy =\n\t      isManagedPrimaryAgentType(agentType) && hasActiveStream && !sendOptions.existingUserMessageId\n'
    )
    expect(page).toContain(
      '\n    if (!sendOptions.existingUserMessageId) {\n      // Add user message to store\n      messageStore.addMessage(userMessage)\n'
    )
    expect(page).toContain(
      '\n              const allMsgs = sendOptions.existingUserMessageId\n                ? placeUserMessageLast(messagesForSend, userId, managedAssistantMessageId)\n'
    )
  })

  it('a Send now makes the kept message this tab’s latest, dated this send, before its reply is added', () => {
    const fresh = page.indexOf('\n    if (!sendOptions.existingUserMessageId) {\n      // Add user message to store\n')
    const resent = page.indexOf(
      '\n      moveResentMessageToEnd(currentSessionId, userId, userMessage.created_at)\n',
      fresh
    )
    const placeholder = page.indexOf('\n          createAssistantWaitingPlaceholder({\n', resent)
    expect(fresh).toBeGreaterThan(-1)
    expect(resent).toBeGreaterThan(fresh)
    expect(placeholder).toBeGreaterThan(resent)
    expect(page).toContain('\n    messageStore.addMessage(restampResentMessage(kept, sentAt))\n')
  })

  it('the chat’s Stop, and only it, stops the sends waiting in the line (review finding 1)', () => {
    const stopFn = page.indexOf('\n\t  async function handleStopStream() {\n')
    const post = page.indexOf("\n      const interrupted = await fetch('/api/messages/interrupt', {\n", stopFn)
    expect(stopFn).toBeGreaterThan(-1)
    expect(post).toBeGreaterThan(stopFn)
    expect(page.slice(post, post + 400)).toContain('\n          stopsWaitingSends: true\n')
    expect(page.split('stopsWaitingSends').length - 1).toBe(1)
  })

  it('pins the bodies the store tests cannot reach (review finding 10)', () => {
    const body = (start: string, end: string) => {
      const from = page.indexOf(start)
      expect(from).toBeGreaterThan(-1)
      const to = page.indexOf(end, from + start.length)
      expect(to).toBeGreaterThan(from)
      return page.slice(from, to)
    }
    const takeOut = body('\n  function takeQueuedSendOutOfTheList(\n', '\n  /**\n')
    // Only this tab's own empty waiting placeholder goes, never a reply with words in it.
    expect(takeOut).toContain(
      "\n      if (placeholder?.metadata?.client_waiting_placeholder === true && !placeholder.content) {\n"
    )
    expect(takeOut).toContain('\n        messageStore.deleteMessage(notice.assistantMessageId, targetSessionId)\n')
    expect(takeOut).toContain('\n    messageStore.deleteMessage(notice.userMessageId, targetSessionId)\n')
    expect(takeOut).toContain('\n    const ownSend = inFlightSendPayloads.get(notice.userMessageId)\n')
    expect(takeOut).toContain(
      '\n      resendableSteerPayloads.set(notice.userMessageId, {\n        ...ownSend,\n        userMessageId: notice.userMessageId\n      })\n'
    )
    const moveResent = body('\n  function moveResentMessageToEnd(', '\n  /**\n')
    expect(moveResent).toContain('\n    messageStore.deleteMessage(messageId, sessionId)\n')
    const settle = body('\n  function settleKeptReceipt(messageId: string) {\n', '\n  function dismissDroppedSteer(')
    expect(settle).toContain('\n        canSendNow: canResendDroppedSteer(messageId)\n')
    expect(settle).toContain('\n      steerInbox.clearDroppedSteer(messageId)\n')
  })

  it('keeps each send’s exact payload only for the length of its request', () => {
    const set = page.indexOf(
      '\n          inFlightSendPayloads.set(userId, { content, metadata: replayableSendMetadata(metadata) })\n'
    )
    const post = page.indexOf('\n          const routedSend = await postSendRoutedWithInterruptRetry({\n', set)
    const cleared = page.indexOf('\n\t          inFlightSendPayloads.delete(userId)\n', post)
    expect(set).toBeGreaterThan(-1)
    expect(post).toBeGreaterThan(set)
    expect(cleared).toBeGreaterThan(post)
  })

  it('says nothing more about a send the server kept: its receipt already says it', () => {
    expect(page).toContain('\n\t      if (isQuietQueuedSendAnswer(errorCode)) {\n')
  })
})

/**
 * BL-713 — the page keeps no queue of its own.
 *
 * A message sent while a reply runs that the steer route does not take (a Clip, an `@file`, a group
 * chat, a lane that cannot take a steer) used to wait in this tab until the reply ended, and was
 * saved only then: a reload or a closed tab lost it. Now it is saved and posted at once, and the
 * chat's line on the server holds it (BL-4). The server half is proven through the real handler
 * (`send-routed-queued-send-card-hold-handler.test.ts`); these pins hold the page to it.
 */
describe('the page and a send while a reply runs (BL-713)', () => {
  const handler = page.indexOf('\t\t  async function handleSendMessage(')
  const stop = page.indexOf('\t  async function handleStopStream() {')
  const sendPath = page.slice(handler, stop)

  it('has no queue of its own left: no wait, no one-per-chat guard, no waiting bubble', () => {
    expect(handler).toBeGreaterThan(-1)
    expect(stop).toBeGreaterThan(handler)
    for (const gone of [
      'clientQueueWaitingBySession',
      'waitForReplyToEnd',
      'waitUntilReplyIsOver',
      'waitForReplyTarget',
      'CLIENT_QUEUE_MAX_WAIT_MS',
      'resolveQueuedSendAfterWait',
      'manualStopCountBySession',
      "state: 'waiting'",
      'onQueuedForLater'
    ]) {
      expect(page).not.toContain(gone)
    }
  })

  it('a busy send is saved and posted at once, in the same call, with the message it saved', () => {
    const rule = sendPath.indexOf(
      '\n\t    const sendWaitsInLine = isManagedPrimaryAgentType(agentType) && hasActiveStream\n'
    )
    const save = sendPath.indexOf('\n      await dbService.saveMessage(userMessage, currentAgentForSend)\n', rule)
    const post = sendPath.indexOf('\n          const routedSend = await postSendRoutedWithInterruptRetry({\n', save)
    expect(rule).toBeGreaterThan(sendPath.indexOf('if (steerBranchEligible || serverQueueEligible) {'))
    expect(save).toBeGreaterThan(rule)
    expect(post).toBeGreaterThan(save)
    // Nothing between the rule and the post waits for the reply.
    expect(sendPath.slice(rule, post)).not.toMatch(/await wait|waitFor|isSessionBusy/)
    expect(sendPath).toContain('\n            userMessageId: userId,\n')
  })

  it('a send that waits in the line draws no reply placeholder and leaves the running reply’s run state alone', () => {
    expect(sendPath).toContain('\n        if (managedAssistantMessageId && !sendWaitsInLine) {\n          createAssistantWaitingPlaceholder({\n')
    expect(sendPath).toContain('\n\t        if (!sendWaitsInLine) {\n\t          chatRunRegistry.startRun({\n')
    expect(sendPath.match(/chatRunRegistry\.startRun\(/g)?.length ?? 0).toBe(1)
    expect(sendPath).toContain('\n\t      if (!sendWaitsInLine) {\n\t        isWaitingForResponse = true\n\t        clearActiveToolProcessingState(currentSessionId)\n\t      }\n')
    expect(sendPath).toContain(
      '\n\t          if (isLatestSendSerial(currentSessionId, sendRunId) && !sendWaitsInLine) {\n\t            clearActiveToolProcessingState(currentSessionId)\n'
    )
    // Its voice too: a send that waits does not silence the reply it waits behind.
    expect(sendPath).toContain('\n\t    if (!sendWaitsInLine) stopRealtimeSpeechPlayback()\n')
    expect(sendPath.match(/stopRealtimeSpeechPlayback\(\)/g)?.length ?? 0).toBe(1)
  })

  it('the next send is not ignored while one waits: the server owns it from its 202', () => {
    expect(sendPath).toContain(
      '\n\t            onAccepted: sendWaitsInLine\n\t              ? () => {\n\t                  if (isLatestSendSerial(sendSessionId, sendRunId)) setSendInFlight(sendSessionId, false)\n'
    )
    const retry = page.indexOf('  async function postSendRoutedWithInterruptRetry(params: {')
    expect(page.slice(retry, retry + 900)).toContain(
      '\n      const response = await postSendRouted(bodyText, {\n        signal: params.signal,\n        onAccepted: params.onAccepted\n      })\n'
    )
  })

  it('protects the captured spoken wait before save/post, while still awaiting the queued turn’s final response', () => {
    const rule = sendPath.indexOf('const sendWaitsInLine = isManagedPrimaryAgentType(agentType) && hasActiveStream')
    const guard = sendPath.indexOf("sendOptions.onReplyAdmitted?.(sendWaitsInLine ? 'queued' : 'direct')", rule)
    const save = sendPath.indexOf('await dbService.saveMessage(userMessage, currentAgentForSend)', guard)
    const send = sendPath.indexOf('const routedSend = await postSendRoutedWithInterruptRetry({', save)
    const terminal = sendPath.indexOf('const completed = await response.json()', send)
    expect(guard).toBeGreaterThan(rule)
    expect(save).toBeGreaterThan(guard)
    expect(send).toBeGreaterThan(save)
    expect(terminal).toBeGreaterThan(send)
    expect(page).not.toContain('metadata.onReplyAdmitted')
    expect(page).not.toContain('metadata?.onReplyAdmitted')
  })

  it('every tab learns when the line holds for an approval card, and a joining tab from its replay', () => {
    const queued = page.indexOf("\n    } else if (data.type === 'steer_queued') {\n")
    const hold = page.indexOf("\n    } else if (data.type === 'queued_send_hold') {\n", queued)
    const dropped = page.indexOf("\n    } else if (data.type === 'queued_send_dropped') {\n", hold)
    expect(hold).toBeGreaterThan(queued)
    expect(dropped).toBeGreaterThan(hold)
    expect(page.slice(queued, hold)).toContain('\n        heldForApprovalCard: readHeldForApprovalCard(data)\n')
    expect(page.slice(hold, dropped)).toContain(
      '\n      steerInbox.applyQueuedSendHold({\n        sessionId: eventSessionContext,\n        heldForApprovalCard: readHeldForApprovalCard(data)\n      })'
    )
  })

  it('Send now on a held send sends that message by its id, and a message no longer waiting says so and its bubble goes (review)', () => {
    const fn = page.indexOf('  async function sendWaitingSendNow(steerId: string) {')
    expect(fn).toBeGreaterThan(-1)
    const body = page.slice(fn, page.indexOf('\n  }\n', fn))
    expect(body).toContain(
      "\n    if (!steer || steer.state !== 'queued' || !steer.queuedSend || !steer.heldForApprovalCard) return\n"
    )
    expect(body).toContain('\n          userMessageId: steerId,\n          waitingSendNow: true,\n')
    // A stale bubble (it went, it was kept, or Batshit restarted): a plain note, and the bubble goes.
    const stale = body.indexOf("\n      if (payload.code === 'queued_send_not_waiting') {\n")
    expect(stale).toBeGreaterThan(-1)
    expect(body.slice(stale, stale + 700)).toContain('\n        steerInbox.forgetSteer(steerId)\n        toast.info(')
    expect(page).toContain('\n          onSendWaitingSendNow={sendWaitingSendNow}\n')
  })
})
