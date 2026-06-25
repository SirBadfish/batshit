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
})
