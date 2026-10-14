import { describe, expect, it } from 'vitest'
import {
  createVoiceQuickActionCommitCoordinator,
  createVoiceNoReplyCompletion,
  createVoiceQueuedReplyWait,
  runVoiceQuickActionCommit,
  voiceQuickActionSnapshotMatches
} from './voiceQuickActionCommit'
import { postSendRouted, type SendRoutedClientDeps } from '$lib/services/sendRoutedClient'
import type { LiveSubscriptionHandlers } from '$lib/services/liveHub/liveHubClient'

const context = (sessionId: string | null, agentId: string | null) => ({ sessionId, agentId })

describe('voice quick-action commit coordinator', () => {
  it('binds a pending verdict to the session and agent that started it', () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const token = commits.begin(context('chat-a', 'agent-a'))

    expect(commits.isCurrent(token, context('chat-a', 'agent-a'))).toBe(true)
    expect(commits.isCurrent(token, context('chat-b', 'agent-a'))).toBe(false)
    expect(commits.isCurrent(token, context('chat-a', 'agent-b'))).toBe(false)
  })

  it('aborts and retires a verdict when Voice Mode ends or the component unmounts', () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const token = commits.begin(context('chat-a', 'agent-a'))

    expect(commits.invalidate()).toBe(true)
    expect(token.signal.aborted).toBe(true)
    expect(commits.isCurrent(token, context('chat-a', 'agent-a'))).toBe(false)
    expect(commits.finish(token)).toBe(false)
  })

  it('lets only the newest generation act and does not abort one that already committed', () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const first = commits.begin(context('chat-a', 'agent-a'))
    const second = commits.begin(context('chat-a', 'agent-a'))

    expect(first.signal.aborted).toBe(true)
    expect(commits.isCurrent(first, first.context)).toBe(false)
    expect(commits.isCurrent(second, second.context)).toBe(true)
    expect(commits.finish(second)).toBe(true)
    expect(commits.invalidate()).toBe(true)
    expect(commits.invalidate()).toBe(false)
    expect(second.signal.aborted).toBe(false)
  })

  it('does not let an old context cleanup abort a newer context generation', () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const oldContext = context('chat-a', 'agent-a')
    const first = commits.begin(oldContext)
    const second = commits.begin(context('chat-b', 'agent-a'))

    expect(first.signal.aborted).toBe(true)
    expect(commits.invalidateContext(oldContext)).toBe(false)
    expect(second.signal.aborted).toBe(false)
    expect(commits.isCurrent(second, second.context)).toBe(true)
  })

  it('retires reset ownership when a context leaves after its active token finished', () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const ownedContext = context('chat-a', 'agent-a')
    const token = commits.begin(ownedContext)
    let current = ownedContext

    expect(commits.finish(token)).toBe(true)
    expect(commits.ownsLatestGeneration(token)).toBe(true)
    current = context('chat-b', 'agent-a')
    expect(commits.invalidateContext(ownedContext)).toBe(true)
    current = ownedContext
    expect(commits.ownsLatestGeneration(token)).toBe(false)
    expect(voiceQuickActionSnapshotMatches(token.context, current, 'same', 'same')).toBe(true)
    expect(
      commits.ownsLatestGeneration(token) &&
      voiceQuickActionSnapshotMatches(token.context, current, 'same', 'same')
    ).toBe(false)
  })

  it.each([
    ['session switch', context('chat-b', 'agent-a')],
    ['agent switch', context('chat-a', 'agent-b')]
  ])('drops a deferred verdict after a %s before action, persistence, or send', async (_name, nextContext) => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const token = commits.begin(context('chat-a', 'agent-a'))
    let current = token.context
    let resolveVerdict!: (value: { action: string; onlyThis: boolean }) => void
    const verdict = new Promise<{ action: string; onlyThis: boolean }>((resolve) => {
      resolveVerdict = resolve
    })
    const effects: string[] = []
    let releases = 0

    const running = runVoiceQuickActionCommit({
      coordinator: commits,
      token,
      currentContext: () => current,
      requestVerdict: () => verdict,
      decide: (value) => ({ mark: value?.action ?? null, onlyThis: Boolean(value?.onlyThis) }),
      applyAction: () => effects.push('action'),
      persistOnly: async () => { effects.push('persist') },
      send: async () => { effects.push('send'); return true },
      releasePending: () => { releases += 1 }
    })

    current = nextContext
    expect(commits.invalidate()).toBe(true)
    releases += 1 // ChatInput's context-change invalidator also releases its waiting state.
    resolveVerdict({ action: 'stop', onlyThis: true })

    await expect(running).resolves.toBe('stale')
    expect(effects).toEqual([])
    expect(releases).toBe(1)
  })

  it('releases the old waiting state when context changes before effect cleanup runs', async () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const token = commits.begin(context('chat-a', 'agent-a'))
    let current = token.context
    let resolveVerdict!: (value: { action: string; onlyThis: boolean }) => void
    const verdict = new Promise<{ action: string; onlyThis: boolean }>((resolve) => {
      resolveVerdict = resolve
    })
    let releases = 0
    const running = runVoiceQuickActionCommit({
      coordinator: commits,
      token,
      currentContext: () => current,
      requestVerdict: () => verdict,
      decide: (value) => ({ mark: value?.action ?? null, onlyThis: Boolean(value?.onlyThis) }),
      applyAction: () => { throw new Error('stale action ran') },
      persistOnly: async () => { throw new Error('stale persist ran') },
      send: async () => { throw new Error('stale send ran') },
      releasePending: () => { releases += 1 }
    })

    current = context('chat-b', 'agent-a')
    resolveVerdict({ action: 'stop', onlyThis: true })

    await expect(running).resolves.toBe('stale')
    expect(releases).toBe(1)
    expect(commits.invalidateContext(token.context)).toBe(true)
    expect(commits.ownsLatestGeneration(token)).toBe(false)
  })

  it('drops a deferred verdict after Voice End before action, persistence, or send', async () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const token = commits.begin(context('chat-a', 'agent-a'))
    let resolveVerdict!: (value: { action: string; onlyThis: boolean }) => void
    const verdict = new Promise<{ action: string; onlyThis: boolean }>((resolve) => {
      resolveVerdict = resolve
    })
    const effects: string[] = []
    let waiting = true
    const running = runVoiceQuickActionCommit({
      coordinator: commits,
      token,
      currentContext: () => token.context,
      requestVerdict: () => verdict,
      decide: (value) => ({ mark: value?.action ?? null, onlyThis: Boolean(value?.onlyThis) }),
      applyAction: () => effects.push('action'),
      persistOnly: async () => { effects.push('persist') },
      send: async () => { effects.push('send'); return true },
      releasePending: () => { waiting = false }
    })

    if (commits.invalidate()) waiting = false
    resolveVerdict({ action: 'stop', onlyThis: true })

    await expect(running).resolves.toBe('stale')
    expect(effects).toEqual([])
    expect(waiting).toBe(false)
  })

  it('preserves a newer same-context transcript after a valid delayed verdict', async () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const token = commits.begin(context('chat-a', 'agent-a'))
    const spoken = 'open settings'
    let composer = spoken
    let persisted = 0

    const running = runVoiceQuickActionCommit({
      coordinator: commits,
      token,
      currentContext: () => token.context,
      requestVerdict: async () => ({ action: 'open_settings', onlyThis: true }),
      decide: (value) => ({ mark: value?.action ?? null, onlyThis: Boolean(value?.onlyThis) }),
      applyAction: () => {},
      persistOnly: async () => {
        if (composer === spoken) composer = ''
        persisted += 1
      },
      send: async () => true,
      releasePending: () => {}
    })
    composer = 'the next spoken turn'

    await expect(running).resolves.toBe('only-this')
    expect(persisted).toBe(1)
    expect(composer).toBe('the next spoken turn')
    expect(voiceQuickActionSnapshotMatches(token.context, token.context, spoken, composer)).toBe(false)
  })

  it('lets an end-voice action preserve its generation long enough to persist the marked turn', async () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const token = commits.begin(context('chat-a', 'agent-a'))
    let voiceEnded = false
    const persisted: string[] = []

    const result = await runVoiceQuickActionCommit({
      coordinator: commits,
      token,
      currentContext: () => token.context,
      requestVerdict: async () => ({ action: 'end_voice_mode', onlyThis: true }),
      decide: (value) => ({ mark: value?.action ?? null, onlyThis: Boolean(value?.onlyThis) }),
      applyAction: () => {
        // ChatInput ends Voice Mode with preservePendingCommit, so this does not invalidate.
        voiceEnded = true
      },
      persistOnly: async (mark) => { persisted.push(mark) },
      send: async () => { throw new Error('only-this turn was sent') },
      releasePending: () => {}
    })

    expect(result).toBe('only-this')
    expect(voiceEnded).toBe(true)
    expect(persisted).toEqual(['end_voice_mode'])
  })

  it.each([
    ['refuses the send', async (_mark: unknown, beforeSend: () => boolean) => { expect(beforeSend()).toBe(true); return false }],
    ['throws from the send', async (_mark: unknown, beforeSend: () => boolean) => { expect(beforeSend()).toBe(true); throw new Error('send failed') }]
  ])('releases waiting when the page %s after retiring the token', async (_name, send) => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const token = commits.begin(context('chat-a', 'agent-a'))
    let releases = 0
    const running = runVoiceQuickActionCommit({
      coordinator: commits,
      token,
      currentContext: () => token.context,
      requestVerdict: async () => null,
      decide: () => ({ mark: null, onlyThis: false }),
      applyAction: () => {},
      persistOnly: async () => {},
      send,
      releasePending: () => { releases += 1 }
    })

    if (_name.startsWith('throws')) await expect(running).rejects.toThrow('send failed')
    else await expect(running).resolves.toBe('refused')
    expect(releases).toBe(1)
  })

  it('releases waiting when storing an only-this turn throws', async () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const token = commits.begin(context('chat-a', 'agent-a'))
    let releases = 0
    let composer = 'spoken words'
    const running = runVoiceQuickActionCommit({
      coordinator: commits,
      token,
      currentContext: () => token.context,
      requestVerdict: async () => ({ action: 'stop', onlyThis: true }),
      decide: (value) => ({ mark: value?.action ?? null, onlyThis: Boolean(value?.onlyThis) }),
      applyAction: () => {},
      persistOnly: async () => {
        await Promise.reject(new Error('persist failed'))
        composer = ''
      },
      send: async () => true,
      releasePending: () => { releases += 1 }
    })

    await expect(running).rejects.toThrow('persist failed')
    expect(releases).toBe(1)
    expect(composer).toBe('spoken words')
  })

  it('does not let an older refused send clear a newer generation waiting state', async () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const first = commits.begin(context('chat-a', 'agent-a'))
    let resolveSend!: (accepted: boolean) => void
    const sendResult = new Promise<boolean>((resolve) => {
      resolveSend = resolve
    })
    let releases = 0
    const running = runVoiceQuickActionCommit({
      coordinator: commits,
      token: first,
      currentContext: () => context('chat-a', 'agent-a'),
      requestVerdict: async () => null,
      decide: () => ({ mark: null, onlyThis: false }),
      applyAction: () => {},
      persistOnly: async () => {},
      send: async (_mark, beforeSend) => {
        expect(beforeSend()).toBe(true)
        return sendResult
      },
      releasePending: () => { releases += 1 }
    })
    await Promise.resolve()
    await Promise.resolve()

    const second = commits.begin(context('chat-a', 'agent-a'))
    resolveSend(false)

    await expect(running).resolves.toBe('refused')
    expect(releases).toBe(0)
    expect(commits.isCurrent(second, second.context)).toBe(true)
  })

  it('does not let an older accepted send reset an identical newer transcript', () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const spoken = 'same transcript words'
    const first = commits.begin(context('chat-a', 'agent-a'))
    expect(commits.finish(first)).toBe(true)
    commits.begin(context('chat-a', 'agent-a'))

    const mayReset =
      commits.ownsLatestGeneration(first) &&
      voiceQuickActionSnapshotMatches(first.context, first.context, spoken, spoken)

    expect(mayReset).toBe(false)
  })
})

