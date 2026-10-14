import { describe, expect, it } from 'vitest'
import {
  QUICK_ACTION_IDS,
  isSwallowedQuickActionTurn,
  quickActionInvolvesAgent,
  quickActionMarkOf,
  quickActionSettingsTabTarget,
  type QuickActionMark,
  type QuickActionVerdict
} from '../../utils/jevJuiceQuickActions'
import { createVoiceQuickActionCommitCoordinator, runVoiceQuickActionCommit } from '../../utils/voiceQuickActionCommit'
import { executeVoiceQuickAction, VOICE_ONLY_ACTION_DESCRIPTORS, VOICE_QUICK_ACTION_PROJECTION, type VoiceQuickActionOwners } from './quickActionExecutor'

function verdict(action: QuickActionVerdict['action'], onlyThis = true): QuickActionVerdict {
  return { action, tab: null, onlyThis, confidence: 0.93, snapshotId: 'qa_voice_parity' }
}

function ownerFixture(busy = false) {
  const calls: unknown[] = []
  const owners: VoiceQuickActionOwners = {
    stopPlayback: () => { calls.push('audio_stop') },
    workBusy: () => busy,
    requestWorkStop: () => { calls.push('work_stop_requested') },
    endVoiceMode: options => { calls.push(['voice_end', options]) },
    openExecutionViewer: () => { calls.push('execution_open') },
    openSettings: tab => { calls.push(['settings_open', quickActionSettingsTabTarget(tab)]) },
    requestDock: id => { calls.push(['dock_requested', id]) }
  }
  return { calls, owners }
}

describe('six-action Voice Mode projection', () => {
  it('covers exactly the existing speech catalog without granting Stop or End to other callers', () => {
    expect(Object.keys(VOICE_QUICK_ACTION_PROJECTION)).toEqual(QUICK_ACTION_IDS)
    for (const entry of VOICE_ONLY_ACTION_DESCRIPTORS) {
      expect(entry.callers).toEqual(['speech'])
      expect(entry.risk).toBe('restricted')
    }
    expect(QUICK_ACTION_IDS.every(id => !quickActionInvolvesAgent(id))).toBe(true)
  })

  it.each([
    ['end_voice_mode', [['voice_end', { notify: true, preservePendingCommit: true }]]],
    ['show_execution_viewer', ['execution_open']],
    ['open_goon_dock', [['dock_requested', 'open_goon_dock']]],
    ['close_goon_dock', [['dock_requested', 'close_goon_dock']]]
  ] as const)('dispatches %s to only its current owner', (id, expected) => {
    const { calls, owners } = ownerFixture()
    expect(executeVoiceQuickAction(verdict(id), owners)).toBe(true)
    expect(calls).toEqual(expected)
  })

  it.each([null, 'general', 'agents', 'voice', 'goons', 'memory', 'tools'] as const)(
    'retains the existing Settings target for %s', tab => {
      const { calls, owners } = ownerFixture()
      executeVoiceQuickAction({ ...verdict('open_settings'), tab }, owners)
      const expected = tab === 'general' || tab === null ? undefined : tab === 'goons' ? '3d-goons' : tab
      expect(calls).toEqual([['settings_open', expected]])
    }
  )

  it.each([false, true])('stops all spoken audio first and asks the work owner only when busy (%s)', busy => {
    const { calls, owners } = ownerFixture(busy)
    executeVoiceQuickAction(verdict('stop'), owners)
    expect(calls).toEqual(busy ? ['audio_stop', 'work_stop_requested'] : ['audio_stop'])
  })

  it.each([null, 'settings.change', 'sys.memory.add', '__proto__'])('does not dispatch an unadmitted id (%s)', action => {
    const { calls, owners } = ownerFixture()
    expect(executeVoiceQuickAction({ ...verdict(null), action } as QuickActionVerdict, owners)).toBe(false)
    expect(calls).toEqual([])
  })

  it('surfaces owner failures instead of claiming dispatch or invoking another action', () => {
    const { calls, owners } = ownerFixture(true)
    owners.stopPlayback = () => { throw new Error('audio owner failed') }
    expect(() => executeVoiceQuickAction(verdict('stop'), owners)).toThrow('audio owner failed')
    expect(calls).toEqual([])
  })
})

