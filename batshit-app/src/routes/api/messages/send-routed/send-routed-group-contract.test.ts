import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

describe('send-routed group chat contracts', () => {
  const groupFn = source.indexOf('\nasync function handleGroupChatStream({')
  const groupSource = source.slice(groupFn, source.indexOf('\nfunction sessionDeletedResponse(', groupFn))
  const handlerFn = source.indexOf('\nasync function handleBatshitAgentStream({')
  const handlerSource = source.slice(handlerFn, source.indexOf('\nfunction resolveGroupSpeakerAbout(', handlerFn))
  const count = (text: string, needle: string) => text.split(needle).length - 1

  // BL-411 then BL-600: a "next message only" Clip was spent at the round's start, before any
  // member compiled (BL-411), then after the FIRST speaker's compile, so a later speaker got none
  // (BL-600). The round now spends it ONCE, when the round has ended, and only the Clips its
  // first compile read (`createGroupRoundClipSpend`, `drainGroupRoundThenSpend`; behaviour in
  // `groupRoundRules.test.ts` and `send-routed-clip-countdown-handler.test.ts`).
  it('BL-600: spends the Clip countdown once per group user message, after the round, for what its first compile read', () => {
    expect(groupFn).toBeGreaterThan(-1)
    expect(handlerFn).toBeGreaterThan(-1)
    // The round's only Clip spend is the round's one, created after the eligibility check.
    expect(count(groupSource, 'consumePostCompileSessionClips(')).toBe(1)
    const eligibility = groupSource.indexOf('\n    if (eligibleAgents.length < 2) {\n')
    const roundSpend = groupSource.indexOf(
      '\n    const groupRoundClipSpend = createGroupRoundClipSpend({\n      readCountdownClipIds: () => readCountdownClipIds(sessionId),\n      spend: (clipIds) => consumePostCompileSessionClips(sessionId, clipIds),\n    })\n',
    )
    expect(eligibility).toBeGreaterThan(-1)
    expect(roundSpend).toBeGreaterThan(eligibility)
    // Every member run gets it, and still spends nothing else of a new user message.
    const speakerStream = groupSource.indexOf('const streamPromise = handleBatshitAgentStream({', roundSpend)
    const speakerStreamEnd = groupSource.indexOf('\n      })\n', speakerStream)
    const speakerCall = groupSource.slice(speakerStream, speakerStreamEnd)
    expect(speakerStream).toBeGreaterThan(roundSpend)
    expect(speakerCall).toContain('\n        consumeSessionClips: false,\n')
    expect(speakerCall).toContain('\n        groupRoundClipSpend,\n')
    // The round's queue runs through the spend: the spend comes when the queue is done.
    expect(count(groupSource, 'await drainQueue()')).toBe(0)
    const drain = groupSource.indexOf(
      '\n    await drainGroupRoundThenSpend(drainQueue, groupRoundClipSpend)\n',
      speakerStreamEnd,
    )
    expect(drain).toBeGreaterThan(speakerStreamEnd)
    // In the member's run the record waits for its compile and the setup Stop checkpoint, beside
    // the single-agent spend.
    const compile = handlerSource.indexOf('const formattedInput = await databaseService.buildFormattedChatInput(')
    const setupCheckpoint = handlerSource.indexOf('const abortedDuringSetup = Boolean(streamAbortSignal.aborted)', compile)
    const singleSpend = handlerSource.indexOf(
      '\n  if (consumeSessionClips && !isApprovalResumeWithoutUserTurn) {\n',
      setupCheckpoint,
    )
    const memberRecord = handlerSource.indexOf(
      '\n  if (groupRoundClipSpend) {\n    await groupRoundClipSpend.noteCompiled()\n  }\n',
      setupCheckpoint,
    )
    expect(compile).toBeGreaterThan(-1)
    expect(setupCheckpoint).toBeGreaterThan(compile)
    expect(singleSpend).toBeGreaterThan(setupCheckpoint)
    expect(memberRecord).toBeGreaterThan(setupCheckpoint)
    expect(count(handlerSource, 'groupRoundClipSpend.noteCompiled()')).toBe(1)
    expect(count(handlerSource, 'groupRoundClipSpend.settle()')).toBe(0)
  })

  // SA-129 P2 (DL-08) and BL-412: the round counts every "Hold for N messages" once, at its
  // start, before any member compiles, and only once it is known to run: after the "at least 2
  // agents" refusal and after a Stop or delete that landed first.
  it('SA-129 P2 / BL-412: counts the hold countdown once per round, after the refusals and the Stop check, before any member compiles', () => {
    expect(count(groupSource, 'advanceZipCountdowns(')).toBe(1)
    const stopRelay = groupSource.indexOf('relayAbort({ from: turnStopSignal, to: groupAbortController')
    const eligibility = groupSource.indexOf('\n    if (eligibleAgents.length < 2) {\n')
    const holdCount = groupSource.indexOf(
      '\n    if (!groupAbortController.signal.aborted) {\n      const countdown = await advanceZipCountdowns(sessionId)\n',
    )
    const speakerStream = groupSource.indexOf('const streamPromise = handleBatshitAgentStream({')
    expect(stopRelay).toBeGreaterThan(-1)
    expect(eligibility).toBeGreaterThan(stopRelay)
    expect(holdCount).toBeGreaterThan(eligibility)
    expect(speakerStream).toBeGreaterThan(holdCount)
    // Nothing is spent before the Stop relay and the refusal: the old spend sat above both.
    expect(groupSource.slice(0, eligibility)).not.toContain('advanceZipCountdowns(')
    expect(groupSource.slice(0, eligibility)).not.toContain('consumePostCompileSessionClips(')
    // A member's own run never counts it again: its count is gated on `consumeSessionClips`,
    // which every member run sets to false.
    expect(handlerSource).toContain(
      '\n  const countsNewUserMessage =\n    consumeSessionClips && !isApprovalResumeWithoutUserTurn && !isContextContinuationRun\n',
    )
    expect(count(handlerSource, 'advanceZipCountdowns(')).toBe(1)
    expect(handlerSource).toContain('\n    if (countsNewUserMessage) {\n      const countdown = await advanceZipCountdowns(sessionId)\n')
  })

  // BL-410 (and BL-356's group double count): an approval click in a group chat is refused
  // before the answer is recorded, before the turn lock, and before any countdown; it never
  // reaches the group runner, so it can never start a round.
  it('BL-410: refuses an approval click in a group chat before it is recorded or starts a round', () => {
    const post = source.indexOf('\nexport const POST')
    const clickDecision = source.indexOf('\n    const approvalClick = isApprovalClick({\n', post)
    const refusal = source.indexOf(
      '\n    if (refusesGroupApprovalClick({ groupSession: groupRunnerSession, approvalClick })) {\n      return json(GROUP_APPROVAL_CLICK_REFUSAL, { status: 409 })\n    }\n',
      post,
    )
    const groupTest = source.indexOf(
      '\n    const groupRunnerSession = Boolean(\n      groupConfig && Array.isArray(groupConfig.agent_ids) && groupConfig.agent_ids.length >= 2,\n    )\n',
      clickDecision,
    )
    const dispatchTest = source.indexOf(
      '\n        const hasGroupConfig = Boolean(\n          groupConfig &&\n          Array.isArray(groupConfig.agent_ids) &&\n          groupConfig.agent_ids.length >= 2,\n        )\n',
      post,
    )
    const clickWait = source.indexOf('await waitForCardReplyToFinish(', post)
    const answerRecord = source.indexOf('await answerApprovalsOnce({', post)
    const groupDispatch = source.indexOf('return await handleGroupChatStream({', post)
    expect(post).toBeGreaterThan(-1)
    expect(clickDecision).toBeGreaterThan(post)
    expect(groupTest).toBeGreaterThan(clickDecision)
    expect(refusal).toBeGreaterThan(groupTest)
    // The refusal's test is the dispatch's own, so every click that would reach the runner is refused.
    expect(dispatchTest).toBeGreaterThan(refusal)
    expect(clickWait).toBeGreaterThan(refusal)
    expect(answerRecord).toBeGreaterThan(refusal)
    expect(groupDispatch).toBeGreaterThan(refusal)
  })

  // SA-120 P3: the Judge Juice speaker decision happens in the scheduler, before the speaker's
  // stream, and only when today's rules do not already decide. The logic lives in
  // `groupSpeaker.jev.ts` (its own suite); these pins hold the ORDER inside send-routed.
  it('asks Judge Juice after the preset rules and before the speaker stream, and skips a gated follow-up without streaming', () => {
    const groupStart = source.indexOf('const normalizedConfig = normalizeGroupChatConfig(groupConfig)')
    const candidatesDone = source.indexOf('if (candidates.length === 0) return', groupStart)
    const rulesDecide = source.indexOf('const rulesDecide =', candidatesDone)
    const jevCall = source.indexOf('jevOutcome = await computeGroupSpeakerSelection({', rulesDecide)
    const skipRecord = source.indexOf('await recordSkippedGroupFollowup(', jevCall)
    const skipReturn = source.indexOf('return', skipRecord)
    const selection = source.indexOf('let selected = eligible.length === 1 ? eligible[0] : null', skipRecord)
    const jevPick = source.indexOf('if (!selected && jevPickedAgentId) {', selection)
    const namedEligible = source.indexOf('const namedEligible = eligible.filter((candidate) => addressedCandidates.includes(candidate))', jevPick)
    const randomPick = source.indexOf('selected = pickRandom(namedEligible.length > 0 ? namedEligible : eligible)', namedEligible)
    const speakerStream = source.indexOf('const streamPromise = handleBatshitAgentStream({', randomPick)
    const streamSelection = source.indexOf('jevJuiceGroupSelection,', speakerStream)
    const streamEnd = source.indexOf('})', speakerStream)

    expect(candidatesDone).toBeGreaterThan(groupStart)
    expect(rulesDecide).toBeGreaterThan(candidatesDone)
    expect(jevCall).toBeGreaterThan(rulesDecide)
    expect(skipRecord).toBeGreaterThan(jevCall)
    expect(skipReturn).toBeGreaterThan(skipRecord)
    expect(selection).toBeGreaterThan(skipReturn)
    // Explicit beats inferred: the addressed and driver picks come before Jev's, and random last.
    const addressedPick = source.indexOf('if (!selected && addressedCandidates.length === 1) {', selection)
    const driverPick = source.indexOf('if (!selected && driverCandidate) {', addressedPick)
    expect(addressedPick).toBeGreaterThan(selection)
    expect(driverPick).toBeGreaterThan(addressedPick)
    expect(jevPick).toBeGreaterThan(driverPick)
    // Several explicit names constrain even the rules fallback; derive that pool after
    // Jev's pick was considered and immediately before choosing the random speaker.
    expect(namedEligible).toBeGreaterThan(jevPick)
    expect(source.slice(namedEligible, randomPick).trim()).toBe('const namedEligible = eligible.filter((candidate) => addressedCandidates.includes(candidate))')
    expect(randomPick).toBeGreaterThan(namedEligible)
    expect(speakerStream).toBeGreaterThan(randomPick)
    expect(streamSelection).toBeGreaterThan(speakerStream)
    expect(streamSelection).toBeLessThan(streamEnd)
  })

  it('carries the previous speaker message id on the follow-up event so a skipped follow-up has a snapshot to record on', () => {
    const followupPush = source.indexOf("type: 'agent',\n              content: groupContent,")
    const pushEnd = source.indexOf('})', followupPush)
    const pushBody = source.slice(followupPush, pushEnd)
    expect(followupPush).toBeGreaterThan(-1)
    expect(pushBody).toContain('sourceMessageId: result.messageId')
    expect(source).toContain("const speakerSelection: GroupSpeakerSelectionMetadata | null = jevOutcome")
    expect(source).toContain('...(speakerSelection ? { speakerSelection } : {}),')
  })

  it('persists selected speaker failures with visible group failure metadata', () => {
    const groupFailureLog = source.indexOf("[GroupChat] Agent stream failed.")
    const failurePersistence = source.indexOf('await persistFailedAssistantTurn({', groupFailureLog)
    const failureMetadata = source.slice(failurePersistence, source.indexOf('})', failurePersistence))

    expect(groupFailureLog).toBeGreaterThan(-1)
    expect(failurePersistence).toBeGreaterThan(groupFailureLog)
    expect(failureMetadata).toContain('messageId: selectedMessageId')
    expect(failureMetadata).toContain('groupTurnId')
    expect(failureMetadata).toContain('failedSpeakerAgentId: agentRow.id')
    expect(failureMetadata).toContain('failedSpeakerName: agentName')
  })

  it('announces a group speaker failure that can happen before the speaker stream opens', () => {
    const groupFailureLog = source.indexOf("[GroupChat] Agent stream failed.")
    const failurePersistence = source.indexOf('await persistFailedAssistantTurn({', groupFailureLog)
    const groupFailureEnd = source.indexOf('\n      } finally {', failurePersistence)
    const failureCall = source.slice(failurePersistence, groupFailureEnd)

    expect(groupFailureLog).toBeGreaterThan(-1)
    expect(failurePersistence).toBeGreaterThan(groupFailureLog)
    expect(groupFailureEnd).toBeGreaterThan(failurePersistence)
    // An API speaker can throw during setup before `ensureStartEmitted()`. With no stream
    // event, spectator tabs need the same user-channel refresh as a failed single-agent turn.
    expect(failureCall).toContain('noStreamEvent: true')
  })

  // SA-128: BL-208 and DP-1 live in the scheduler, so these pins hold them in place. The
  // compile side of the same flow is compile contract S34.
  it('keeps the user message out of history on its own event, and tells the compiler who wrote each event', () => {
    const builder = source.indexOf('const buildHistoryMessages = (event: GroupChatEvent) => [')
    const builderEnd = source.indexOf(']', source.indexOf('...assistantHistory,', builder))
    const builderBody = source.slice(builder, builderEnd)
    expect(builder).toBeGreaterThan(-1)
    expect(builderBody).toContain("...(event.type === 'user' ? [] : [initialUserMessage]),")
    expect(source).toContain('const historyMessages = buildHistoryMessages(event)')

    const speakerStream = source.indexOf('const streamPromise = handleBatshitAgentStream({')
    const streamEnd = source.indexOf('})\n', source.indexOf('currentMessageFrom: resolveCurrentMessageFrom({', speakerStream))
    const streamBody = source.slice(speakerStream, streamEnd)
    expect(streamBody).toContain('currentMessageFrom: resolveCurrentMessageFrom({')
    expect(streamBody).toContain('groupEventType: event.type,')

    // BL-209: a reply joins this round's history under its SPEAKER's id, so the next speaker
    // in the same round names it (`<agent name>`) instead of reading it as its own.
    const push = source.indexOf('assistantHistory.push({', speakerStream)
    const pushBody = source.slice(push, source.indexOf('})', push))
    expect(pushBody).toContain('agent_id: agentRow.id,')
  })
})
