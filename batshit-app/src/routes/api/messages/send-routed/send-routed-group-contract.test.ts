import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

describe('send-routed group chat contracts', () => {
  it('consumes session clips once per accepted group turn before speaker dispatch', () => {
    const groupStart = source.indexOf('const normalizedConfig = normalizeGroupChatConfig(groupConfig)')
    const groupDisabledBranch = source.indexOf('if (!normalizedConfig?.enabled)', groupStart)
    const groupConsume = source.indexOf('await consumePostCompileSessionClips(sessionId)', groupDisabledBranch)
    const groupAbortRegistration = source.indexOf('const groupAbortController = new AbortController()', groupConsume)
    const speakerStream = source.indexOf('const streamPromise = handleBatshitAgentStream({', groupAbortRegistration)
    const speakerClipOptOut = source.indexOf('consumeSessionClips: false', speakerStream)

    expect(groupStart).toBeGreaterThan(-1)
    expect(groupDisabledBranch).toBeGreaterThan(groupStart)
    expect(groupConsume).toBeGreaterThan(groupDisabledBranch)
    expect(groupAbortRegistration).toBeGreaterThan(groupConsume)
    expect(speakerClipOptOut).toBeGreaterThan(speakerStream)
  })

  // SA-120 P3: the Jev Juice speaker decision happens in the scheduler, before the speaker's
  // stream, and only when today's rules do not already decide. The logic lives in
  // `groupSpeaker.jev.ts` (its own suite); these pins hold the ORDER inside send-routed.
  it('asks Jev Juice after the preset rules and before the speaker stream, and skips a gated follow-up without streaming', () => {
    const groupStart = source.indexOf('const normalizedConfig = normalizeGroupChatConfig(groupConfig)')
    const candidatesDone = source.indexOf('if (candidates.length === 0) return', groupStart)
    const rulesDecide = source.indexOf('const rulesDecide =', candidatesDone)
    const jevCall = source.indexOf('jevOutcome = await computeGroupSpeakerSelection({', rulesDecide)
    const skipRecord = source.indexOf('await recordSkippedGroupFollowup(', jevCall)
    const skipReturn = source.indexOf('return', skipRecord)
    const selection = source.indexOf('let selected = eligible.length === 1 ? eligible[0] : null', skipRecord)
    const jevPick = source.indexOf('if (!selected && jevPickedAgentId) {', selection)
    const randomPick = source.indexOf('selected = pickRandom(eligible)', jevPick)
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
    expect(randomPick).toBeGreaterThan(jevPick)
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
})
