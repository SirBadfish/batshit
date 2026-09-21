import { describe, expect, it } from 'vitest'
import {
  createVoiceQuickActionCommitCoordinator,
  runVoiceQuickActionCommit,
  voiceQuickActionSnapshotMatches
} from './voiceQuickActionCommit'

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
