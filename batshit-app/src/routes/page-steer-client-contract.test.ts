import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync('src/routes/+page.svelte', 'utf8')
const chatInput = readFileSync('src/lib/components/chat/ChatInput.svelte', 'utf8')

/**
 * SA-114 P3 — the client's steer contracts.
 *
 * `+page.svelte` is 7,700 lines of one component; the claims below are purely about ORDER
 * and about which branch reaches which call, which is what the send-routed steer contracts
 * are already pinned this way for. Everything with real behaviour behind it (the store, the
 * rules module, the settings route) has its own test.
 */
describe('the client send path (SA-114 P3)', () => {
  it('never stops the voice on a steer, and always does on an interrupt (DL-114-11)', () => {
    // AMD-114-07: the lock assumed only the Stop button called this and an interrupt-mode
    // send had to GAIN it. In fact every send called it unconditionally at the top of
    // `handleSendMessage`, which would have silenced the reply a steer is meant to leave
    // running. The call moved down into the two branches that keep it.
    const handler = page.indexOf('async function handleSendMessage(')
    const steerReturn = page.indexOf("if (outcome.kind === 'accepted')", handler)
    const interruptBranch = page.indexOf("logger.debug('[handleSendMessage] Interrupting active stream'", handler)

    expect(handler).toBeGreaterThan(-1)
    expect(steerReturn).toBeGreaterThan(handler)
    expect(interruptBranch).toBeGreaterThan(steerReturn)

    // Nothing between the start of the send and the accepted-steer return may stop speech.
    expect(page.slice(handler, steerReturn)).not.toContain('stopRealtimeSpeechPlayback(')
    // The accepted branch returns; the interrupt branch below it stops the voice.
    expect(page.slice(steerReturn, interruptBranch)).toContain('return true')
    expect(page.slice(interruptBranch, interruptBranch + 900)).toContain(
      'stopRealtimeSpeechPlayback(previousMessageId)'
    )
  })

  it('holds a send that carries files instead of steering it (DL-114-10)', () => {
    const clipsBranch = page.indexOf('} else if (steerBranchEligible && sendCarriesAttachments) {')
    expect(clipsBranch).toBeGreaterThan(-1)
    // The branch grew a bubble in review (F-P3-3); the window covers the whole branch.
    const body = page.slice(clipsBranch, page.indexOf('// Re-read: a steer that was refused', clipsBranch))
    expect(body).toContain('await waitForStreamCompletion(waitForMessageId)')
    // Waiting, not interrupting: the user did not ask to stop anything.
    expect(body).not.toContain('/api/messages/interrupt')
    expect(body).not.toContain('postSteer(')
  })

  it('does not interrupt a reply the route says already finished (DL-114-14)', () => {
    // Measured on BSMS: a simulated-streaming reply finishes SERVER-side while the tab is
    // still typing it out, so the browser can still believe it is busy. Interrupting then
    // would stop nothing and stamp a turn that already ended.
    expect(page).toContain('let steerRefusedAsFinished = false')
    const refusal = page.indexOf("if (outcome.kind === 'already_finished') {")
    expect(refusal).toBeGreaterThan(-1)
    expect(page.slice(refusal, refusal + 200)).toContain('steerRefusedAsFinished = true')
    expect(page).toContain('!steerRefusedAsFinished &&')
  })

  it('settles steer bubbles on every finalise a stopped turn can reach (F-P3-B)', () => {
    // `complete_message` is not guaranteed for a stopped turn — Stop aborts the fetch that
    // would carry it — so `handleStopStream` and the `end` handler settle too.
    const stopHandler = page.indexOf('async function handleStopStream()')
    expect(stopHandler).toBeGreaterThan(-1)
    expect(page.slice(stopHandler, stopHandler + 1200)).toContain(
      'settleSteerBubblesForMessage(sessionId, previousMessageId, { interrupted: true })'
    )
    expect(page).toContain(
      "settleSteerBubblesForMessage(currentMessage.session_id, targetMessageId, {"
    )
    expect(page).toContain(
      'settleSteerBubblesForMessage(existing.session_id, messageId, { interrupted: true })'
    )
  })

  it('shows the bubble before the route answers, and removes it on a refusal (F-P3-1)', () => {
    const branch = page.indexOf('if (steerBranchEligible && !sendCarriesAttachments) {')
    const post = page.indexOf('const outcome = await postSteer({', branch)
    const note = page.indexOf('steerInbox.noteLocalSteer({', branch)
    expect(branch).toBeGreaterThan(-1)
    expect(note).toBeGreaterThan(branch)
    // Optimistic: the bubble is drawn BEFORE the round trip, as DL-114-14 describes.
    expect(note).toBeLessThan(post)
    const refusals = page.slice(post, page.indexOf('} else if (steerBranchEligible && sendCarriesAttachments) {', post))
    expect(refusals).toContain('steerInbox.forgetSteer(steerId)')
  })

  it('refuses to interrupt a reply whose assistant id it does not know yet (F-P3-2)', () => {
    const branch = page.indexOf('if (steerBranchEligible && !sendCarriesAttachments) {')
    const body = page.slice(branch, page.indexOf('} else if (steerBranchEligible && sendCarriesAttachments) {', branch))
    // No target: say so and keep the words in the composer — never fall through to the
    // interrupt branch on a click that promised to steer.
    expect(body).toContain('if (!steerTargetMessageId) {')
    expect(body).toContain('still starting')
    expect(body).toContain('return false')
  })

  it('draws the waiting bubble for a send with files (F-P3-3, DL-114-10)', () => {
    const clipsBranch = page.indexOf('} else if (steerBranchEligible && sendCarriesAttachments) {')
    const body = page.slice(clipsBranch, clipsBranch + 1400)
    expect(body).toContain("state: 'waiting'")
    expect(body).toContain('await waitForStreamCompletion(waitForMessageId)')
    expect(body).toContain('steerInbox.forgetSteer(')
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
    const body = page.slice(post, post + 2400)
    expect(body).toContain('classifySteerRefusal(response.status, payload)')
    const rules = readFileSync('src/lib/utils/steerControl.ts', 'utf8')
    const tag = rules.indexOf("payload?.refusal === 'reply_finished'")
    const sentence = rules.indexOf("reason.startsWith('That reply already finished')")
    expect(tag).toBeGreaterThan(-1)
    expect(sentence).toBeGreaterThan(tag)
  })

  it('leaves the interrupt path itself byte-identical apart from the speech stop (DL-114-15)', () => {
    // The interrupt POST, the abort, the wait and the interruption stamp are unchanged.
    const interruptBranch = page.indexOf("logger.debug('[handleSendMessage] Interrupting active stream'")
    const body = page.slice(interruptBranch, interruptBranch + 1800)
    expect(body).toContain("await fetch('/api/messages/interrupt'")
    expect(body).toContain('activeRunState.abortController.abort()')
    expect(body).toContain('await waitForStreamCompletion(resolvedMessageId)')
    expect(body).toContain("reason: 'user'")
  })
})

