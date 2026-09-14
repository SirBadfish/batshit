import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync('src/routes/+page.svelte', 'utf8')
const chatInput = readFileSync('src/lib/components/chat/ChatInput.svelte', 'utf8')
const rules = readFileSync('src/lib/utils/steerControl.ts', 'utf8')
const settingsPanel = readFileSync(
  'src/lib/components/settings/panels/UserSettingsPanel.svelte',
  'utf8'
)

/**
 * Source with its comments stripped.
 *
 * The claims below are about what the code DOES. The comments deliberately keep the
 * history — "these four sentences used to end 'Your message interrupts instead'" is worth
 * reading a year from now — and an assertion that cannot tell a retired behaviour from a
 * note about a retired behaviour would force that history to be deleted to stay green.
 */
const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

/**
 * SA-114 P3, rewritten for SA-119 P2 — the client's steer and queue contracts.
 *
 * `+page.svelte` is 7,700 lines of one component and `ChatInput.svelte` is 4,000 more; the
 * claims below are purely about ORDER and about which branch reaches which call, which is
 * how the send-routed steer contracts are pinned too. Everything with real behaviour behind
 * it (the store, the rules module, the settings route) has its own test.
 */
describe('the client send path (SA-114 P3, SA-119 P2)', () => {
  it('never stops the voice on a steer or a queue (DL-114-11, DL-119-07)', () => {
    // AMD-114-07: every send used to call this unconditionally at the top of
    // `handleSendMessage`, which would have silenced the reply a steer is meant to leave
    // running. SA-119 P2 deleted the interrupt branch that was the other caller, so there
    // is now exactly ONE call left in the send path and it sits below both queue branches:
    // by the time it runs, either the reply has ended or nothing was held.
    const handler = page.indexOf('async function handleSendMessage(')
    const steerReturn = page.indexOf("if (outcome.kind === 'accepted')", handler)
    expect(handler).toBeGreaterThan(-1)
    expect(steerReturn).toBeGreaterThan(handler)

    // Nothing between the start of the send and the accepted-steer return may stop speech.
    expect(page.slice(handler, steerReturn)).not.toContain('stopRealtimeSpeechPlayback(')
    expect(page.slice(steerReturn, steerReturn + 900)).toContain('return true')
  })

  it('has no interrupt-and-send branch left at all (DL-119-07)', () => {
    // The retired mode, in every spelling it had. `/api/messages/interrupt` itself is NOT
    // retired — `handleStopStream` still posts it — so the claim is about the SEND path.
    const handler = page.indexOf('async function handleSendMessage(')
    const endOfHandler = page.indexOf('async function handleStopStream()')
    expect(endOfHandler).toBeGreaterThan(handler)
    const sendPath = page.slice(handler, endOfHandler)
    expect(sendPath).not.toContain('/api/messages/interrupt')
    expect(sendPath).not.toContain('Interrupting active stream')
    expect(sendPath).not.toContain('abortController.abort()')
    expect(sendPath).not.toContain('interruptionContext')
    // And Stop still owns the route it always did.
    const stop = page.indexOf('async function handleStopStream()')
    expect(page.slice(stop, stop + 2600)).toContain("'/api/messages/interrupt'")
  })

  it('reads ONE rule for the mode, the same one the badges read (DL-119-02)', () => {
    const rule = page.indexOf('const busySendActions = resolveBusySendActions({')
    expect(rule).toBeGreaterThan(-1)
    const body = page.slice(rule, rule + 400)
    expect(body).toContain('mode: busySendMode')
    expect(body).toContain('steerable: runSteerable')
    expect(body).toContain('hasClips: sendCarriesClips')
    expect(body).toContain('hasMentions: sendCarriesMentions')
    // The composer's own answer wins when a key or a badge gave one; otherwise the page
    // computes the same answer rather than guessing a different one.
    expect(page).toContain(
      'const busySendAction: BusySendMode = busySendOverride ?? busySendActions.enter'
    )
    // Both words, and only those two, are accepted as a one-off override (F-P1-6).
    const override = page.indexOf('const busySendOverride: BusySendMode | null =')
    expect(page.slice(override, override + 260)).toContain(
      "metadata?.busySendModeOverride === 'steer' || metadata?.busySendModeOverride === 'queue'"
    )
  })

  it('sends a steer as `now` and a queue as `end`, through one door (DL-119-05)', () => {
    const branch = page.indexOf('if (steerBranchEligible || serverQueueEligible) {')
    expect(branch).toBeGreaterThan(-1)
    const body = page.slice(branch, page.indexOf('if (clientQueueEligible) {', branch))
    expect(body).toContain("const deliver: SteerDeliver = steerBranchEligible ? 'now' : 'end'")
    // One post, one bubble, both carrying it — the bubble's sentence depends on it.
    expect(body).toContain('steerInbox.noteLocalSteer({')
    expect(body.match(/deliver\n/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(body).toContain('const outcome = await postSteer({')
  })

  it('only lets the SERVER hold a text-only message on a steerable turn (DL-119-05)', () => {
    const gate = page.indexOf('const turnCanHoldText =')
    expect(gate).toBeGreaterThan(-1)
    const body = page.slice(gate, gate + 420)
    expect(body).toContain('managedBusy')
    expect(body).toContain('runSteerable !== false')
    expect(body).toContain('!sendCarriesAttachments')
    expect(page).toContain("const steerBranchEligible = turnCanHoldText && busySendAction === 'steer'")
    expect(page).toContain("const serverQueueEligible = turnCanHoldText && busySendAction === 'queue'")
  })

  it('sends everything else the browser is holding after the reply, one at a time (DL-119-06)', () => {
    const branch = page.indexOf('if (clientQueueEligible) {')
    expect(branch).toBeGreaterThan(-1)
    const body = page.slice(branch, page.indexOf('stopRealtimeSpeechPlayback()', branch))
    // The refusal, with the words left in the composer.
    expect(body).toContain('clientQueueWaitingBySession.has(currentSessionId)')
    expect(body).toContain('QUEUE_ONE_AT_A_TIME_SENTENCE')
    expect(body).toContain('QUEUE_ONE_AT_A_TIME_TEXT_SENTENCE')
    expect(body).toContain('return false')
    // The bubble, and the flag that tells it whether to mention files (F-P2-2).
    expect(body).toContain("state: 'waiting'")
    expect(body).toContain('withFiles: sendCarriesAttachments')
    // Waiting, not interrupting, and never through the steer route.
    expect(body).not.toContain('/api/messages/interrupt')
    expect(body).not.toContain('postSteer(')
    // The claim released in a `finally`, or one refused send would wedge the chat.
    expect(body).toContain('clientQueueWaitingBySession.add(currentSessionId)')
    expect(body).toContain('} finally {')
    expect(body).toContain('clientQueueWaitingBySession.delete(currentSessionId)')
  })

  it('waits for the reply to actually end, not for eight seconds (F-P2-1)', () => {
    // `waitForStreamCompletion` resolves when its 8s ceiling expires. That was survivable
    // while the send then fell into the interrupt branch and stopped the reply first;
    // DL-119-07 deleted that branch, so an expiry would now post into a live turn.
    const branch = page.indexOf('if (clientQueueEligible) {')
    const body = page.slice(branch, page.indexOf('stopRealtimeSpeechPlayback()', branch))
    expect(body).toContain('await waitForReplyToEnd(currentSessionId, waitForMessageId)')
    expect(body).not.toContain('await waitForStreamCompletion(')

    const helper = page.indexOf('async function waitForReplyToEnd(')
    expect(helper).toBeGreaterThan(-1)
    const helperBody = page.slice(helper, helper + 700)
    expect(helperBody).toContain('chatRunRegistry.isSessionBusy(sessionId)')
    expect(helperBody).toContain('CLIENT_QUEUE_MAX_WAIT_MS')
    // A ceiling, not a forever — and the caller must keep the words when it is hit.
    // AMD-119-04 turned the two-way `replyEnded` test into the three-way rule below, so
    // the ceiling's branch is named rather than negated.
    expect(body).toContain("if (outcome === 'still-running') {")
    // Review F-P3b-4: the composer was cleared when the message was queued (AMD-119-05), so
    // the bubble is where the words are. It becomes the receipt; it is not forgotten.
    expect(body).toContain("steerInbox.markSteerDropped(waitingSteerId, 'timed_out')")
    expect(body).toContain('kept on its receipt')
  })

  it('drops a browser-held queued message when the user stops the reply (AMD-119-04)', () => {
    // Josh's decision, 2026-09-13: Stop stops everything. DL-119-05 already dropped a
    // SERVER-held queued message with this receipt; this branch used to SEND, because a
    // Stop is one of the ways `waitForReplyToEnd` finishes — and the receipt was already
    // on screen, so the user was told "Not sent" about a message that then sent.
    const branch = page.indexOf('if (clientQueueEligible) {')
    const body = page.slice(branch, page.indexOf('stopRealtimeSpeechPlayback()', branch))

    // The count is read BEFORE the await and compared after; the rule decides, not the page.
    expect(body).toContain('const stopCountBeforeWait = manualStopCountBySession.get(currentSessionId) ?? 0')
    expect(body).toContain('outcome = resolveQueuedSendAfterWait({')
    expect(body).toContain('(manualStopCountBySession.get(currentSessionId) ?? 0) !== stopCountBeforeWait')
    expect(page.match(/resolveQueuedSendAfterWait\(/g)?.length ?? 0).toBe(1)

    // Stopped: the bubble SURVIVES as the receipt, and nothing is sent.
    // Review F-P3b-4 narrowed this from "everything but a Stop" to "only a send": a wait
    // that gives up on a reply still running keeps its bubble too, as the receipt.
    expect(body).toContain("if (outcome === 'send') steerInbox.forgetSteer(waitingSteerId)")
    expect(page.match(/steerInbox\.forgetSteer\(waitingSteerId\)/g)?.length ?? 0).toBe(1)
    expect(body).toContain("if (outcome === 'dropped-by-stop') {")
    expect(body).toContain('steerInbox.markSteerDropped(waitingSteerId)')
    const dropped = body.indexOf("if (outcome === 'dropped-by-stop') {")
    expect(body.slice(dropped, dropped + 1400)).toContain('return false')
  })

  it('counts every Stop, whether or not it had a message to name (AMD-119-04)', () => {
    const stopHandler = page.indexOf('async function handleStopStream()')
    // Outside P2b's `if (previousMessageId)` guard: the waiting queue is waiting on the
    // GESTURE, not on what it cut.
    // Pinned from the LINE START, not from the call: `void 0 && theCall(` still contains
    // `theCall(`, which is how the first draft of this very pin survived its mutation.
    expect(page).toContain(
      '\n\t    manualStopCountBySession.set(\n\t      sessionId,\n\t      (manualStopCountBySession.get(sessionId) ?? 0) + 1\n\t    )'
    )
    const bump = page.indexOf('manualStopCountBySession.set(', stopHandler)
    expect(bump).toBeGreaterThan(stopHandler)
    expect(bump).toBeLessThan(page.indexOf("'/api/messages/interrupt'", stopHandler))
    // One writer, one reader.
    expect(page.match(/manualStopCountBySession\.set\(/g)?.length ?? 0).toBe(1)
  })

  it('does not send into a reply the route says already finished (DL-114-14)', () => {
    // Measured on BSMS: a simulated-streaming reply finishes SERVER-side while the tab is
    // still typing it out, so the browser can still believe it is busy. There is then
    // nothing to queue behind, and the words go as an ordinary message.
    expect(page).toContain('let steerRefusedAsFinished = false')
    const refusal = page.indexOf("if (outcome.kind === 'already_finished') {")
    expect(refusal).toBeGreaterThan(-1)
    const body = page.slice(refusal, refusal + 300)
    expect(body).toContain('steerRefusedAsFinished = true')
    expect(body).toContain('clientQueueEligible = false')
  })

  it('turns a not-steerable refusal into a queue, never a stop (DL-119-07)', () => {
    const refusal = page.indexOf("} else if (outcome.kind === 'queue') {")
    expect(refusal).toBeGreaterThan(-1)
    expect(page.slice(refusal, refusal + 500)).toContain('clientQueueEligible = true')
  })

  it('settles steer bubbles on every finalise a stopped turn can reach (F-P3-B)', () => {
    // `complete_message` is not guaranteed for a stopped turn — Stop aborts the fetch that
    // would carry it — so `handleStopStream` and the `end` handler settle too.
    const stopHandler = page.indexOf('async function handleStopStream()')
    expect(stopHandler).toBeGreaterThan(-1)
    // An ORDER claim rather than a character window: P2b added Stop's interruption record
    // above this line, and a fixed window would have to be re-tuned by every later edit.
    // The real invariant is that the bubbles are settled BEFORE the route call, because
    // that call is the one that may never answer.
    const settled = page.indexOf(
      'settleSteerBubblesForMessage(sessionId, previousMessageId, { interrupted: true })',
      stopHandler
    )
    expect(settled).toBeGreaterThan(stopHandler)
    expect(settled).toBeLessThan(page.indexOf("'/api/messages/interrupt'", stopHandler))
    expect(page).toContain(
      "settleSteerBubblesForMessage(currentMessage.session_id, targetMessageId, {"
    )
    expect(page).toContain(
      'settleSteerBubblesForMessage(existing.session_id, messageId, { interrupted: true })'
    )
  })

  it('shows the bubble before the route answers, and removes it on a refusal (F-P3-1)', () => {
    const branch = page.indexOf('if (steerBranchEligible || serverQueueEligible) {')
    const post = page.indexOf('const outcome = await postSteer({', branch)
    const note = page.indexOf('steerInbox.noteLocalSteer({', branch)
    expect(branch).toBeGreaterThan(-1)
    expect(note).toBeGreaterThan(branch)
    // Optimistic: the bubble is drawn BEFORE the round trip, as DL-114-14 describes.
    expect(note).toBeLessThan(post)
    const refusals = page.slice(post, page.indexOf('if (clientQueueEligible) {', post))
    expect(refusals).toContain('steerInbox.forgetSteer(steerId)')
  })

  it('refuses a reply whose assistant id it does not know yet (F-P3-2)', () => {
    const branch = page.indexOf('if (steerBranchEligible || serverQueueEligible) {')
    const body = page.slice(branch, page.indexOf('if (clientQueueEligible) {', branch))
    // No target: say so and keep the words in the composer.
    expect(body).toContain('if (!steerTargetMessageId) {')
    expect(body).toContain('still starting')
    expect(body).toContain('return false')
  })

  it('re-arms the drop backstop while the chat is still busy, and never blames a Stop for it (F-P3-4)', () => {
    const settle = page.indexOf('function settleSteerBubblesForMessage(')
    const body = page.slice(settle, settle + 2200)
    expect(body).toContain('chatRunRegistry.isSessionBusy(sessionId)')
    expect(body).toContain("markSteerDropped(entry.steerId, 'unanswered')")
  })

  it('reads the machine-readable tag for "already finished" before the sentence (F-P3-5)', () => {
    // PR #106 review F-4 moved the classification into the rules module, where it is unit
    // tested; the page hands it the status and the payload and switches on the answer.
    const post = page.indexOf('async function postSteer(')
    const body = page.slice(post, post + 2600)
    expect(body).toContain('classifySteerRefusal(response.status, payload)')
    const rules = readFileSync('src/lib/utils/steerControl.ts', 'utf8')
    const tag = rules.indexOf("payload?.refusal === 'reply_finished'")
    const sentence = rules.indexOf("reason.startsWith('That reply already finished')")
    expect(tag).toBeGreaterThan(-1)
    expect(sentence).toBeGreaterThan(tag)
  })

  it('imports the refusal sentences rather than copying them (F-P1-2)', () => {
    // Two of the four lived a second time in this file, and the copies did not change when
    // DL-119-07 made the originals false.
    expect(page).toContain('STEER_REFUSED_GROUP_SENTENCE')
    expect(page).toContain('STEER_REFUSED_UNKNOWN_SENTENCE')
    expect(page).not.toContain('interrupts instead')
    expect(page).not.toContain('Your message interrupts')
  })
})

/**
 * SA-119 P2b (F-P2-7) — the interruption note after Stop, then Enter.
 *
 * `send-routed` still builds the model's `==== INTERRUPTION NOTE ====` from
 * `metadata.interruption`, and DL-119-07 deleted the branch that was its only writer. Stop,
 * then Enter, is now the only way to cut a reply short, so Stop is what records it.
 *
 * These are ORDER and REACHABILITY claims about one 7,700-line component, like the ones
 * above. What is load-bearing and cheap to get wrong: the record is written by Stop and
 * never by a send; it is consumed unconditionally, so one Stop colours one send; a
 * browser-held queue is excluded rather than assumed unreachable; and nothing here brought
 * interrupt-and-send back.
 */
describe('the interruption note after a Stop (SA-119 P2b, F-P2-7)', () => {
  const handler = page.indexOf('async function handleSendMessage(')
  const stopHandler = page.indexOf('async function handleStopStream()')
  const sendPath = page.slice(handler, stopHandler)

  it('is recorded by Stop, naming the reply it cut, above anything that can fail', () => {
    expect(stopHandler).toBeGreaterThan(handler)
    const stopBody = page.slice(stopHandler, stopHandler + 2600)
    expect(stopBody).toContain('pendingStopInterruptionBySession.set(sessionId, {')
    expect(stopBody).toContain('messageId: previousMessageId')
    expect(stopBody).toContain('interruptedAt: new Date().toISOString()')

    // Above the fetch, the abort and the finalise — all three can throw or hang, and the
    // note is now the only thing that tells the model the reply was cut.
    const record = page.indexOf('pendingStopInterruptionBySession.set(sessionId, {', stopHandler)
    expect(record).toBeGreaterThan(stopHandler)
    expect(record).toBeLessThan(page.indexOf("'/api/messages/interrupt'", stopHandler))
    expect(record).toBeLessThan(page.indexOf('runState.abortController.abort()', stopHandler))

    // No id, no record: an addendum about "the previous response" that cannot name it.
    // Pinned as the WHOLE guard, its body on the next line, because a text claim that only
    // asks whether a call appears cannot tell a live call from a disabled one.
    expect(page).toContain(
      'if (previousMessageId) {\n\t      pendingStopInterruptionBySession.set(sessionId, {'
    )
  })

  it('is the ONLY writer — a send never records one (DL-119-07)', () => {
    expect(sendPath).not.toContain('pendingStopInterruptionBySession.set(')
    expect(page.match(/pendingStopInterruptionBySession\.set\(/g)?.length ?? 0).toBe(1)
  })

  it('is consumed on the next ordinary send whether or not it is stamped', () => {
    const read = sendPath.indexOf('pendingStopInterruptionBySession.get(currentSessionId)')
    const consume = sendPath.indexOf('pendingStopInterruptionBySession.delete(currentSessionId)')
    expect(read).toBeGreaterThan(-1)
    expect(consume).toBeGreaterThan(read)
    // Unconditional: the delete is the statement straight after the read, not a branch.
    expect(sendPath.slice(read, consume)).not.toContain('if (')
    // One Stop colours one send, so there is exactly one consumer.
    expect(page.match(/pendingStopInterruptionBySession\.delete\(/g)?.length ?? 0).toBe(1)
  })

  it('asks ONE rule, and hands it all three facts', () => {
    // The decision itself lives in the rules module, where a mutation to it turns a test
    // red — a claim about this file's text cannot do that, which is why the first draft of
    // this pin survived `false &&` in front of the whole condition. What is pinned HERE is
    // that the page asks that rule rather than restating it.
    const call = sendPath.indexOf('const stopInterruption = resolveStopInterruptionStamp({')
    expect(call).toBeGreaterThan(-1)
    const body = sendPath.slice(call, call + 260)
    expect(body).toContain('record: stopInterruptionRecord')
    expect(body).toContain('browserQueued: clientQueueEligible')
    expect(body).toContain('latestAssistantMessageId')
    // And the page computes the third fact from the store rather than trusting a variable.
    expect(sendPath).toContain('const latestAssistantMessageId = (() => {')
    expect(sendPath).toContain("if (candidate?.role === 'assistant') return candidate.id ?? null")
    // No second opinion anywhere: the page states the rule nowhere else.
    expect(page.match(/resolveStopInterruptionStamp\(/g)?.length ?? 0).toBe(1)
  })

  it('is reached only after a steer and both queues have had their say', () => {
    // Steer and the SERVER-held queue return above it; the claim is the ORDER. The
    // BROWSER-held queue falls THROUGH to here, which is why the rule is handed
    // `browserQueued` at all — see the rules module's own test for what it does with it.
    const steerBranch = sendPath.indexOf('if (steerBranchEligible || serverQueueEligible) {')
    const clientQueue = sendPath.indexOf('if (clientQueueEligible) {')
    const read = sendPath.indexOf('pendingStopInterruptionBySession.get(currentSessionId)')
    expect(steerBranch).toBeGreaterThan(-1)
    expect(clientQueue).toBeGreaterThan(steerBranch)
    expect(read).toBeGreaterThan(clientQueue)
  })

  it('rides BOTH write sites, like `metadata.wake`', () => {
    // The persisted user message and the send-routed body. `send-routed` reads the request
    // metadata first and the message record second; a recompile only ever has the record.
    expect(page.match(/interruption: stopInterruption \?\? undefined/g)?.length ?? 0).toBe(2)
    const userRecord = page.indexOf('const userMessage = {', handler)
    const requestBody = page.indexOf('const requestMetadata = {', handler)
    expect(userRecord).toBeGreaterThan(-1)
    expect(requestBody).toBeGreaterThan(userRecord)
    expect(page.indexOf('interruption: stopInterruption', userRecord)).toBeLessThan(requestBody)
    expect(page.indexOf('interruption: stopInterruption', requestBody)).toBeGreaterThan(requestBody)
    // Computed before either one, or the stamp would be read after it was needed.
    const read = page.indexOf('pendingStopInterruptionBySession.get(currentSessionId)', handler)
    expect(read).toBeLessThan(userRecord)
  })

  it('did not bring interrupt-and-send back with it (DL-119-07)', () => {
    // The same three claims as above, re-asserted against the packet that touched this
    // path last: recording what Stop did is not the same as doing it from a send.
    expect(sendPath).not.toContain('/api/messages/interrupt')
    expect(sendPath).not.toContain('abortController.abort()')
    expect(sendPath).not.toContain('Interrupting active stream')
  })

  it('leaves the retry window alone — it is a different fact (F-P2-7)', () => {
    // `lastManualInterruptAtBySession` is an 8-second window read repeatedly and never
    // consumed. Folding the stamp into it would make consuming the stamp close the
    // session-turn retry as well.
    expect(page).toContain('const lastManualInterruptAtBySession = new Map<string, number>()')
    expect(page).toContain(
      'Date.now() - (lastManualInterruptAtBySession.get(currentSessionId) ?? 0) < 8_000'
    )
    expect(page).not.toContain('lastManualInterruptAtBySession.delete(')
  })
})

/**
 * SA-119 P3b (AMD-119-05) — a queued message leaves the box, and comes back as a click.
 *
 * Josh, 2026-09-13. Two halves. (1) The words leave the composer the moment the message is
 * queued: they sat in BOTH the box and the bubble for the whole wait, which reads as "this
 * will be sent twice". (2) Nothing is ever written back into the composer — a user who
 * spent the wait typing paragraphs would lose them to a receipt — so the dropped bubble
 * carries **Send now** and **Dismiss** instead.
 *
 * The bubble's own behaviour is mounted and tested in `SteerBubble.test.ts`. What is pinned
 * here is the WIRING: that the exact send is kept, that Send now replays it rather than the
 * words on screen, and that the composer is cleared but never refilled.
 */
describe('a queued message leaves the box (SA-119 P3b, AMD-119-05)', () => {
  const handler = page.indexOf('async function handleSendMessage(')
  const stopHandler = page.indexOf('async function handleStopStream()')
  const sendPath = page.slice(handler, stopHandler)

  it('clears the composer the moment a browser-held message is queued', () => {
    const branch = sendPath.indexOf('if (clientQueueEligible) {')
    const body = sendPath.slice(branch, sendPath.indexOf('stopRealtimeSpeechPlayback()', branch))
    // Pinned from the line start: `void 0 && theCall(` still contains `theCall(`.
    expect(body).toContain(
      "\n\t        if (typeof metadata?.onQueuedForLater === 'function') {\n\t          metadata.onQueuedForLater()"
    )
    // And it happens AFTER the bubble exists, or the words would be nowhere for a moment.
    const bubble = body.indexOf('steerInbox.noteLocalSteer({')
    expect(bubble).toBeGreaterThan(-1)
    expect(body.indexOf('metadata.onQueuedForLater()')).toBeGreaterThan(bubble)
  })

  it('clears the WORDS only — the clips are sticky and a one-time clip is unspent', () => {
    const chatInput = readFileSync('src/lib/components/chat/ChatInput.svelte', 'utf8')
    expect(chatInput).toContain('onQueuedForLater: () => resetComposer(),')
    // `resetComposer` has only ever cleared text (DL-119-04); the clips are cleared by
    // `clipsManager.handleMessageAccepted`, which a queued message has not earned yet.
    const reset = chatInput.indexOf('function resetComposer() {')
    expect(chatInput.slice(reset, reset + 500)).not.toContain('clipsManager')
  })

  it('never writes anything back into the composer', () => {
    // Josh's reason, 2026-09-13: a user who spent the wait typing paragraphs would lose
    // them. The first draft of this packet did refill it; that is why the claim is here.
    const chatInput = readFileSync('src/lib/components/chat/ChatInput.svelte', 'utf8')
    for (const gone of ['restoreComposerText', 'onReturnedToComposer', 'queuedDraft']) {
      expect(codeOnly(chatInput)).not.toContain(gone)
      expect(codeOnly(page)).not.toContain(gone)
    }
  })

  it('keeps the EXACT send behind each bubble, not the words on screen', () => {
    // The bubble's text has had clip syntax stripped for reading (F-P2-6), and the clip ids
    // and file references live in the metadata. Re-sending the display text would name a
    // clip it does not carry, or drop the file.
    expect(page.match(/resendableSteerPayloads\.set\(/g)?.length ?? 0).toBe(2)
    // Review F-P3b-2: through the rules module, which answers a NEW object with the
    // composer's closures stripped — never a spread of the live metadata, whose `onAccepted`
    // would clear the composer the moment the replay was accepted.
    expect(sendPath).toContain(
      'resendableSteerPayloads.set(steerId, { content, metadata: replayableSendMetadata(metadata) })'
    )
    expect(sendPath).toContain(
      'resendableSteerPayloads.set(waitingSteerId, { content, metadata: replayableSendMetadata(metadata) })'
    )
    expect(page.match(/replayableSendMetadata\(metadata\)/g)?.length ?? 0).toBe(2)
    expect(page).not.toContain('resendableSteerPayloads.set(steerId, { content, metadata })')
    expect(page).not.toContain('metadata: { ...metadata } })')
  })

  it('sends that exact payload on Send now, and takes the receipt down first', () => {
    const fn = page.indexOf('function resendDroppedSteer(steerId: string) {')
    expect(fn).toBeGreaterThan(-1)
    const body = page.slice(fn, page.indexOf('function dismissDroppedSteer(', fn))
    expect(body).toContain('const payload = resendableSteerPayloads.get(steerId)')
    expect(body).toContain('if (!payload) return')
    // Review F-P3b-3: CLEARED (remembered), never merely forgotten — a forgotten id is
    // rebuilt by the session replay on the next resubscribe. And only while the bubble is
    // still `dropped`: the button was drawn for that state.
    expect(body).toContain("if (steerInbox.getSteer(steerId)?.state !== 'dropped') return")
    expect(body).toContain('steerInbox.clearDroppedSteer(steerId)')
    expect(body).not.toContain('steerInbox.forgetSteer(')
    // Review F-P3b-1: a replay, so the send path leaves the chat's OTHER receipts alone.
    expect(body).toContain(
      'void handleSendMessage(payload.content, payload.metadata, { fromDroppedReceipt: true })'
    )
    // The bubble goes BEFORE the send, or the words show twice for the length of a turn.
    expect(body.indexOf('steerInbox.clearDroppedSteer(steerId)')).toBeLessThan(
      body.indexOf('void handleSendMessage(')
    )
    // Never the display text.
    expect(body).not.toContain('steer.text')
  })

  it('offers Send now only when that exact payload still exists', () => {
    expect(page).toContain('function canResendDroppedSteer(steerId: string) {')
    expect(page).toContain('return resendableSteerPayloads.has(steerId)')
    expect(page).toContain('canResendDroppedSteer={canResendDroppedSteer}')
    expect(page).toContain('onResendDroppedSteer={resendDroppedSteer}')
    expect(page).toContain('onDismissDroppedSteer={dismissDroppedSteer}')
  })

  it('prunes the payloads wherever dropped bubbles are cleared', () => {
    // Two call sites, matching the two `clearDroppedSteersForSession` calls (DL-118-08).
    expect(page.match(/prunePayloadsForForgottenSteers\(\)/g)?.length ?? 0).toBe(3)
    const prune = page.indexOf('function prunePayloadsForForgottenSteers() {')
    expect(prune).toBeGreaterThan(-1)
    expect(page.slice(prune, prune + 400)).toContain('if (!steerInbox.getSteer(steerId))')
  })

  /**
   * Faye's review of P3b (2026-09-13). Four ways the receipt could still lose words:
   * Send now on one receipt cleared every other receipt in the chat (F-P3b-1); the replayed
   * metadata carried the composer's `onAccepted`, which cleared the box on acceptance
   * (F-P3b-2); Dismiss and Send now forgot the bubble without remembering it, so the session
   * replay could rebuild it (F-P3b-3); and the wait's ceiling forgot a bubble whose words
   * were no longer in the composer (F-P3b-4, pinned with the wait branch above).
   */
  it('retires ONE receipt from its own button and keeps the others (review F-P3b-1, F-P3b-3)', () => {
    const dismiss = page.indexOf('function dismissDroppedSteer(steerId: string) {')
    expect(dismiss).toBeGreaterThan(-1)
    expect(page.slice(dismiss, dismiss + 400)).toContain('steerInbox.clearDroppedSteer(steerId)')
    expect(page.match(/steerInbox\.clearDroppedSteer\(steerId\)/g)?.length ?? 0).toBe(2)
    // The per-send clear of the chat's dropped receipts (DL-118-08) is skipped for a
    // replay — pinned as the whole guard with its body on the next line, from the line
    // start, because `void 0 &&` in front of a call still contains the call.
    expect(page).toContain(
      '\n      if (!sendOptions.fromDroppedReceipt) {\n        steerInbox.clearDroppedSteersForSession(sendSessionId)'
    )
    expect(page).toContain('sendOptions: { fromDroppedReceipt?: boolean } = {}')
    // And it travels as an argument, not as metadata: `requestMetadata` spreads metadata
    // into the request body and a placeholder record, and the server has no use for it.
    expect(codeOnly(page)).not.toContain('metadata.fromDroppedReceipt')
    expect(codeOnly(page)).not.toContain('metadata?.fromDroppedReceipt')
  })

  it('hands the replay a callback over its OWN clip ids, never the composer (review F-P3b-2)', () => {
    // Pinned from the line start, with the call on the next line.
    expect(chatInput).toContain(
      '\n      onReplayAccepted: () =>\n        clipsManager?.handleMessageAccepted?.({ waitForServer: false, clipIds: sentClipIds }),'
    )
    const callback = chatInput.indexOf('onReplayAccepted: () =>')
    expect(chatInput.slice(callback, callback + 160)).not.toContain('resetComposer')
    expect(chatInput.slice(callback, callback + 160)).not.toContain('handleAccepted(')
    // The composer's own acceptance still clears the box — only the replay's must not.
    expect(chatInput).toContain('onAccepted: () => handleAccepted(false),')
    // The key list lives in the rules module and nowhere else; the page never names the
    // replay callback, because `replayableSendMetadata` has already renamed it.
    expect(rules).toContain(
      "export const COMPOSER_BOUND_SEND_METADATA_KEYS = [\n  'onAccepted',\n  'onQueuedForLater',\n  'busySendModeOverride'\n] as const"
    )
    expect(codeOnly(page)).not.toContain('onReplayAccepted')
  })
})

/**
 * SA-119 P2 (DL-119-03) — the two badges beside Stop.
 *
 * SA-118's F-25 put the third send state behind a hover tooltip, and Josh's finding
 * (2026-09-13) was that people press Enter and nobody hovers — and that the tooltip was the
 * browser's own plain one, not the app's. So the claims here are: both badges exist and
 * both call the same send function; the one Enter will do is marked; the disabled reason is
 * on screen as text; and nothing in the cluster uses a `title` attribute.
 */
describe('the busy send badges (SA-119 P2)', () => {
  /** The whole busy cluster's markup, or '' when it does not exist — which is a failure. */
  const readCluster = () => {
    const start = chatInput.indexOf('<div class="chat-busy-send-float"')
    if (start < 0) return ''
    const end = chatInput.indexOf('{#if voiceModeSessionPillActive}', start)
    return end > start ? chatInput.slice(start, end) : ''
  }
  const cluster = readCluster()

  it('exists at all', () => {
    expect(cluster.length).toBeGreaterThan(0)
  })

  it('draws Steer and Queue as buttons, each sending in its own mode', () => {
    expect(cluster).toContain('data-testid="busy-send-steer-badge"')
    expect(cluster).toContain('data-testid="busy-send-queue-badge"')
    expect(cluster).toContain("onclick={() => handleSend('steer')}")
    expect(cluster).toContain("onclick={() => handleSend('queue')}")
  })

  it('marks the one plain Enter will do, so the choice is not a hover', () => {
    expect(cluster).toContain("class:is-default={busySendActions.enter === 'steer'}")
    expect(cluster).toContain("class:is-default={busySendActions.enter === 'queue'}")
    // Readable by a live proof and by the AB controller, not only by eye.
    expect(cluster).toContain("data-busy-send-default={busySendActions.enter === 'steer' ? 'true' : 'false'}")
    expect(cluster).toContain("data-busy-send-default={busySendActions.enter === 'queue' ? 'true' : 'false'}")
  })

  it('disables Steer from the rule, and never disables Queue', () => {
    expect(cluster).toContain('disabled={disabled || sendDisabled || !busySendActions.steer.enabled}')
    // DL-119-02: Queue is unconditional. "Nothing you typed is lost" rests on it.
    expect(cluster).toContain('disabled={disabled || sendDisabled}')
    expect(cluster).not.toContain('!busySendActions.queue.enabled')
  })

  it('shows the reason as plain text, not only in a tooltip (DL-119-03)', () => {
    expect(chatInput).toContain('{#if busySendActions.steer.note}')
    expect(chatInput).toContain('data-testid="busy-send-note"')
    expect(chatInput).toContain('{busySendActions.steer.note}')
  })

  it('uses the app’s Tooltip for every hover text in the cluster, and no `title`', () => {
    expect(cluster).toContain('<Tooltip.Provider')
    expect(cluster).toContain('<Tooltip.Content>')
    expect(chatInput).toContain("import * as Tooltip from '$lib/components/ui/tooltip'")
    // Stop keeps its own `title` because DL-119-03 leaves Stop unchanged; the badges have
    // none, which is the claim.
    const badges = cluster.slice(0, cluster.indexOf('class="chat-stop-work-float"'))
    expect(badges).not.toContain('title=')
  })

  it('leaves Stop unchanged in place, icon and behaviour (DL-119-03)', () => {
    expect(cluster).toContain('onclick={handleStopWorkClick}')
    expect(cluster).toContain('data-testid="stop-current-run-button"')
    expect(cluster).toContain('<Square class="chat-stop-work-icon" />')
    // The float moved from the button to the cluster around it, at the same coordinates,
    // because two absolutely-positioned siblings would stack on each other.
    const css = chatInput.slice(chatInput.indexOf('.chat-busy-send-float {'))
    expect(css.slice(0, 200)).toContain('right: 0.55rem')
    expect(css.slice(0, 200)).toContain('bottom: 3.15rem')
  })

  it('reuses the shared badge class rather than a new one', () => {
    expect(cluster).toContain('class="bs-badge chat-busy-send-badge"')
  })
})

describe('the send icon while busy (SA-119 P2)', () => {
  it('does what Enter does, and says so from the same rule', () => {
    expect(chatInput).toContain('busySendModeLabel(busySendActions.enter)')
    expect(chatInput).toContain("onclick={() => handleSend(composerBusy ? busySendActions.enter : null)}")
    // The attribute a live proof and a future test read the Enter mode off.
    expect(chatInput).toContain(
      'data-busy-send-mode={composerBusy ? busySendActions.enter : undefined}'
    )
  })

  it('uses the app’s Tooltip, which is half of what Josh reported', () => {
    const send = chatInput.indexOf('data-testid="send-button"')
    expect(send).toBeGreaterThan(-1)
    const button = chatInput.slice(send - 1400, send + 400)
    expect(button).toContain('<Tooltip.Trigger>')
    expect(button).not.toContain('title={sendButtonTooltip}')
  })

  it('offers the other key only when it does something different', () => {
    const hint = chatInput.indexOf('const busySendShortcutHint = $derived(')
    expect(hint).toBeGreaterThan(-1)
    expect(chatInput.slice(hint, hint + 400)).toContain(
      'busySendActions.other === busySendActions.enter'
    )
  })

  it('the badges and the send read the same two attachment facts (F-25)', () => {
    // The claim that keeps the badge honest: what it promises and what the page does are
    // computed from the same two things, 4,600 lines apart in two components.
    const buttonRule = chatInput.indexOf('const composerHasMentions = $derived.by(')
    expect(buttonRule).toBeGreaterThan(-1)
    const buttonBody = chatInput.slice(buttonRule, buttonRule + 320)
    expect(buttonBody).toContain('mapMentionsToFileReferences(')
    // The same exclusions the SEND path passes, not the narrower highlighter list.
    expect(buttonBody).toContain('activeMentionExclusions')
    expect(chatInput).toContain('const composerHasClips = $derived.by(() => composerClippedItems.length > 0)')
    expect(chatInput).toContain('hasClips: composerHasClips')
    expect(chatInput).toContain('hasMentions: composerHasMentions')

    const sendRule = page.indexOf('const sendCarriesClips =')
    expect(sendRule).toBeGreaterThan(-1)
    const sendBody = page.slice(sendRule, sendRule + 320)
    expect(sendBody).toContain('collectTrustedClipIdsFromMetadata(metadata)')
    expect(sendBody).toContain('metadata?.fileReferences')
  })

  it('sends the OTHER mode on Cmd/Ctrl+Enter, and only while busy (DL-119-02)', () => {
    const keydown = chatInput.indexOf("if (e.key === 'Enter' && !e.shiftKey) {")
    expect(keydown).toBeGreaterThan(-1)
    const body = chatInput.slice(keydown, keydown + 900)
    expect(body).toContain('const busyMode = (e.metaKey || e.ctrlKey) ? busySendActions.other : busySendActions.enter')
    // Not busy: no mode at all, so an ordinary send is untouched.
    expect(body).toContain('handleSend(composerBusy ? busyMode : null)')
  })
})

/**
 * SA-119 P2 (DL-119-04) — Steer never loses a file.
 */
describe('Steer keeps the clips (DL-119-04)', () => {
  it('sends the words only, and leaves the clips in the composer', () => {
    expect(chatInput).toContain(
      "const steeringKeepsClips = overrides?.busySendModeOverride === 'steer'"
    )
    // No clip ids on the message...
    expect(chatInput).toContain('const clippedItems = steeringKeepsClips\n      ? []')
    // ...no clip syntax appended to the text...
    expect(chatInput).toContain('if (!steeringKeepsClips && clipsManager?.getClippedItemsSyntax) {')
    // ...and the clips manager is never told the message was accepted, which is what would
    // clear them.
    expect(chatInput).toContain('if (!steeringKeepsClips && clipsManager?.handleMessageAccepted) {')
  })

  it('still resets the TEXT, which is all `resetComposer` ever did', () => {
    const reset = chatInput.indexOf('function resetComposer() {')
    const body = chatInput.slice(reset, reset + 500)
    expect(body).toContain("message = ''")
    expect(body).not.toContain('clipsManager')
  })
})

describe('PR #106 review — the client steer contracts that were missing', () => {
  it('F-4: a refused steer stops; only reply_finished and not_steerable may escalate', () => {
    const handler = page.indexOf('async function handleSendMessage(')
    const refusedBranch = page.indexOf('          toast.info(outcome.reason)\n', handler)
    expect(refusedBranch).toBeGreaterThan(handler)
    expect(page.slice(refusedBranch, refusedBranch + 200)).toContain('return false')
    // And the classification is the rules module's, not a sentence match in the page.
    expect(page).toContain('classifySteerRefusal(response.status, payload)')
    expect(page).not.toContain("reason.startsWith('That reply already finished')")
  })

  it('F-23: a send that mentions a file is held like one that carries a clip', () => {
    const definition = page.indexOf('const sendCarriesMentions =')
    expect(definition).toBeGreaterThan(-1)
    expect(page.slice(definition, definition + 200)).toContain('metadata?.fileReferences')
    expect(page).toContain('const sendCarriesAttachments = sendCarriesClips || sendCarriesMentions')
  })
})

/**
 * SA-118 (DL-118-08) — PR #106 review F-24.
 *
 * Nothing in production cleared a `dropped` steer, so the "Not sent — you stopped the
 * reply" bubble sat under every later exchange in that chat and came back each time the
 * chat was reopened. Two call sites fix it, and the thing that must NOT happen is the
 * reason both are pinned here: a `queued` or `waiting` bubble belongs to a reply that is
 * still running, and it is the only sign the user has that a message is pending.
 */
describe('the dropped steer bubble (SA-118, DL-118-08)', () => {
  it('is cleared by the next send in that chat, before the steer branch', () => {
    const handler = page.indexOf('async function handleSendMessage(')
    const clearCall = page.indexOf('steerInbox.clearDroppedSteersForSession(sendSessionId)', handler)
    const steerBranch = page.indexOf('if (steerBranchEligible || serverQueueEligible) {', handler)
    expect(clearCall).toBeGreaterThan(handler)
    expect(steerBranch).toBeGreaterThan(clearCall)

    // After the empty-content guard, so a stray keypress does not wipe the receipt.
    const emptyGuard = page.indexOf('if (!content.trim()) return false', handler)
    expect(emptyGuard).toBeGreaterThan(-1)
    expect(clearCall).toBeGreaterThan(emptyGuard)
  })

  it('is cleared for the chat being LEFT on a session change', () => {
    const subscribe = page.indexOf('sessionStore.subscribe((state) => {')
    expect(subscribe).toBeGreaterThan(-1)
    const body = page.slice(subscribe, subscribe + 1200)
    expect(body).toContain('const leavingSessionId = currentSessionIdState')
    expect(body).toContain('leavingSessionId !== state.currentSessionId')
    expect(body).toContain('steerInbox.clearDroppedSteersForSession(leavingSessionId)')
  })

  it('never clears a running reply’s queued or waiting bubbles', () => {
    // The blunt version of this function cleared every state and had no caller outside its
    // own test; it is gone, and nothing may call it back.
    expect(page).not.toContain('clearSteersForSession')
    expect(page).not.toContain('steerInbox.clearSteerInboxForTest')
  })
})

/**
 * SA-119 P2 — P1's three open findings, closed.
 *
 * Each of these was a thing private `main` shipped between the packets: a setting that
 * looked like it kept a choice it did not, a keystroke that silently fell back, and four
 * sentences promising a branch the app no longer had.
 */
describe("P1's open findings (F-P1-2, F-P1-5, F-P1-6)", () => {
  it('F-P1-5: the settings panel offers Steer and Queue, and no retired mode', () => {
    expect(settingsPanel).toContain('<Select.Item value="steer" label="Steer (default)">')
    expect(settingsPanel).toContain('<Select.Item value="queue" label="Queue">')
    expect(settingsPanel).not.toContain('value="interrupt"')
    // And the copy beside it describes what the app actually does now.
    expect(settingsPanel).not.toContain('Interrupt is the older behaviour')
    expect(settingsPanel).toContain('press Stop, then')
  })

  it('F-P1-6: the shims are deleted, not left behind as a second opinion', () => {
    for (const gone of [
      'resolveEffectiveBusySendMode',
      'EffectiveBusySendMode',
      'WAIT_SEND_SENTENCE'
    ]) {
      for (const source of [rules, chatInput, page]) {
        expect(codeOnly(source)).not.toContain(gone)
      }
    }
    // `otherBusySendMode` survives, narrowed to the two real modes.
    expect(rules).toContain('export function otherBusySendMode(mode: BusySendMode): BusySendMode')
  })

  it('F-P1-2: no surface promises an interrupt any more', () => {
    for (const source of [rules, chatInput, page, settingsPanel]) {
      expect(codeOnly(source)).not.toMatch(/interrupts instead/i)
      expect(codeOnly(source)).not.toContain('Interrupt and send')
    }
  })
})
