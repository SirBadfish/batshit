import { describe, expect, it } from 'vitest'

import {
  attachSessionClip,
  decrementSessionClipDurations,
  listActiveClipIds,
  normalizeSessionClipState,
  temporarilyUnclipSessionClip,
  tickTemporaryClipReattach,
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

  it('restores temporarily unclipped items after the reattach countdown finishes', () => {
    const initial = normalizeSessionClipState('sess-3', null)
    const attached = attachSessionClip(initial, {
      clipId: 'clip-3',
    })
    const tempHidden = temporarilyUnclipSessionClip(attached, 'clip-3', 2)

    expect(listActiveClipIds(tempHidden)).toEqual([])

    const firstTick = tickTemporaryClipReattach(tempHidden)
    expect(firstTick.clips[0]?.temporarilyUnclipped).toBe(true)

    const secondTick = tickTemporaryClipReattach(firstTick)
    expect(secondTick.clips[0]?.temporarilyUnclipped).toBe(false)
    expect(listActiveClipIds(secondTick)).toEqual(['clip-3'])
  })
})