describe('accepted group completion with no reply stream', () => {
  it.each(['Smart skip', 'zero eligible candidates'])('%s releases only the still-current spoken commit', async (kind) => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const current = context('chat-a', 'agent-a')
    let waiting = true
    const token = commits.begin(current)
    const complete = createVoiceNoReplyCompletion({ coordinator: commits, token, currentContext: () => current, releaseWaiting: () => { waiting = false } })
    const result = await runVoiceQuickActionCommit({
      coordinator: commits, token, currentContext: () => current,
      requestVerdict: async () => null, decide: () => ({ mark: null, onlyThis: false }),
      applyAction: () => {}, persistOnly: async () => {},
      send: async (_mark, beforeSend) => {
        expect(beforeSend()).toBe(true)
        expect(commits.isCurrent(token, current)).toBe(false)
        // The accepted page response completes before the send promise settles.
        complete()
        return true
      },
      releasePending: () => { waiting = false }
    })
    expect(result).toBe('sent')
    expect(waiting, kind).toBe(false)
  })

  it.each(['Smart skip', 'zero eligible candidates'])('%s cannot leave an ended Voice wait busy or release a newer commit', async () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const current = context('chat-a', 'agent-a')
    const token = commits.begin(current)
    let waiting = true
    let resolveSend!: (accepted: boolean) => void
    const sendResult = new Promise<boolean>((resolve) => { resolveSend = resolve })
    let releaseOldCompletion = 0
    const complete = createVoiceNoReplyCompletion({ coordinator: commits, token,
      currentContext: () => current, releaseWaiting: () => { waiting = false; releaseOldCompletion += 1 } })
    const running = runVoiceQuickActionCommit({
      coordinator: commits, token, currentContext: () => current,
      requestVerdict: async () => null, decide: () => ({ mark: null, onlyThis: false }),
      applyAction: () => {}, persistOnly: async () => {},
      send: async (_mark, beforeSend) => {
        expect(beforeSend()).toBe(true)
        return sendResult
      },
      releasePending: () => { waiting = false }
    })
    await Promise.resolve()
    expect(commits.isCurrent(token, current)).toBe(false) // beforeSend retired the verdict.

    // The component's non-preserving Voice End releases the wait it invalidates.
    if (commits.invalidate()) waiting = false
    expect(waiting).toBe(false)
    complete()
    expect(waiting).toBe(false)
    expect(releaseOldCompletion).toBe(0)

    // Restart can now accept a transcript; setting a new wait requires this NEW commit.
    const newer = commits.begin(current)
    waiting = true
    complete()
    resolveSend(true)
    await expect(running).resolves.toBe('sent')
    expect(waiting).toBe(true)
    expect(commits.isCurrent(newer, current)).toBe(true)
    expect(releaseOldCompletion).toBe(0)

    // A later ordinary reply still owns this newer wait; the old completion cannot end it.
    expect(commits.finish(newer)).toBe(true)
    complete()
    expect(waiting).toBe(true)
    waiting = false // ChatInput.aiResponseReceived(), called by that reply's stream end.
    expect(waiting).toBe(false)
  })

  it('does not release another chat even while the captured generation remains latest', () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const token = commits.begin(context('chat-a', 'agent-a'))
    commits.finish(token)
    let releases = 0
    createVoiceNoReplyCompletion({ coordinator: commits, token,
      currentContext: () => context('chat-b', 'agent-a'), releaseWaiting: () => { releases += 1 } })()
    expect(releases).toBe(0)
  })
})

