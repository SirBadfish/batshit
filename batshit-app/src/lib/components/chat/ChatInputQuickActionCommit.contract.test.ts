import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/lib/components/chat/ChatInput.svelte', 'utf8')

describe('ChatInput quick-action commit seam', () => {
  it('runs the delayed verdict through the generation-owned behavioral seam', () => {
    const commitStart = source.indexOf('async function commitVoiceModeTurn(')
    const commitEnd = source.indexOf('function quickActionVoiceModeSettings()', commitStart)
    const commit = source.slice(commitStart, commitEnd)

    expect(commitStart).toBeGreaterThan(-1)
    expect(commit).toContain('voiceQuickActionCommits.begin(currentVoiceQuickActionContext())')
    expect(commit).toContain('runVoiceQuickActionCommit<QuickActionVerdict, QuickActionMark>')
    expect(commit).toContain('requestQuickActionVerdict(gate.said, finalMessage, pending)')
    expect(commit).toContain('currentContext: currentVoiceQuickActionContext')
    expect(commit).toContain('composerSessionId: pending.context.sessionId')
    expect(commit).toContain('beforeSend,')
    expect(commit).toContain('mayResetComposer: snapshotStillOwnsComposer')
    expect(commit).toContain('voiceQuickActionCommits.ownsLatestGeneration(pending)')
    expect(commit).toContain("await onQuickActionMessage(finalMessage, mark)\n          if (snapshotStillOwnsComposer()) message = ''")
    expect(commit).toContain('waitingForAI = false')
  })

  it('returns send acceptance and resets only the captured text and clips for a delayed voice turn', () => {
    const sendStart = source.indexOf('async function sendMessageWithText(')
    const sendEnd = source.indexOf('async function stopDictationBeforeSend()', sendStart)
    const send = source.slice(sendStart, sendEnd)

    expect(send).toContain('): Promise<boolean>')
    expect(send).toContain('if (overrides?.mayResetComposer && !overrides.mayResetComposer()) return')
    expect(send).toContain("...(overrides?.mayResetComposer ? { clipIds: sentClipIds } : {})")
    expect(send).toContain('onQueuedForLater: () => resetAcceptedComposer()')
    expect(send).toContain('if (sendAccepted === false)')
    expect(send).toContain('return true')
  })

  it('invalidates on context changes, explicit Voice End, and unmount', () => {
    expect(source).toContain('voiceQuickActionCommitContextKey')
    expect(source).toContain('return () => invalidatePendingVoiceQuickActionCommit(ownedContext)')

    const end = source.slice(
      source.indexOf('function endDirectVoiceMode('),
      source.indexOf('function releaseLiveKitMicrophone(')
    )
    expect(end).toContain('invalidatePendingVoiceQuickActionCommit()')

    const mountCleanup = source.slice(
      source.indexOf('onMount(() => {'),
      source.indexOf('// File upload now handled through ClipsManager')
    )
    expect(mountCleanup).toContain('invalidatePendingVoiceQuickActionCommit()')
  })

  it('lets the end-voice quick action persist its own captured marked turn', () => {
    const actionStart = source.indexOf('function runQuickAction(')
    const actionEnd = source.indexOf('// Handle mic button', actionStart)
    const action = source.slice(actionStart, actionEnd)

    expect(action).toContain("case 'end_voice_mode':")
    expect(action).toContain('endDirectVoiceMode({ notify: true, preservePendingCommit: true })')
  })
})