describe('the send button (SA-114 P3)', () => {
  it('reads one rule for the label and offers the shortcut only when it works', () => {
    expect(chatInput).toContain('resolveEffectiveBusySendMode({')
    expect(chatInput).toContain('busySendModeLabel(busyEffectiveSendMode)')
    // A reply that cannot be steered must not advertise a key that does nothing.
    expect(chatInput).toContain('const shortcutHint = steerable')
  })

  /**
   * SA-118 (DL-118-09) — PR #106 review F-25.
   *
   * With a clip attached and the agent busy, the button read **Steer** and its tooltip
   * promised the words would "land inside this reply", while `+page.svelte` took the wait
   * branch and sent them after the reply ended. The wait behaviour is DL-114-10 and is not
   * in question; only the label was lying. So the claim below is that the BUTTON and the
   * SEND read the same two facts — clips, and `@file` mentions — and it is the reason this
   * file exists: they live 4,600 lines apart in two different components.
   */
  it('F-25: the button and the send read the same two attachment facts', () => {
    const buttonRule = chatInput.indexOf('const composerCarriesAttachments = $derived.by(')
    expect(buttonRule).toBeGreaterThan(-1)
    const buttonBody = chatInput.slice(buttonRule, buttonRule + 500)
    expect(buttonBody).toContain('composerClippedItems.length > 0')
    expect(buttonBody).toContain('mapMentionsToFileReferences(')
    // The same exclusions the SEND path passes, not the narrower highlighter list — or the
    // button and the send could disagree about whether one mention counts.
    expect(buttonBody).toContain('activeMentionExclusions')
    expect(chatInput).toContain('carriesAttachments: composerCarriesAttachments')

    const sendRule = page.indexOf('const sendCarriesAttachments =')
    expect(sendRule).toBeGreaterThan(-1)
    const sendBody = page.slice(sendRule, sendRule + 300)
    expect(sendBody).toContain('collectTrustedClipIdsFromMetadata(metadata)')
    expect(sendBody).toContain('metadata?.fileReferences')

    // And the send path must NOT pass the flag: `steerBranchEligible` tests
    // `=== 'steer'`, so a page that resolved `'wait'` would silently retire its own wait
    // branch and send a clip through the steer route instead.
    const pageRule = page.indexOf('const effectiveBusySendMode: EffectiveBusySendMode =')
    expect(pageRule).toBeGreaterThan(-1)
    expect(page.slice(pageRule, pageRule + 320)).not.toContain('carriesAttachments')
    expect(page).toContain("effectiveBusySendMode === 'steer'")
  })

  it('F-25: the held send carries the label and the sentence, not a fourth wording', () => {
    // The tooltip's sentence comes from `steerControl`, which is where the bubble the same
    // click draws gets it. One behaviour, one promise.
    expect(chatInput).toContain('WAIT_SEND_SENTENCE')
    expect(chatInput).toContain("if (busyEffectiveSendMode === 'wait')")
    expect(chatInput).not.toContain("'Send after reply'")
    // The attribute a live proof and a future test can read the effective mode off.
    expect(chatInput).toContain('data-busy-send-mode={composerBusy ? busyEffectiveSendMode : undefined}')
  })

  it('sends the OTHER mode on Cmd/Ctrl+Enter, and only while busy (DL-114-01)', () => {
    const keydown = chatInput.indexOf("if (e.key === 'Enter' && !e.shiftKey) {")
    expect(keydown).toBeGreaterThan(-1)
    const body = chatInput.slice(keydown, keydown + 700)
    expect(body).toContain('(e.metaKey || e.ctrlKey) && composerBusy')
    expect(body).toContain('otherBusySendMode(busyEffectiveSendMode)')
    // Enter alone keeps its meaning.
    expect(body).toContain('handleSend(oneOffMode)')
  })
})