describe('Voice preparation and queued reply ownership (BL-1291/1295)', () => {
  it('an initially idle preparation keeps its captured transcript when another tab finishes a reply', async () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const current = context('chat-a', 'agent-a')
    const token = commits.begin(current)
    let waiting = true
    const wait = createVoiceQueuedReplyWait({ coordinator: commits, token, currentContext: () => current,
      releaseWaiting: () => { waiting = false } })
    let settleVerdict!: (value: null) => void
    const verdict = new Promise<null>(resolve => { settleVerdict = resolve })
    const sent: string[] = []
    const running = runVoiceQuickActionCommit({ coordinator: commits, token, currentContext: () => current,
      requestVerdict: () => verdict, decide: () => ({ mark: null, onlyThis: false }),
      applyAction: () => {}, persistOnly: async () => {},
      send: async (_mark, beforeSend) => {
        expect(beforeSend()).toBe(true)
        wait.onReplyAdmitted('direct')
        sent.push('captured first transcript')
        wait.finishSend()
        return true
      }, releasePending: () => { waiting = false }
    })
    // ChatInput's real final-result callback ignores new words while waiting. An unrelated
    // generic end used to clear waiting here and let those words supersede this token.
    if (!wait.holdGenericReplyCompletion()) waiting = false
    if (!waiting) commits.begin(current)
    expect(waiting).toBe(true)
    expect(commits.isCurrent(token, current)).toBe(true)
    settleVerdict(null)
    expect(await running).toBe('sent')
    expect(sent).toEqual(['captured first transcript'])
    expect(waiting).toBe(true) // The unrelated preparation-time end is not this direct reply's end.
    if (!wait.holdGenericReplyCompletion()) waiting = false
    expect(waiting).toBe(false)
  })

  it.each(['direct', 'steer', 'queued'] as const)('%s admission owns the correct completion after an end during preparation', kind => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const token = commits.begin(context('chat-a', 'agent-a'))
    let releases = 0
    const wait = createVoiceQueuedReplyWait({ coordinator: commits, token, currentContext: () => token.context,
      releaseWaiting: () => { releases++ } })
    expect(wait.holdGenericReplyCompletion()).toBe(true)
    commits.finish(token) // beforeSend, while the page still performs asynchronous admission.
    expect(wait.holdGenericReplyCompletion()).toBe(true)
    if (kind === 'steer') wait.onSteerPrepared({ sessionId: 'chat-a', steerId: 'spoken', targetMessageId: 'predecessor' })
    wait.onReplyAdmitted(kind)
    expect(wait.holdGenericReplyCompletion()).toBe(kind !== 'direct')
    wait.finishSend()
    expect(releases).toBe(kind === 'queued' ? 1 : 0)
    expect(wait.holdGenericReplyCompletion()).toBe(kind === 'steer')
    if (kind === 'steer') {
      wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'predecessor' })
      expect(releases).toBe(0)
      expect(wait.holdGenericReplyCompletion()).toBe(true)
      wait.observeReply({ sessionId: 'chat-a', type: 'steer_delivered', steerId: 'spoken', messageId: 'receiving' })
      wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'receiving' })
      expect(releases).toBe(1)
      expect(wait.holdGenericReplyCompletion()).toBe(false)
    }
  })

  it.each(['reply', 'no reply', 'refusal'])('%s: End/restart wait survives the old reply and the queued 202 until its own turn ends', async (outcome) => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const current = context('chat-a', 'agent-a')
    const old = commits.begin(current)
    commits.finish(old)
    let waiting = true
    if (commits.invalidate()) waiting = false // Actual End after beforeSend retired the old token.
    expect(waiting).toBe(false)

    const token = commits.begin(current) // Restart accepts a NEW spoken commit.
    waiting = true
    const replyWait = createVoiceQueuedReplyWait({ coordinator: commits, token, currentContext: () => current, releaseWaiting: () => { waiting = false } })
    // The prior reply can end even during asynchronous slash/Clip/send preparation.
    if (!replyWait.holdGenericReplyCompletion()) waiting = false
    expect(waiting).toBe(true)
    let handlers!: LiveSubscriptionHandlers
    let earlyAccepted = false
    let unsubscribed = false
    const deps: SendRoutedClientDeps = {
      fetch: async () => new Response(JSON.stringify({ accepted: true, turnId: 'turn_new_voice', sessionId: current.sessionId }),
        { status: 202, headers: { 'preference-applied': 'respond-async' } }),
      subscribe: (_target, value) => { handlers = value; return { id: 'owned', state: () => 'pending', unsubscribe: () => { unsubscribed = true } } },
      setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: value => clearTimeout(value as ReturnType<typeof setTimeout>)
    }
    const running = runVoiceQuickActionCommit({ coordinator: commits, token, currentContext: () => current,
      requestVerdict: async () => null, decide: () => ({ mark: null, onlyThis: false }),
      applyAction: () => {}, persistOnly: async () => {},
      send: async (_mark, beforeSend) => {
        expect(beforeSend()).toBe(true)
        replyWait.onReplyAdmitted('queued') // Page's actual BL-713 decision, before save/post awaits.
        const response = await postSendRouted('{}', { onAccepted: () => { earlyAccepted = true } }, deps)
        await response.json()
        replyWait.finishSend() // The page's awaited FINAL response/refusal, never its 202.
        return response.ok
      }, releasePending: () => { waiting = false }
    })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(earlyAccepted).toBe(true)
    expect(waiting).toBe(true)
    expect(replyWait.holdGenericReplyCompletion()).toBe(true) // Older stream end still owns no new wait.
    handlers.onEvent(JSON.stringify({ type: 'turn_over', turnId: 'turn_old_voice', status: 200, body: '{"success":true}' }))
    await Promise.resolve()
    expect(waiting).toBe(true)
    handlers.onEvent(JSON.stringify({ type: 'turn_over', turnId: 'turn_new_voice', status: outcome === 'refusal' ? 409 : 200,
      contentType: 'application/json', body: JSON.stringify(outcome === 'no reply'
        ? { success: true, noReplyStream: true, userMessageId: 'user-new', groupTurnId: 'group-new' }
        : outcome === 'refusal' ? { error: 'This queued send was kept without running' } : { success: true, messageId: 'reply-new' }) }))
    expect(await running).toBe(outcome === 'refusal' ? 'refused' : 'sent')
    expect(waiting).toBe(false)
    expect(unsubscribed).toBe(true)
  })

  it('an ended or superseded queued send cannot release a newer begun wait', () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const current = context('chat-a', 'agent-a')
    const token = commits.begin(current)
    commits.finish(token)
    let waiting = true
    const older = createVoiceQueuedReplyWait({ coordinator: commits, token, currentContext: () => current, releaseWaiting: () => { waiting = false } })
    older.onReplyAdmitted('queued')
    if (commits.invalidate()) waiting = false
    expect(waiting).toBe(false)
    const newer = commits.begin(current)
    waiting = true
    const newerWait = createVoiceQueuedReplyWait({ coordinator: commits, token: newer, currentContext: () => current, releaseWaiting: () => { waiting = false } })
    older.finishSend()
    if (!newerWait.holdGenericReplyCompletion()) waiting = false
    expect(waiting).toBe(true)
    expect(commits.isCurrent(newer, current)).toBe(true)
  })

  it('does not release a queued wait in another captured context', () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const token = commits.begin(context('chat-a', 'agent-a'))
    commits.finish(token)
    let current = token.context, releases = 0
    const wait = createVoiceQueuedReplyWait({ coordinator: commits, token, currentContext: () => current, releaseWaiting: () => { releases++ } })
    wait.onReplyAdmitted('queued')
    current = context('chat-b', 'agent-a')
    wait.finishSend()
    expect(releases).toBe(0)
  })

  it('keeps direct stream completion but an accepted inbox receipt does not own the predecessor end', () => {
    const commits = createVoiceQuickActionCommitCoordinator()
    const token = commits.begin(context('chat-a', 'agent-a'))
    commits.finish(token)
    let releases = 0
    const options = { coordinator: commits, token, currentContext: () => token.context, releaseWaiting: () => { releases++ } }
    const direct = createVoiceQueuedReplyWait(options)
    expect(direct.holdGenericReplyCompletion()).toBe(true)
    direct.onReplyAdmitted('direct')
    expect(direct.holdGenericReplyCompletion()).toBe(false)
    direct.finishSend()
    expect(releases).toBe(0)
    const steer = createVoiceQueuedReplyWait(options)
    steer.onSteerPrepared({ sessionId: 'chat-a', steerId: 'spoken' })
    steer.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'predecessor' })
    steer.onReplyAdmitted('steer')
    steer.finishSend() // 202 admission alone is never an answer.
    expect(releases).toBe(0)
    expect(steer.holdGenericReplyCompletion()).toBe(true)
    steer.observeReply({ sessionId: 'chat-a', type: 'steer_delivered', steerId: 'spoken', messageId: 'receiving' })
    steer.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'receiving' })
    expect(releases).toBe(1)
    expect(steer.holdGenericReplyCompletion()).toBe(false)
  })

  function inboxWait() {
    const coordinator = createVoiceQuickActionCommitCoordinator()
    const token = coordinator.begin(context('chat-a', 'agent-a'))
    coordinator.finish(token)
    let current = token.context
    const releaseWaiting = vi.fn()
    const wait = createVoiceQueuedReplyWait({ coordinator, token, currentContext: () => current, releaseWaiting })
    wait.onSteerPrepared({ sessionId: 'chat-a', steerId: 'spoken', targetMessageId: 'target' })
    return { coordinator, token, wait, releaseWaiting, switchContext: () => { current = context('chat-b', 'agent-a') } }
  }
  const relation = { steerPromoted: { steerIds: ['other', 'spoken'] } }

  it('binds the promoted answer before POST returns, ignores the promoted user and an arbitrary next reply', () => {
    const { wait, releaseWaiting } = inboxWait()
    wait.observeReply({ sessionId: 'chat-a', type: 'user_message', role: 'user', messageId: 'other', metadata: relation })
    wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'unrelated' })
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.observeReply({ sessionId: 'chat-a', type: 'start', messageId: 'exact', metadata: relation })
    wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'exact' })
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
    wait.onReplyAdmitted('steer')
    wait.finishSend()
    wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'exact' })
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
  })

  it.each(['record', 'complete_message', 'error'])('recovers an exact %s terminal without relying on the next reply', (type) => {
    const { wait, releaseWaiting } = inboxWait()
    wait.observeReply({ sessionId: 'chat-a', type, role: 'assistant', status: 'error', messageId: 'failed',
      metadata: { ...relation, response_failed: true } })
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
  })

  it('keeps an approval hold waiting, including its card end, until the promoted resume actually ends', () => {
    const { wait, releaseWaiting } = inboxWait()
    const pending = { approvals: [{ approvalId: 'ap', status: 'pending' }] }
    wait.observeReply({ sessionId: 'chat-a', type: 'user_message', role: 'user', metadata: {
      ...relation, waitsForApproval: { messageId: 'card' } } })
    wait.observeReply({ sessionId: 'chat-a', type: 'start', messageId: 'card', metadata: relation })
    wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'card', metadata: { ...relation, toolApprovals: pending } })
    // Real server order: the adapter's trailing complete has defaults, no approvals.
    wait.observeReply({ sessionId: 'chat-a', type: 'complete', messageId: 'card', metadata: relation })
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.observeReply({ sessionId: 'chat-a', type: 'start', messageId: 'resumed', metadata: relation })
    wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'card' }) // late predecessor/card end
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'resumed' })
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
  })

  it('holds the answered-card reload interval and finishes only the newer in-place resume version', () => {
    const { wait, releaseWaiting } = inboxWait()
    wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'card', metadata: { ...relation,
      toolApprovals: { approvals: [{ status: 'pending' }] } } })
    wait.observeReply({ sessionId: 'chat-a', type: 'complete', messageId: 'card', metadata: relation })
    wait.observeReply({ sessionId: 'chat-a', type: 'record', role: 'assistant', status: 'complete', messageId: 'card',
      metadata: { ...relation, answeredApprovalIds: ['ap'], toolApprovals: { approvals: [{ status: 'approved' }] } } })
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.observeReply({ sessionId: 'chat-a', type: 'start', messageId: 'card', metadata: { ...relation,
      approvalResumeVersion: 10, approvalResume: { version: 10 } } })
    wait.observeReply({ sessionId: 'chat-a', type: 'record', role: 'assistant', status: 'complete', messageId: 'card', metadata: relation })
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'card', metadata: { ...relation, approvalResumeVersion: 10 } })
    wait.observeReply({ sessionId: 'chat-a', type: 'complete', messageId: 'card', metadata: { ...relation, approvalResumeVersion: 10 } })
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
  })

  it('an answered-card snapshot received without the pending end still waits for its own resume', () => {
    const { wait, releaseWaiting } = inboxWait()
    wait.observeReply({ sessionId: 'chat-a', type: 'record', role: 'assistant', status: 'complete', messageId: 'card',
      metadata: { ...relation, answeredApprovalIds: ['ap'] } })
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.observeReply({ sessionId: 'chat-a', type: 'record', role: 'assistant', status: 'complete', messageId: 'card',
      metadata: { ...relation, answeredApprovalIds: ['ap'], approvalResumeVersion: 10 } })
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
  })

  it('a held-user relation ignores the card resume end→complete and failure until a run actually owns the words', () => {
    const { wait, releaseWaiting } = inboxWait()
    wait.observeReply({ sessionId: 'chat-a', type: 'user_message', role: 'user', metadata: {
      steerPromoted: { steerIds: ['spoken'], disposition: 'awaiting_approval', approvalResumeVersion: 10 },
      waitsForApproval: { messageId: 'card' } } })
    wait.observeReply({ sessionId: 'chat-a', type: 'record', role: 'assistant', status: 'complete', messageId: 'card',
      metadata: { answeredApprovalIds: ['ap'], approvalResumeVersion: 10 } })
    wait.observeReply({ sessionId: 'chat-a', type: 'complete', messageId: 'card', metadata: { approvalResumeVersion: 10 } })
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.observeReply({ sessionId: 'chat-a', type: 'record', role: 'assistant', status: 'complete', messageId: 'card',
      metadata: { answeredApprovalIds: ['ap'], approvalResumeVersion: 20 } })
    wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'card', metadata: { approvalResumeVersion: 20 } })
    wait.observeReply({ sessionId: 'chat-a', type: 'complete', messageId: 'card', metadata: { approvalResumeVersion: 20 } })
    wait.observeReply({ sessionId: 'chat-a', type: 'record', role: 'assistant', status: 'error', messageId: 'card',
      metadata: { response_failed: true, approvalResumeVersion: 20 } })
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.observeReply({ sessionId: 'chat-a', type: 'start', messageId: 'held-answer', metadata: relation })
    wait.observeReply({ sessionId: 'chat-a', type: 'complete', messageId: 'card', metadata: { approvalResumeVersion: 20 } })
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'held-answer', metadata: relation })
    wait.observeReply({ sessionId: 'chat-a', type: 'complete', messageId: 'held-answer', metadata: relation })
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
  })

  it('a held-only wait ends on its exact saved no-answer disposition without requiring a fabricated run', () => {
    const { wait, releaseWaiting } = inboxWait()
    wait.observeReply({ sessionId: 'chat-a', type: 'user_message', role: 'user', messageId: 'spoken', metadata: {
      steerPromoted: { steerIds: ['spoken'], disposition: 'awaiting_approval', approvalResumeVersion: 10 },
      waitsForApproval: { messageId: 'card' } } })
    wait.observeReply({ sessionId: 'chat-a', type: 'record', role: 'user', messageId: 'spoken', metadata: {
      steerPromoted: { steerIds: ['spoken'], disposition: 'unanswered', reason: 'reply_failed' },
      waitsForApproval: { messageId: 'card' } } })
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
  })

  it('a cold reload of a delivered second-pause card owns its version even without a held-user or pending-end event', () => {
    const { wait, releaseWaiting } = inboxWait()
    wait.observeReply({ sessionId: 'chat-a', type: 'record', role: 'assistant', status: 'complete', messageId: 'card', metadata: {
      steerPromoted: { steerIds: ['spoken'], disposition: 'awaiting_approval', approvalResumeVersion: 10 },
      approvalResumeVersion: 10, answeredApprovalIds: ['ap'], toolApprovals: null } })
    wait.observeReply({ sessionId: 'chat-a', type: 'complete', messageId: 'card', metadata: { approvalResumeVersion: 10 } })
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.observeReply({ sessionId: 'chat-a', type: 'record', role: 'assistant', status: 'complete', messageId: 'card',
      metadata: { ...relation, approvalResumeVersion: 20, toolApprovals: null } })
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
  })

  it('a recorded CLI expiry ends the exact paused card wait without pretending its pause end was an answer', () => {
    const { wait, releaseWaiting } = inboxWait()
    wait.observeReply({ sessionId: 'chat-a', type: 'steer_delivered', steerId: 'spoken', messageId: 'card' })
    wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'card', metadata: {
      ...relation, toolApprovals: { approvals: [{ status: 'pending' }] }, approvalResumeVersion: 10 } })
    wait.observeReply({ sessionId: 'chat-a', type: 'complete', messageId: 'card', metadata: { ...relation, approvalResumeVersion: 10 } })
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.observeReply({ sessionId: 'chat-a', type: 'complete_message', role: 'assistant', status: 'complete', messageId: 'card', metadata: {
      steerPromoted: { steerIds: ['spoken'], disposition: 'unanswered', reason: 'approval_expired' } } })
    wait.observeReply({ sessionId: 'chat-a', type: 'complete', messageId: 'card', metadata: { ...relation, approvalResumeVersion: 10 } })
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
  })

  it('late held-user and assistant card replays cannot reclaim an already promoted answer', () => {
    const { wait, releaseWaiting } = inboxWait()
    wait.observeReply({ sessionId: 'chat-a', type: 'steer_delivered', steerId: 'spoken', messageId: 'target' })
    wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'target', metadata: { ...relation,
      toolApprovals: { approvals: [{ status: 'pending' }] } } })
    wait.observeReply({ sessionId: 'chat-a', type: 'start', messageId: 'resumed', metadata: relation })
    wait.observeReply({ sessionId: 'chat-a', type: 'user_message', role: 'user', messageId: 'held', metadata: {
      steerPromoted: { steerIds: ['spoken'], disposition: 'awaiting_approval', approvalResumeVersion: 0 },
      waitsForApproval: { messageId: 'target' } } })
    wait.observeReply({ sessionId: 'chat-a', type: 'record', role: 'assistant', status: 'complete', messageId: 'target',
      metadata: { ...relation, answeredApprovalIds: ['ap'] } })
    wait.observeReply({ sessionId: 'chat-a', type: 'steer_delivered', steerId: 'spoken', messageId: 'target' })
    wait.onTargetStopped('chat-a', 'target')
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'resumed', metadata: relation })
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
  })

  it('an older pause relation cannot lower the current in-place resume version fence', () => {
    const { wait, releaseWaiting } = inboxWait()
    const held = (version: number) => ({ steerPromoted: { steerIds: ['spoken'], disposition: 'awaiting_approval', approvalResumeVersion: version },
      waitsForApproval: { messageId: 'card' } })
    wait.observeReply({ sessionId: 'chat-a', type: 'user_message', role: 'user', metadata: held(10) })
    wait.observeReply({ sessionId: 'chat-a', type: 'start', messageId: 'card', metadata: { ...relation, approvalResumeVersion: 20 } })
    wait.observeReply({ sessionId: 'chat-a', type: 'user_message', role: 'user', metadata: held(10) })
    wait.observeReply({ sessionId: 'chat-a', type: 'record', role: 'assistant', status: 'complete', messageId: 'card', metadata: {
      steerPromoted: held(10).steerPromoted, approvalResumeVersion: 10, answeredApprovalIds: ['ap'] } })
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'card', metadata: { ...relation, approvalResumeVersion: 20 } })
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
  })

  it('an exact local Stop releases its lost-forward target, never another reply or a newer wait', () => {
    const { wait, coordinator, releaseWaiting } = inboxWait()
    wait.onTargetStopped('chat-b', 'target')
    wait.onTargetStopped('chat-a', 'unrelated')
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.onTargetStopped('chat-a', 'target')
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
    const newer = coordinator.begin(context('chat-a', 'agent-a'))
    wait.onTargetStopped('chat-a', 'target')
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
    expect(coordinator.isCurrent(newer, newer.context)).toBe(true)
  })

  it('after promotion, Stop of the predecessor cannot end the new receiving reply wait', () => {
    const { wait, releaseWaiting } = inboxWait()
    wait.observeReply({ sessionId: 'chat-a', type: 'start', messageId: 'promoted', metadata: relation })
    wait.onTargetStopped('chat-a', 'target')
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.onTargetStopped('chat-a', 'promoted')
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
  })

  it.each(['approval_expired', 'approval_denied', 'promotion_limit', 'promotion_failed', 'stopped', 'reply_failed'])('an exact server %s no-answer disposition ends the wait', (reason) => {
    const { wait, releaseWaiting } = inboxWait()
    wait.observeReply({ sessionId: 'chat-a', type: 'steer_promoted', metadata: {
      steerPromoted: { steerIds: ['not-ours'], disposition: 'unanswered', reason } } })
    expect(releaseWaiting).not.toHaveBeenCalled()
    wait.observeReply({ sessionId: 'chat-a', type: 'user_message', role: 'user', metadata: {
      steerPromoted: { steerIds: ['spoken'], disposition: 'unanswered', reason } } })
    expect(releaseWaiting).toHaveBeenCalledTimes(1)
  })

  it('old exact terminals cannot release after End, a newer commit, or a context switch', () => {
    for (const fence of ['end', 'newer', 'context']) {
      const { wait, coordinator, switchContext, releaseWaiting } = inboxWait()
      if (fence === 'end') coordinator.invalidate()
      if (fence === 'newer') coordinator.begin(context('chat-a', 'agent-a'))
      if (fence === 'context') switchContext()
      wait.observeReply({ sessionId: 'chat-a', type: 'end', messageId: 'exact', metadata: relation })
      expect(releaseWaiting).not.toHaveBeenCalled()
    }
  })
})
