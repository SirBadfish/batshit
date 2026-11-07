import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * SA-139 P2 Part 3: where send-routed hands a Primary reply to the Claude plan connection. The
 * consumer and admission themselves are proven on the real brain (`vercelBrain.claudePlan.test.ts`)
 * and the real delegated runner (`claudePlanDelegation.test.ts`); these pins hold the three
 * send-routed lines. Real-handler cases (`send-routed-reply-record-handler.test.ts`) come with P3,
 * which changes this finalize for a run held at an approval card.
 */
describe('send-routed: a Primary reply on the Claude plan connection', () => {
  const handler = source.indexOf('\nasync function handleBatshitAgentStream({')
  const handlerSource = source.slice(handler, source.indexOf('\nfunction resolveGroupSpeakerAbout(', handler))
  const requestStart = handlerSource.indexOf('  const buildStreamRequest = (')
  const requestSource = handlerSource.slice(requestStart, handlerSource.indexOf('\n  }\n', handlerSource.indexOf('    return {', requestStart)))

  it('names the Primary consumer and hands the raw-record sampling copies to admission', () => {
    expect(requestStart).toBeGreaterThan(0)
    expect(requestSource).toContain("claudePlanConsumer: 'primary',")
    expect(requestSource).toContain('claudePlanSampling: primaryModelFallbacks ?? null,')
    // The same fallbacks the model settings use (BL-515): a preset-backed agent has none.
    expect(handlerSource).toMatch(/const primaryModelFallbacks = resolveAgentModelFallbacks\(\{\s*preset: primaryPreset,\s*agent: agentMetadata,\s*\}\)/)
    expect(handlerSource).toContain('fallbacks: primaryModelFallbacks,')
  })

  it('P3 Part 3 (D6): each reply carries its hold key version and the run its approval click claimed (taken once)', () => {
    expect(requestSource).toContain('claudePlanApprovalVersion: approvalResumeStart?.version ?? 0,')
    expect(requestSource).toContain('claudePlanHeld: takeClaudePlanClaim(request),')
    expect(source).toContain('requestClaudePlanClaims.delete(request)')
  })

  it('P3 Part 3 (D6, Ashe M2; review B M1, S1): the click is planned before anything is recorded; only a live run is claimed, under the lock, for exactly the clicked calls', () => {
    const planAt = source.indexOf("claudePlanClick = planClaudePlanClick({ record: cardRecord, responses: approvalResponseForStream, sessionId, messageId: requestedMessageId,\n              current: normalizePrimaryAgentType(agent) === 'api' && isClaudePlanSelection(clickSelection.connection) })")
    const answerAt = source.indexOf('          approvalAnswer = await answerApprovalsOnce({')
    expect(planAt).toBeGreaterThan(0)
    expect(answerAt).toBeGreaterThan(planAt)
    // A gone run's answer is recorded as not run, before the record is written.
    expect(source.slice(planAt, answerAt)).toContain("const reason = claudePlanGoneReason(claudePlanClick.why)")
    // Every answer is recorded as not run; a denial keeps its own reason (review A N2).
    expect(source.slice(planAt, answerAt)).toContain("approvalResponseForStream = approvalResponseForStream.map(entry => ({ ...entry, approved: false,\n                reason: entry.approved === false && typeof entry.reason === 'string' && entry.reason ? entry.reason : reason }))")
    // Claimed in the plan step itself, before any write; a run whose clock ran out is gone, never a 409.
    const planned = source.slice(planAt, answerAt)
    expect(planned).toContain('const claim = claimHeldClaudePlanRun(claudePlanClick.key, { userId: resolvedUserId, agentId: agent.id }, claudePlanClick.toolCallIds)')
    expect(planned).toContain("else claudePlanClick = { kind: 'gone', why: 'run_ended' }")
    expect(planned.indexOf("claudePlanClick = { kind: 'gone', why: 'run_ended' }")).toBeLessThan(planned.indexOf("if (claudePlanClick?.kind === 'gone') {"))
    // Review A M1: a Claude plan reply's card with the agent now elsewhere is gone, and the held run ends, before any claim.
    const away = planned.indexOf("if (claudePlanClick?.kind === 'gone' && claudePlanClick.why === 'switched_away') {\n              void endHeldClaudePlanRuns({ sessionId }, CLAUDE_PLAN_SWITCHED_AWAY_REASON)")
    expect(away).toBeGreaterThan(0)
    expect(planned).not.toContain('claudePlanClick = null')
    expect(away).toBeLessThan(planned.indexOf("if (claudePlanClick?.kind === 'live') {"))
    // An answer that was not recorded ends the claimed run; an unused claim ends with the request.
    expect(source).toContain('            takeClaudePlanClaim(request)?.run.stop()')
    const release = source.indexOf('\t      releaseSessionTurn(sessionId, sessionTurnId, {')
    expect(source.slice(release - 200, release)).toContain('takeClaudePlanClaim(request)?.run.stop()')
  })

  it('P3 Part 3 (review B S1): a gone run starts no turn; the card and its held words say the run ended', () => {
    const gone = source.indexOf("\n          if (claudePlanClick?.kind === 'gone') {")
    expect(gone).toBeGreaterThan(0)
    const branch = source.slice(gone, gone + 1400)
    expect(branch).toContain("reason: 'approval_expired' })")
    expect(branch).toContain("approvalResume: 'denied',")
    expect(branch).toContain('reason: `claude_plan_${claudePlanClick.why}`,')
    expect(branch).toContain('await markClaudePlanCardRunEnded({ sessionId, userId: resolvedUserId, messageId: requestedMessageId.trim(),')
    expect(branch).not.toContain('handleBatshitAgentStream')
  })

  it('P3 Part 3 (D6, review B S2): the person\'s own new message (not a click, not a woken or scheduled turn) ends a run held at a card (as Stop in the gap)', () => {
    const accept = source.indexOf('    acceptTurn?.({ sessionId, userId: resolvedUserId })\n    // SA-139 D6')
    expect(accept).toBeGreaterThan(0)
    expect(source.slice(accept, accept + 900)).toContain("if (!approvalClick && !(internalRequest && typeof requestedMessageId === 'string' && isWokenTurnMessage(sessionId, requestedMessageId.trim()))) {\n      void endHeldClaudePlanRuns({ sessionId }")
  })

  it('Faye S1 (P3 Part 3 read): a Claude plan reply\'s record says so, in its start and its end', () => {
    expect(source).toContain("const claudePlanReply = primaryAgentType === 'api' && isClaudePlanSelection(primarySelection.connection)\n")
    // Review A S1: the save merges metadata, so a later part of a reply that was a Claude plan reply says false.
    expect(source).toContain("const claudePlanReplyMark = claudePlanReply ? { claudePlanReply: true } : (approvalResumePrior?.metadata as any)?.claudePlanReply === true ? { claudePlanReply: false } : {}")
    expect(source).toContain('      ...(approvalResumeStart ? { approvalResumeVersion: approvalResumeStart.version } : {}),\n      ...claudePlanReplyMark,\n')
    expect(source).toContain('      if (approvalResumeStart) endMetadataBase.approvalResumeVersion = approvalResumeStart.version\n      Object.assign(endMetadataBase, claudePlanReplyMark)\n')
  })

  it('review B S1 (P3 Part 4): the tools know before the claim is taken that this segment resumes a held run, so the pictures held at its card are not sent again', () => {
    const decided = source.indexOf('  const claudePlanResumesHeldRun = requestClaudePlanClaims.has(request)\n')
    const prepared = source.indexOf('    preparedApiToolset = await nativeRuntime.prepareApiToolset({ ...apiToolFields, messages: [] })')
    expect(decided).toBeGreaterThan(0)
    expect(prepared).toBeGreaterThan(decided)
    expect(source.slice(prepared - 200, prepared)).toContain('abortSignal: streamAbortSignal, claudePlanResumesHeldRun\n')
    expect(requestSource).toContain('    claudePlanResumesHeldRun,\n    claudePlanHeld: takeClaudePlanClaim(request),')
  })

  it('Faye S2 (P3 Part 3 read): a continuation refused for a changed model marks the card as ended once the failed record is saved', () => {
    const at = source.indexOf('  } catch (primaryError) {\n    const terminalError = preserveAcquisitionFailureVersion(primaryError)\n    await closeStartedAcquisitionFailure(terminalError)\n')
    expect(at).toBeGreaterThan(0)
    const block = source.slice(at, at + 1400)
    expect(block).toContain("if (approvalResumeStart && primaryError instanceof ClaudePlanRunError && primaryError.code === 'resume_changed') {\n      await markClaudePlanCardRunEnded({ sessionId, userId, messageId, eventFetch, request,")
    expect(block.indexOf('markClaudePlanCardRunEnded')).toBeLessThan(block.indexOf('throw terminalError'))
  })

  it('BL-2358 (P3 Part 4): the reply\'s steer run tells an agent DM the Claude plan connection\'s note limit, and no other connection a limit', () => {
    const register = source.indexOf('  registerSteerRun(sessionId, {\n    messageId,\n    steerable: steerVerdict.steerable,')
    expect(register).toBeGreaterThan(0)
    expect(source.slice(register, register + 600)).toContain("...(primaryAgentType === 'api' && isClaudePlanSelection(primaryConnection) ? { dmSteerLimit: CLAUDE_PLAN_HOOK_NOTE_LIMIT } : {}),\n  })")
    expect(source.match(/dmSteerLimit/g)).toHaveLength(1)
  })

  it('Faye S14 (P3 Part 2): a plan limit answers 429 with its code, through the same plan status the ChatGPT plan uses', () => {
    expect(source).toContain('return chatgptPlanHttpStatus(error) ?? claudePlanHttpStatus(error) ?? claudePlanRunHttpStatus(error)')
    // The failure answer uses the plan status for its HTTP status, words and code.
    expect(handlerSource).toContain("error: planHttpStatus(error) !== null ? surfacedErrorMessage : 'Failed to stream response',")
    expect(handlerSource).toContain('...(planHttpStatus(error) !== null && errorCode ? { code: errorCode } : {}),')
  })

  it('review B N1 (P3 Part 1): a Claude plan failure that names an API key keeps its own words, never the missing-provider-key sentence', () => {
    expect(handlerSource).toContain("if (error instanceof Error && !(error instanceof ClaudePlanRunError) && error.message?.includes('API key')) {")
  })

  it('ends the reply\'s Claude plan run in the stream request\'s finalize, right after the relays are taken back', () => {
    expect(handlerSource).toMatch(/\} finally \{\n    \/\/ BL-246: take back every abort relay first, so nothing outside keeps this scope alive\.\n    turnListeners\.abort\(\)\n(    \/\/[^\n]*\n)*    streamResult\?\.__claudePlanModel\?\.endReply\(\)\n/)
  })
})
