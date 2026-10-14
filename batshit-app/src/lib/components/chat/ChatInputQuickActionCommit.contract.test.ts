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
    // The guarded reset is the acceptance's (BL-713 removed the page queue's own reset).
    expect(send).toContain('\n      resetAcceptedComposer()\n    }\n')
    expect(send).not.toContain('onQueuedForLater')
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
    expect(end).toContain('if (!options.preservePendingCommit) invalidatePendingVoiceQuickActionCommit()')

    const invalidator = source.slice(
      source.indexOf('function invalidatePendingVoiceQuickActionCommit('),
      source.indexOf('\n  $effect(() => {', source.indexOf('function invalidatePendingVoiceQuickActionCommit('))
    )
    expect(invalidator).toContain('voiceQuickActionCommits.invalidate()')
    expect(invalidator).toContain('if (invalidated) waitingForAI = false')

    const mountCleanup = source.slice(
      source.indexOf('onMount(() => {'),
      source.indexOf('// File upload now handled through ClipsManager')
    )
    expect(mountCleanup).toContain('invalidatePendingVoiceQuickActionCommit()')
  })

  it('dispatches through the fixed voice projection with the current owners', () => {
    const actionStart = source.indexOf('function runQuickAction(')
    const actionEnd = source.indexOf('// Handle mic button', actionStart)
    const action = source.slice(actionStart, actionEnd)

    expect(source).toContain("from '$lib/appActions/voice/quickActionExecutor'")
    expect(action).toContain('executeVoiceQuickAction(verdict, {')
    expect(action).toContain('stopPlayback: () => voiceService.stopAll()')
    expect(action).toContain('requestWorkStop: () => { void handleStopWorkClick() }')
    expect(action).toContain('endVoiceMode: options => endDirectVoiceMode(options)')
    expect(action).toContain('openExecutionViewer: () => onOpenExecutionViewer(sessionId)')
    expect(action).toContain('quickActionSettingsTabTarget(selectedTab)')
    expect(action).toContain('new CustomEvent(QUICK_ACTION_EVENT, { detail: { id } })')
  })

  it('guards an older stream reset until the captured queued spoken send settles', () => {
    const commit = source.slice(source.indexOf('async function commitVoiceModeTurn('), source.indexOf('function quickActionVoiceModeSettings()'))
    expect(commit).not.toContain('preparingBehindReply')
    expect(commit).toContain('voiceQueuedReplyWait = replyWait')
    expect(commit).toContain('onReplyAdmitted: replyWait.onReplyAdmitted')
    expect(commit).toContain('onSteerPrepared: replyWait.onSteerPrepared')
    expect(source).toContain('voiceQueuedReplyWait?.observeReply(observation)')
    const send = commit.indexOf('const accepted = await sendMessageWithText(')
    expect(commit.indexOf('replyWait.finishSend()', send)).toBeGreaterThan(send)
    expect(commit).toContain('replyWait.abandonSend()')
    const reset = source.slice(source.indexOf('export function aiResponseReceived()'), source.indexOf('</script>'))
    expect(reset).toContain('if (voiceQueuedReplyWait?.holdGenericReplyCompletion()) return\n    waitingForAI = false')
    const metadata = source.slice(source.indexOf('const metadata: Record<string, any> = {'), source.indexOf('if (isCodexMode3)', source.indexOf('const metadata: Record<string, any> = {')))
    expect(metadata).not.toContain('onReplyAdmitted')
    expect(metadata).not.toContain('onSteerPrepared')
    expect(source).toContain('onReplyAdmitted: overrides?.onReplyAdmitted')
  })
})
