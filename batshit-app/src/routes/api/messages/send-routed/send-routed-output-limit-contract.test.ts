import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * BL-239: a reply whose last model request stopped at the OUTPUT limit (finish reason `length`).
 * The AI SDK ends that stream normally, so the reply used to be saved and shown as finished (on
 * the SA-126 benchmark instance GLM 5.3 thought for 65,534 tokens and the whole reply was "I"),
 * and one that wrote nothing at all was reported as an empty provider response. The rule is
 * `outputLimitStop.ts` (tested there); these pins are where the stream handler reads it.
 */
describe('send-routed: a reply that stopped at the output limit', () => {
  const handler = source.indexOf('\nasync function handleBatshitAgentStream({')
  const handlerSource = source.slice(handler, source.indexOf('\nfunction resolveGroupSpeakerAbout(', handler))

  it('the loop records the last request\'s finish reason and output count', () => {
    const finishStep = handlerSource.indexOf("        case 'finish-step': {")
    const finish = handlerSource.indexOf("        case 'finish': {", finishStep)
    expect(finishStep).toBeGreaterThan(-1)
    expect(finish).toBeGreaterThan(finishStep)
    expect(handlerSource.slice(finishStep, finish)).toContain(
      'lastStepOutputTokens = outputTokensForUsage((chunk as any).usage) ?? null'
    )
    expect(handlerSource.slice(finish, finish + 400)).toContain(
      'streamFinishReason = finishChunk.finishReason ?? null'
    )
  })

  it('a reply that wrote nothing is the output limit, checked BEFORE the empty-response error', () => {
    const emptyCheck = handlerSource.indexOf('    if (!silentResponse && !hasVisibleAssistantOutput) {')
    const limit = handlerSource.indexOf('      if (isOutputLimitFinish(streamFinishReason)) {', emptyCheck)
    const limitThrow = handlerSource.indexOf('          OUTPUT_LIMIT_ERROR_CODE,', limit)
    const empty = handlerSource.indexOf("        'PROVIDER_EMPTY_RESPONSE',", emptyCheck)
    expect(emptyCheck).toBeGreaterThan(-1)
    expect(limit).toBeGreaterThan(emptyCheck)
    expect(limitThrow).toBeGreaterThan(limit)
    expect(empty).toBeGreaterThan(limitThrow)
    expect(handlerSource.slice(limit, limitThrow)).toContain('wroteReply: false')
  })

  it('a reply that wrote something is finalized as an output-limit failure, joined into its own end metadata', () => {
    const successElse = handlerSource.indexOf(
      "      if (isOutputLimitFinish(streamFinishReason)) {\n        replyOutputLimitFailure = outputLimitFailureMetadata(\n          describeOutputLimitStop({ outputTokens: lastStepOutputTokens, wroteReply: true }),\n        )\n      }\n      await finalizeAssistantMessage('postStream')\n      await streamAdapter.emitComplete()\n"
    )
    expect(successElse).toBeGreaterThan(-1)

    // Inside finalize: joined into the base BEFORE the save and the `end` event (BL-775: saved
    // first, then published), never replacing it.
    const finalize = handlerSource.indexOf('  const finalizeAssistantMessage = async (')
    const join = handlerSource.indexOf(
      '      if (replyOutputLimitFailure) Object.assign(endMetadataBase, replyOutputLimitFailure)',
      finalize
    )
    const base = handlerSource.indexOf('      const endMetadataBase =', finalize)
    const emitEnd = handlerSource.indexOf('      await streamAdapter.emitEnd({', finalize)
    const save = handlerSource.indexOf('      await redis.saveMessage(finalMessage)', finalize)
    expect(finalize).toBeGreaterThan(-1)
    expect(join).toBeGreaterThan(base)
    expect(save).toBeGreaterThan(join)
    expect(emitEnd).toBeGreaterThan(save)
  })

  it('both failure writers keep the kind, and the turn answers like an empty response', () => {
    // One place: the shared failure metadata that the partial writer spreads and the empty
    // writer passes whole (`send-routed-approval-resume-contract.test.ts` pins those two uses).
    const shared = handlerSource.indexOf('    const failureRuntimeMetadata = {')
    const writers = handlerSource.indexOf('    // A failed stream must never erase work', shared)
    expect(shared).toBeGreaterThan(-1)
    expect(writers).toBeGreaterThan(shared)
    expect(handlerSource.slice(shared, writers)).toContain(
      '      ...(errorCode === OUTPUT_LIMIT_ERROR_CODE ? { failure_kind: OUTPUT_LIMIT_FAILURE_KIND } : {}),'
    )
    // The partial writer's own context-exhaustion kind comes AFTER the spread, so it still wins.
    const spread = handlerSource.indexOf('          ...failureRuntimeMetadata,', writers)
    const contextKind = handlerSource.indexOf("          ...(contextExhausted ? { failure_kind: 'context_exhausted' } : {}),", spread)
    expect(spread).toBeGreaterThan(writers)
    expect(contextKind).toBeGreaterThan(spread)
    expect(handlerSource).toContain(
      "    if (errorCode === 'PROVIDER_EMPTY_RESPONSE' || errorCode === OUTPUT_LIMIT_ERROR_CODE) {"
    )
  })
})
