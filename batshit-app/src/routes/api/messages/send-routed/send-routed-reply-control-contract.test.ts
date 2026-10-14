import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')
const page = readFileSync('src/routes/+page.svelte', 'utf8')
const messageStore = readFileSync('src/lib/stores/messages.svelte.ts', 'utf8')
const sse = readFileSync('src/routes/api/sse/+server.ts', 'utf8')

/**
 * SA-129 P2 (DL-08, closes BL-234): the reply-end control step runs ONCE per reply, on the
 * server, for every lane and every caller. Before this, only the chat page's `end` handler read
 * Tool Notes, applied zip actions, saved inline memory, and burned the countdown, so a woken
 * turn, a schedule, isolated test driver, or the benchmark driver stored the raw blocks and applied none of
 * them. What the step does is tested in `replyControlFinalize.test.ts` (a headless reply); these
 * pins are where send-routed, `/api/sse`, and the page meet it.
 */
describe('send-routed: the reply-end control step (SA-129 DL-08)', () => {
  const handler = source.indexOf('\nasync function handleBatshitAgentStream({')
  const handlerSource = source.slice(handler, source.indexOf('\nfunction resolveGroupSpeakerAbout(', handler))
  const finalize = handlerSource.indexOf('  const finalizeAssistantMessage = async (')
  const finalizeEnd = handlerSource.indexOf('\n  // SA-018 (revised): Reasoning summaries stream as metadata', finalize)
  const finalizeSource = handlerSource.slice(finalize, finalizeEnd)

  it('runs inside finalizeAssistantMessage, the one writer of `end` and the saved record, for every context', () => {
    expect(finalize).toBeGreaterThan(-1)
    const step = finalizeSource.indexOf('replyControl = await finalizeReplyControl({')
    const cleaned = finalizeSource.indexOf('      endContent = replyControl.content')
    const merged = finalizeSource.indexOf('        Object.assign(endMetadataBase, replyControlMetadata)')
    const emitEnd = finalizeSource.indexOf('      await streamAdapter.emitEnd({')
    const save = finalizeSource.indexOf('      await redis.saveMessage(finalMessage)')
    expect(step).toBeGreaterThan(-1)
    expect(cleaned).toBeGreaterThan(step)
    expect(merged).toBeGreaterThan(cleaned)
    // BL-775: the record is saved first, then `end` is published with the saved bytes.
    expect(save).toBeGreaterThan(merged)
    expect(emitEnd).toBeGreaterThan(save)
    // `end` and the record carry the cleaned text: the rebuild of the stream's record, or this
    // copy (`sanitizedEndContent`, the cleaned words) when the record cannot be had.
    expect(finalizeSource.slice(merged, save)).toContain('endContent: typeof sanitizedEndContent')
    expect(finalizeSource.slice(merged, save)).toContain("let ownContent = typeof sanitizedEndContent === 'string' ? sanitizedEndContent : ''")
    expect(finalizeSource.slice(emitEnd)).toContain('content: finalMessage.content as string,')
  })

  it('an approval resume continues a message the chat already counted, so it never counts it again', () => {
    expect(finalizeSource).toContain('countsAsMessage: !isApprovalResumeWithoutUserTurn,')
  })

  it('an error outside every step still saves the cleaned reply with its notes, and never claims nothing was applied', () => {
    const fallback = finalizeSource.indexOf('} catch (controlError) {')
    expect(fallback).toBeGreaterThan(-1)
    const body = finalizeSource.slice(fallback, finalizeSource.indexOf('      endContent = replyControl.content', fallback))
    expect(body).toContain('content: extraction.cleaned,')
    expect(body).toContain("Batshit could not finish this reply's control step:")
    expect(body).toContain('Part of it may have been applied.')
    expect(body).not.toContain('Nothing you asked for')
  })

  it('a second finalize of the same reply reuses the first step: nothing is counted, saved, or held twice (BL-353)', () => {
    const reuse = finalizeSource.indexOf('\n      if (replyControlDone) {\n')
    const step = finalizeSource.indexOf('replyControl = await finalizeReplyControl({')
    const keep = finalizeSource.indexOf('\n        replyControlDone = replyControl\n')
    expect(reuse).toBeGreaterThan(-1)
    expect(step).toBeGreaterThan(reuse)
    expect(keep).toBeGreaterThan(step)
    // The reuse branch runs no step: the only call to the step is in the other branch.
    expect(finalizeSource.slice(reuse, finalizeSource.indexOf('      } else {', reuse))).not.toContain('finalizeReplyControl(')
    expect(handlerSource).toContain('\n  let replyControlDone: ReplyControlFinalizeResult | null = null\n')
    // The reused run's error lines are already on the metadata the failure path kept: once each.
    expect(finalizeSource).toContain(
      "\n            ...replyControlErrors.filter((record: unknown) => !seen.has(JSON.stringify(record))),\n"
    )
  })

  it('tells every tab when the step changed zip state, even when the save throws, once per reply (BL-537)', () => {
    const save = finalizeSource.indexOf('\n      try {\n        await redis.saveMessage(finalMessage)\n')
    // BL-775: stored, so a later throw sends it through no second save.
    expect(finalizeSource.slice(save, finalizeSource.indexOf('} finally {', save))).toContain('finalMessagePersisted = true')
    const publish = finalizeSource.indexOf('\n        await announceReplyControlZipChange()\n', save)
    expect(save).toBeGreaterThan(-1)
    expect(publish).toBeGreaterThan(save)
    // The notice reads the step's own result (never the reused copy) and is sent once.
    const announce = handlerSource.indexOf('\n  const announceReplyControlZipChange = async () => {\n')
    expect(announce).toBeGreaterThan(-1)
    const body = handlerSource.slice(announce, handlerSource.indexOf('\n  }\n', announce))
    expect(body).toContain('\n    const source = replyControlDone?.zipStateChanged\n    if (!source || replyControlAnnounced) return\n    replyControlAnnounced = true\n')
    expect(body).toContain("type: 'zip_state_changed',")
    // A first finalize that died before its notice, with no second finalize, still tells the tabs
    // on the way out of the stream handler.
    const outerFinally = handlerSource.lastIndexOf('    // BL-246: take back every abort relay first')
    const listenerFinally = handlerSource.indexOf('\n  } finally { turnListeners.abort() }\n}', outerFinally)
    expect(outerFinally).toBeGreaterThan(-1)
    expect(listenerFinally).toBeGreaterThan(outerFinally)
    const cleanup = handlerSource.slice(outerFinally, listenerFinally)
    const noticeFinally = cleanup.lastIndexOf('\n    } finally {\n')
    expect(noticeFinally).toBeGreaterThan(-1)
    expect(cleanup.slice(noticeFinally).endsWith('\n      await announceReplyControlZipChange()\n    }\n  }')).toBe(true)
    expect(handlerSource.slice(listenerFinally).startsWith('\n  } finally { turnListeners.abort() }\n}')).toBe(true)
  })

  it('the Judge Juice after-reply check still reads what the agent wrote, blocks included', () => {
    expect(handlerSource).toContain(
      'const finishedReply = rawFinishedReply ?? (finishSummary.content || finishSummary.text || \'\')'
    )
  })

  it("counts the user's message toward temporary holds once, at the accepted-send boundary, before Judge Juice's opens", () => {
    const boundary = handlerSource.indexOf('  if (consumeSessionClips && !isApprovalResumeWithoutUserTurn) {')
    const countdown = handlerSource.indexOf('      const countdown = await advanceZipCountdowns(sessionId)', boundary)
    // BL-527: Judge Juice's writes follow that block (a CLI control-approval resume, which counts
    // nothing, stores its lanes' opens too), so they still come after the count.
    const inferred = handlerSource.indexOf('      const stored = await writeInferredUnzips(', boundary)
    expect(countdown).toBeGreaterThan(boundary)
    expect(inferred).toBeGreaterThan(countdown)
    expect(handlerSource.slice(boundary, countdown)).toContain('if (countsNewUserMessage) {')
    expect(handlerSource).toContain(
      'const countsNewUserMessage =\n    consumeSessionClips && !isApprovalResumeWithoutUserTurn && !isContextContinuationRun'
    )
    // The compile reads zip state as it will be once this message counts.
    expect(handlerSource).toContain('      countsPendingUserMessage: countsNewUserMessage,')
  })

  // BL-412: at its start, but only once the round is known to run (after the "at least 2 agents"
  // refusal); the full order is pinned in `send-routed-group-contract.test.ts`.
  it('a group round counts the user message once, at its own start, before any member compiles', () => {
    const group = source.indexOf('\nasync function handleGroupChatStream({')
    const eligibility = source.indexOf('    if (eligibleAgents.length < 2) {', group)
    const countdown = source.indexOf('      const countdown = await advanceZipCountdowns(sessionId)', eligibility)
    const firstMember = source.indexOf('      const streamPromise = handleBatshitAgentStream({', group)
    expect(eligibility).toBeGreaterThan(group)
    expect(countdown).toBeGreaterThan(eligibility)
    expect(firstMember).toBeGreaterThan(countdown)
  })
})

