import { describe, expect, it } from 'vitest'

import {
  attachSessionClip,
  decrementSessionClipDurations,
  listActiveClipIds,
  normalizeSessionClipState,
  updateSessionClipDuration,
} from '../sessionClipState'

describe('sessionClipState', () => {
  it('removes next-message-only clips after one send tick', () => {
    const initial = normalizeSessionClipState('sess-1', null)
    const attached = attachSessionClip(initial, {
      clipId: 'clip-1',
      unclipAfter: 1,
    })

    expect(listActiveClipIds(attached)).toEqual(['clip-1'])

    const consumed = decrementSessionClipDurations(attached)
    expect(consumed.clips).toHaveLength(0)
    expect(listActiveClipIds(consumed)).toEqual([])
  })

  it('can switch a clip back to persistent mode', () => {
    const initial = normalizeSessionClipState('sess-2', null)
    const attached = attachSessionClip(initial, {
      clipId: 'clip-2',
      unclipAfter: 1,
    })

    const persistent = updateSessionClipDuration(attached, 'clip-2', null)
    const afterTick = decrementSessionClipDurations(persistent)

    expect(afterTick.clips).toHaveLength(1)
    expect(afterTick.clips[0]?.clipId).toBe('clip-2')
    expect(listActiveClipIds(afterTick)).toEqual(['clip-2'])
  })

  it('ignores a stale temporarilyUnclipped field left in stored state', () => {
    // SA-109 P4 removed the half-built temporary-unclip lane: nothing could ever
    // set this flag, so no real record carries it. If one somehow does, the clip
    // is simply attached — the user never asked for it to be hidden.
    const state = normalizeSessionClipState('sess-3', {
      sessionId: 'sess-3',
      clips: [{ clipId: 'clip-3', temporarilyUnclipped: true, reattachAt: 4 }]
    })

    expect(listActiveClipIds(state)).toEqual(['clip-3'])
    expect(state.clips[0]).not.toHaveProperty('temporarilyUnclipped')
    expect(state.clips[0]).not.toHaveProperty('reattachAt')
  })
})
