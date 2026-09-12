import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * SA-114 P1 — the send-routed steer contracts.
 *
 * send-routed is 8,700 lines with a dependency graph no unit test reaches, so the claims
 * that are purely about ORDER are pinned here the way SA-106's group and retired-type
 * contracts are: by reading the source. Everything with real behaviour behind it
 * (`steerInboxRegistry`, `steerPromotion`, the composed `prepareStep`, both compile twins)
 * has its own live test elsewhere.
 */
describe('send-routed steer contracts (SA-114 P1)', () => {
  it('clears the steer inbox beside the session-turn lock, in the same finally (DL-114-02)', () => {
    const clearInbox = source.indexOf('clearSteerInbox(sessionId, {')
    const clearLock = source.indexOf('clearSessionTurn(', clearInbox)

    expect(clearInbox).toBeGreaterThan(-1)
    expect(clearLock).toBeGreaterThan(clearInbox)
    // Close together: they are the two halves of one request's cleanup.
    expect(source.slice(clearInbox, clearLock)).not.toContain('await handleBatshitAgentStream')

    // F-P1-1: scoped like the lock release — a live turn started by a retry keeps its
    // accepted steers when a stopped request's `finally` unwinds late.
    expect(source).toContain(
      'const steerKeepMessageId = getActiveStream(sessionId)?.messageId ?? null'
    )
    expect(source.slice(clearInbox, clearLock)).toContain(
      'keepMessageId: steerKeepMessageId'
    )
  })

  it('degrades missed DM steers BEFORE the clear that would delete them (DL-114-13)', () => {
    const keep = source.indexOf('const steerKeepMessageId = getActiveStream(sessionId)')
    const take = source.indexOf('takeMissedDmSteers(sessionId, {', keep)
    const degrade = source.indexOf('await degradeMissedDmSteers(', take)
    const clearInbox = source.indexOf('clearSteerInbox(sessionId, {', degrade)

    expect(keep).toBeGreaterThan(-1)
    // Order is the whole rule: after the clear there is nothing left to read, and the
    // promotion loop deliberately leaves DM entries in place for exactly this.
    expect(take).toBeGreaterThan(keep)
    expect(degrade).toBeGreaterThan(take)
    expect(clearInbox).toBeGreaterThan(degrade)

    // Same scope as the clear, so it degrades what that clear removes and never a live
    // turn's mail.
    expect(source.slice(take, degrade)).toContain('keepMessageId: steerKeepMessageId')
    // Awaited, not floated: the response has already been returned, and a floating promise
    // here would race the next request's enqueue.
    expect(source.slice(take, clearInbox)).toContain('await degradeMissedDmSteers(')
    expect(source.slice(take, clearInbox)).toContain('STEER_MISSED_REASON')
  })

  it('acknowledges an info DM the model read mid-reply, at delivery (F-P4-2)', () => {
    // A wake closes a delivered info note at the end of its turn (SA-115 F-P1-2); a steer
    // hands the note over just as surely, so it closes at delivery — otherwise the same
    // note re-lists on every later roster and the drawer shows it open for a week.
    const drain = source.indexOf('const drainSteersIntoTranscript = async')
    const body = source.slice(drain, source.indexOf('const extractZipIdFromReference', drain))
    const delivered = body.indexOf("type: 'steer_delivered'")
    const ack = body.indexOf('await acknowledgeDeliveredDmSteers(')
    expect(drain).toBeGreaterThan(-1)
    expect(delivered).toBeGreaterThan(-1)
    // After the delivery event, inside the same drain, for the recipient agent of THIS run.
    expect(ack).toBeGreaterThan(delivered)
    expect(body.slice(ack, ack + 120)).toContain('agentId')
  })

  it('streams the steer marker as a chunk, not only into the record (F-P3-A)', () => {
    // `/api/sse`'s `end` case REBUILDS the final content from the stream events it
    // recorded and that rebuild wins over the content it was handed; the browser then
    // saves the rebuilt content back. A marker that never rode a chunk therefore survived
    // the server's own save and was erased by the client's a moment later — invisible to
    // P1 and P2, which drove the route with no browser.
    const drain = source.indexOf('const drainSteersIntoTranscript')
    const drainEnd = source.indexOf('const extractZipIdFromReference', drain)
    expect(drain).toBeGreaterThan(-1)
    expect(drainEnd).toBeGreaterThan(drain)

    const body = source.slice(drain, drainEnd)
    expect(body).toContain('streamAdapter.emitChunk({ content: `${prefix}${placeholder}` })')
    // The SAME bytes go into the record and onto the wire, or the rebuild and the record
    // disagree about where the steer sits.
    expect(body).toContain('streamedMessageContent += `${prefix}${placeholder}`')
    // NOT through `emitTextChunk`: that sets `streamedNonSteerContent`, and a turn whose
    // only streamed bytes were markers must still let the finish text win.
    expect(body).not.toContain('emitTextChunk(')
    expect(body).not.toContain('streamedNonSteerContent = true')
  })

  it('leaves the once-per-accepted-send boundary exactly where it was (DL-114-02)', () => {
    const consumeClips = source.indexOf('await consumePostCompileSessionClips(sessionId)')
    const memoryCommit = source.indexOf('memoryTurnCommit = await commitMemoryTurnState({', consumeClips)
    const registerAbort = source.indexOf('registerStreamAbort(sessionId, messageId, streamAbortController)', memoryCommit)

    expect(consumeClips).toBeGreaterThan(-1)
    expect(memoryCommit).toBeGreaterThan(consumeClips)
    expect(registerAbort).toBeGreaterThan(memoryCommit)

    // Nothing about steering may sit inside that window.
    const boundary = source.slice(consumeClips, registerAbort)
    expect(boundary).not.toContain('Steer')
    expect(boundary).not.toContain('steer')
  })

  it('only an ordinary single-agent turn may deliver a steer (DL-114-09, DL-114-12)', () => {
    expect(source).toContain(
      "const steerDeliveryEnabled = !groupContext && streamMetadata?.groupChat !== true"
    )

    const takeSteers = source.indexOf('takeSteers: steerDeliveryEnabled')
    expect(takeSteers).toBeGreaterThan(-1)
    expect(source.slice(takeSteers, takeSteers + 260)).toContain("lane: 'api'")

    // The drain is gated by the same flag, so a group turn writes no markers either.
    const drainBody = source.indexOf('const drainSteersIntoTranscript = async (force = false) => {')
    expect(drainBody).toBeGreaterThan(-1)
    expect(source.slice(drainBody, drainBody + 140)).toContain('if (!steerDeliveryEnabled) return')
  })

  it('writes the marker after the whole tool step, before the next chunk (DL-114-04, F-P1-3)', () => {
    const loopStart = source.indexOf('for await (const chunk of result.stream) {')
    const drainInLoop = source.indexOf('await drainSteersIntoTranscript()', loopStart)
    const switchStart = source.indexOf('switch (chunk.type) {', loopStart)

    // Drained BEFORE the chunk is handled: that is what puts the marker after the step's
    // zip placeholders and before the text that answers it.
    expect(drainInLoop).toBeGreaterThan(loopStart)
    expect(drainInLoop).toBeLessThan(switchStart)

    // The SDK runs ahead of this loop (measured on BSMS 2026-09-10: the steer was
    // delivered while the loop was still between two parallel tool results), so the
    // drain is gated on the number of `finish-step` chunks the loop has consumed, not on
    // the chunk type in hand. The chunk-type hold set that preceded this gate is gone.
    expect(source).not.toContain('STEER_HOLD_CHUNK_TYPES')

    const drainBody = source.indexOf('const drainSteersIntoTranscript = async (force = false) => {')
    expect(drainBody).toBeGreaterThan(-1)
    expect(source.slice(drainBody, drainBody + 400)).toContain(
      'upToStep: force ? Number.POSITIVE_INFINITY : finishedStepsConsumed'
    )

    const finishStepCase = source.indexOf("case 'finish-step': {", loopStart)
    expect(finishStepCase).toBeGreaterThan(-1)
    // A live statement, not a comment: the counter is the whole gate.
    expect(source.slice(finishStepCase, finishStepCase + 600)).toMatch(/^\s*finishedStepsConsumed \+= 1$/m)
  })

  /**
   * SA-114 P2, F-P1-3's rule turned around for a stream with no steps.
   *
   * The API lane's gate holds a delivered steer until the loop has consumed the
   * `finish-step` of the step it was read after, because the SDK runs ahead of the loop. A
   * CLI stream emits no `finish-step` chunks at all, so there is no count for such a gate
   * to consume — and it needs none: the echo arrives IN the stream at the position the
   * marker belongs at. Marking delivered in the ADAPTER with a step the gate could never
   * reach would leave the marker waiting for the forced finish drain and land it at the
   * very end of the reply.
   */
  it('marks a CLI delivery in its own case, then drains unbounded (P2, F-P1-3)', () => {
    const loopStart = source.indexOf('for await (const chunk of result.stream) {')
    const steerCase = source.indexOf("case 'steer': {", loopStart)
    expect(steerCase).toBeGreaterThan(loopStart)

    const caseBody = source.slice(steerCase, source.indexOf("case 'finish-step': {", steerCase))
    expect(caseBody).toMatch(/^\s*confirmSteerDelivery\(sessionId, messageId, \{$/m)
    expect(caseBody).toMatch(/^\s*await drainSteersIntoTranscript\(true\)$/m)
    // The gate the API lane needs must not be applied here: a CLI stream never reaches it.
    expect(caseBody).not.toContain('upToStep')
    // Groups deliver nothing, on every lane.
    expect(caseBody).toContain('steerDeliveryEnabled')
  })

  it('never marks a CLI delivery from an adapter (P2)', () => {
    for (const adapter of [
      'src/lib/server/services/codexEventAdapter.ts',
      'src/lib/server/services/claudeEventAdapter.ts'
    ]) {
      const adapterSource = readFileSync(adapter, 'utf8')
      expect(adapterSource).not.toContain('confirmSteerDelivery')
      expect(adapterSource).not.toContain('steerInboxRegistry')
      // It only forwards the ids; the words stay in Batshit's own inbox.
      expect(adapterSource).toContain('steerIds')
    }
  })

  /**
   * P2 (DL-114-09): the verdict is resolved ONCE, above the once-per-accepted-send
   * boundary, and registered with the run. The steer route reads it there rather than
   * re-deriving it — a second derivation is how the route would come to promise a steer the
   * turn cannot carry.
   */
  it('resolves steerability once and registers it with the run (P2, DL-114-09)', () => {
    const resolve = source.indexOf('const steerVerdict = resolveSteerability({')
    const consumeClips = source.indexOf('await consumePostCompileSessionClips(sessionId)')
    const registerRun = source.indexOf('registerSteerRun(sessionId, {', resolve)

    expect(resolve).toBeGreaterThan(-1)
    // Above the boundary, so nothing about steering sits inside it.
    expect(resolve).toBeLessThan(consumeClips)
    expect(registerRun).toBeGreaterThan(consumeClips)

    // Exactly one derivation in this whole file: the route reads the answer instead of
    // asking the question a second time.
    expect(source.split('resolveSteerability(').length - 1).toBe(1)

    const verdictBody = source.slice(resolve, registerRun)
    expect(verdictBody).toContain('resolveCodexTransportLane(')
    expect(verdictBody).toContain("isGroupSession: Boolean(groupContext) || streamMetadata?.groupChat === true")
  })

  it('tells the user channel which assistant message a woken reply is writing (F-P3-2)', () => {
    const publish = source.indexOf("type: 'session_run_status',")
    expect(publish).toBeGreaterThan(-1)
    expect(source.slice(publish, publish + 400)).toContain('messageId,')
  })

  it('attaches the CLI steer channel only once the child exists, and clears it with the turn (P2)', () => {
    const streamCall = source.indexOf('streamResult = await nativeRuntime.streamNativeMode(')
    const attach = source.indexOf('attachSteerTransport(sessionId, messageId,', streamCall)
    expect(attach).toBeGreaterThan(streamCall)

    // Guarded: a group run, a run the server refused to steer, and the API lane (which sets
    // no `__steer` at all) must all register no channel.
    const guard = source.slice(source.lastIndexOf('const steerChannel =', attach), attach)
    expect(guard).toContain('steerDeliveryEnabled')
    expect(guard).toContain('steerVerdict.steerable')
    expect(guard).toContain("steerChannelLane === 'codex' || steerChannelLane === 'claude'")

    const clear = source.indexOf('if (steerRunRegistered) clearSteerRun(sessionId, messageId)')
    expect(clear).toBeGreaterThan(-1)
    // In the same `finally` that clears the stream abort, scoped by message id.
    expect(source.slice(clear, clear + 200)).toContain('clearStreamAbort(sessionId, messageId)')
  })

  it('drains once more, unconditionally, before the finish path reads the streamed content (DL-114-04)', () => {
    const finishStart = source.indexOf('const measuredFinishedAt = Date.now()')
    const drainInFinish = source.indexOf('await drainSteersIntoTranscript(true)', finishStart)
    const readsContent = source.indexOf('const finishZipInput = selectFinishZipInput({', finishStart)

    expect(drainInFinish).toBeGreaterThan(finishStart)
    expect(drainInFinish).toBeLessThan(readsContent)

    // And the loop's tail forces the last boundary out too, for whichever finishes first.
    const loopStart = source.indexOf('for await (const chunk of result.stream) {')
    const loopEnd = source.indexOf('await flushRawReasoningFallback()', source.indexOf('if (shouldBreakStream) {', loopStart))
    expect(source.slice(loopStart, loopEnd)).toContain('await drainSteersIntoTranscript(true)')
  })

  it('records the delivered steers in the SAME single write as their placeholders (DL-114-04)', () => {
    const finalize = source.indexOf('const finalizeAssistantMessage = async (')
    const stamp = source.indexOf('endMetadataBase.steers = deliveredSteers.map(', finalize)
    const save = source.indexOf('await redis.saveMessage(finalMessage)', stamp)

    expect(stamp).toBeGreaterThan(finalize)
    expect(save).toBeGreaterThan(stamp)
  })

  it('promotes only what a live user typed, and never after a Stop (DL-114-07, DL-114-13)', () => {
    const loop = source.indexOf('while (steerPromotions < MAX_STEER_PROMOTIONS) {')
    const body = source.slice(loop, source.indexOf('if (steerPromotions >= MAX_STEER_PROMOTIONS) {', loop))

    // Stop means stop.
    expect(body).toContain('streamResult.response.status === 499')
    expect(body).toContain("(streamResult.metadata as any)?.interrupted === true")
    expect(body).toContain('if (interrupted) break')

    // An agent's text must never start a user turn — and P4 made that a filter on the TAKE
    // rather than on the result, so a DM steer is still in the inbox for the end of the
    // request to degrade. Taking it and discarding it, which is what P1 did, removed it
    // from the only place the degrade could have found it.
    expect(body).toContain("{ source: 'user' }")
    expect(body).not.toContain('.filter(\n              (entry) => entry.source')

    // The follow-up is an ordinary accepted send: it does NOT opt out of clip consumption
    // the way the auto-continue and the approval resume do.
    const followUp = body.indexOf('streamResult = await handleBatshitAgentStream({')
    expect(followUp).toBeGreaterThan(-1)
    expect(body.slice(followUp)).not.toContain('consumeSessionClips')
    expect(body.slice(followUp)).not.toContain('metadata.wake')
  })

  it('runs promotion after the context-exhaustion auto-continue, not inside it', () => {
    const autoContinue = source.indexOf('while (\n            streamResult.contextExhausted === true')
    const promotion = source.indexOf('while (steerPromotions < MAX_STEER_PROMOTIONS) {')

    expect(autoContinue).toBeGreaterThan(-1)
    expect(promotion).toBeGreaterThan(autoContinue)
  })

  it('saves stranded text rather than dropping it if the chain bound ever fires', () => {
    const tail = source.indexOf('if (steerPromotions >= MAX_STEER_PROMOTIONS) {')
    const body = source.slice(tail, tail + 1400)

    expect(body).toContain('takeUndeliveredSteers(')
    expect(body).toContain("{ source: 'user' }")
    expect(body).toContain('await promoteSteersToNextTurn({')
    expect(body).toContain('console.error(')
  })
})