describe('/api/sse and the page after SA-129 P2', () => {
  it("the reply's rebuild strips the same blocks, only when the server says it finalized them (BL-775: the rebuild moved to `replyStreamRecord.ts`)", () => {
    const record = readFileSync('src/lib/server/services/replyStreamRecord.ts', 'utf8')
    const strip = record.indexOf('    workingContent = stripReplyControlBlocks(workingContent)')
    expect(strip).toBeGreaterThan(-1)
    expect(record.slice(strip - 120, strip)).toContain('  if (input.replyControlFinalized) {')
    expect(source).toContain("replyControlFinalized: (sanitizedEndMetadata as any)?.[REPLY_CONTROL_FINALIZED_FLAG] === true,")
    // `/api/sse` rebuilds nothing: it hands `end` on as the finalize saved it.
    expect(sse).not.toContain('stripReplyControlBlocks')
  })

  it('the chat page extracts and applies nothing: it only renders what the server stored', () => {
    for (const gone of [
      'extractToolNotes(',
      'extractZipControl(',
      'extractMemoryControls(',
      "fetch('/api/memory/inline-saves'",
      'zippingService.unzip(\n',
      'resolveZipControlZipIds('
    ]) {
      expect(page, gone).not.toContain(gone)
    }
  })

  it("the browser's message store no longer counts messages toward temporary holds", () => {
    expect(messageStore).not.toContain('incrementMessageCount')
  })
})