describe('generation-owned speech commit with the shared projection', () => {
  it('preserves the intentional hang-up commit and stores the original swallowed mark', async () => {
    const coordinator = createVoiceQuickActionCommitCoordinator()
    const context = { sessionId: 'chat_voice', agentId: 'agent_voice' }
    const token = coordinator.begin(context)
    const calls: string[] = []
    const { owners } = ownerFixture()
    let stored: QuickActionMark | null = null
    owners.endVoiceMode = options => {
      calls.push('voice_end')
      // This is endDirectVoiceMode's actual invalidation rule.
      if (!options.preservePendingCommit) coordinator.invalidate()
    }
    const result = await runVoiceQuickActionCommit<QuickActionVerdict, QuickActionMark>({
      coordinator, token, currentContext: () => context,
      requestVerdict: async () => verdict('end_voice_mode'),
      decide: value => ({ mark: value ? quickActionMarkOf(value, new Date('2026-10-04T12:00:00Z')) : null, onlyThis: value?.onlyThis === true }),
      applyAction: value => { executeVoiceQuickAction(value, owners) },
      persistOnly: async mark => {
        expect(coordinator.ownsLatestGeneration(token)).toBe(true)
        stored = mark
        calls.push('store_mark')
      },
      send: async () => { calls.push('send'); return true },
      releasePending: () => { calls.push('release_waiting') }
    })
    expect(result).toBe('only-this')
    expect(calls).toEqual(['voice_end', 'release_waiting', 'store_mark'])
    expect(stored).toEqual({ id: 'end_voice_mode', tab: null, onlyThis: true, confidence: 0.93,
      snapshotId: 'qa_voice_parity', at: '2026-10-04T12:00:00.000Z' })
    expect(isSwallowedQuickActionTurn({ role: 'user', metadata: { quickAction: stored } })).toBe(true)
  })

  it.each(['session', 'agent', 'hangup', 'superseded'] as const)('retires a delayed verdict after %s without action, store or send', async change => {
    const coordinator = createVoiceQuickActionCommitCoordinator()
    let context = { sessionId: 'chat_voice', agentId: 'agent_voice' }
    const token = coordinator.begin(context)
    const { calls, owners } = ownerFixture(true)
    let resolve!: (value: QuickActionVerdict) => void
    const pendingVerdict = new Promise<QuickActionVerdict>(finish => { resolve = finish })
    const pending = runVoiceQuickActionCommit<QuickActionVerdict, QuickActionMark>({
      coordinator, token, currentContext: () => context, requestVerdict: () => pendingVerdict,
      decide: value => ({ mark: value ? quickActionMarkOf(value) : null, onlyThis: true }),
      applyAction: value => { executeVoiceQuickAction(value, owners) },
      persistOnly: async () => { calls.push('store') },
      send: async () => { calls.push('send'); return true },
      releasePending: () => { calls.push('release') }
    })
    if (change === 'session') context = { ...context, sessionId: 'chat_other' }
    else if (change === 'agent') context = { ...context, agentId: 'agent_other' }
    else if (change === 'hangup') coordinator.invalidate()
    else coordinator.begin(context)
    resolve(verdict('stop'))
    expect(await pending).toBe('stale')
    expect(calls.filter(call => call !== 'release')).toEqual([])
  })

  it('admits Stop synchronously before a mixed turn sends, without waiting for the Stop owner to finish', async () => {
    const coordinator = createVoiceQuickActionCommitCoordinator()
    const context = { sessionId: 'chat_voice', agentId: 'agent_voice' }
    const token = coordinator.begin(context)
    const { calls, owners } = ownerFixture(true)
    let finishStop!: () => void
    const stopped = new Promise<void>(resolve => { finishStop = resolve })
    owners.requestWorkStop = () => {
      calls.push('work_stop_requested')
      void stopped.then(() => { calls.push('work_stop_settled') })
    }
    const result = await runVoiceQuickActionCommit<QuickActionVerdict, QuickActionMark>({
      coordinator, token, currentContext: () => context, requestVerdict: async () => verdict('stop', false),
      decide: value => ({ mark: value ? quickActionMarkOf(value) : null, onlyThis: false }),
      applyAction: value => { executeVoiceQuickAction(value, owners) },
      persistOnly: async () => { calls.push('store_only') },
      send: async (mark, beforeSend) => {
        expect(beforeSend()).toBe(true)
        expect(mark?.onlyThis).toBe(false)
        expect(isSwallowedQuickActionTurn({ role: 'user', metadata: { quickAction: mark } })).toBe(false)
        calls.push('send_mixed')
        return true
      },
      releasePending: () => { calls.push('release') }
    })
    expect(result).toBe('sent')
    expect(calls).toEqual(['audio_stop', 'work_stop_requested', 'send_mixed'])
    finishStop()
    await stopped
    expect(calls.at(-1)).toBe('work_stop_settled')
  })
})