describe('PR #106 review — the client steer contracts that were missing', () => {
  it('F-4: a refused steer stops; only reply_finished and not_steerable may escalate', () => {
    const handler = page.indexOf('async function handleSendMessage(')
    const refusedBranch = page.indexOf("} else if (outcome.kind === 'refused') {", handler)
    const interruptBranch = page.indexOf("logger.debug('[handleSendMessage] Interrupting active stream'", handler)
    expect(refusedBranch).toBeGreaterThan(handler)
    expect(interruptBranch).toBeGreaterThan(refusedBranch)
    // The refused branch returns before anything can interrupt.
    expect(page.slice(refusedBranch, refusedBranch + 700)).toContain('return false')
    // And the classification is the rules module's, not a sentence match in the page.
    expect(page).toContain('classifySteerRefusal(response.status, payload)')
    expect(page).not.toContain("reason.startsWith('That reply already finished')")
  })

  it('F-23: a send that mentions a file is held like one that carries a clip', () => {
    const definition = page.indexOf('const sendCarriesAttachments =')
    expect(definition).toBeGreaterThan(-1)
    expect(page.slice(definition, definition + 300)).toContain('metadata?.fileReferences')
  })
})

/**
 * SA-118 (DL-118-08) — PR #106 review F-24.
 *
 * Nothing in production cleared a `dropped` steer, so the "Not sent — you stopped the
 * reply" bubble sat under every later exchange in that chat and came back each time the
 * chat was reopened. Two call sites fix it, and the thing that must NOT happen is the
 * reason both are pinned here: a `queued` or `waiting` bubble belongs to a reply that is
 * still running, and it is the only sign the user has that a steer is pending.
 */
describe('the dropped steer bubble (SA-118, DL-118-08)', () => {
  it('is cleared by the next send in that chat, before the steer branch', () => {
    const handler = page.indexOf('async function handleSendMessage(')
    const clearCall = page.indexOf('steerInbox.clearDroppedSteersForSession(sendSessionId)', handler)
    const steerBranch = page.indexOf('if (steerBranchEligible && !sendCarriesAttachments) {', handler)
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
