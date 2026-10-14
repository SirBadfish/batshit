import { describe, expect, it, vi } from 'vitest'
import { createGroupRoundClipSpend, drainGroupRoundThenSpend } from '../groupRoundClipSpend'
import { GROUP_APPROVAL_CLICK_REFUSAL, refusesGroupApprovalClick } from '../groupApprovalClick'

/** A round's spend over a chat whose countdown Clips a test sets as the round goes. */
function round(initialCountdownClipIds: string[] = ['clip-once']) {
  let countdownClipIds = [...initialCountdownClipIds]
  const spends: string[][] = []
  const clipSpend = createGroupRoundClipSpend({
    readCountdownClipIds: async () => [...countdownClipIds],
    spend: async (clipIds) => {
      spends.push([...clipIds].sort())
    }
  })
  return {
    clipSpend,
    spends,
    setCountdownClipIds(ids: string[]) {
      countdownClipIds = [...ids]
    }
  }
}

describe('BL-600: a group round spends the Clip countdown once, after its last compile', () => {
  it('spends nothing while speakers compile, and once when the round ends', async () => {
    const { clipSpend, spends } = round()
    await clipSpend.noteCompiled()
    await clipSpend.noteCompiled()
    expect(spends).toEqual([])
    await drainGroupRoundThenSpend(async () => {}, clipSpend)
    expect(spends).toEqual([['clip-once']])
    await clipSpend.settle()
    expect(spends).toEqual([['clip-once']])
  })

  it('spends the round only after the whole round ran', async () => {
    const { clipSpend, spends } = round()
    const seen: string[][][] = []
    await drainGroupRoundThenSpend(async () => {
      await clipSpend.noteCompiled()
      seen.push(spends.map((ids) => [...ids]))
      await clipSpend.noteCompiled()
      seen.push(spends.map((ids) => [...ids]))
    }, clipSpend)
    expect(seen).toEqual([[], []])
    expect(spends).toEqual([['clip-once']])
  })

  it('spends nothing when no speaker compiled (a refused round, or one stopped before any compile)', async () => {
    const { clipSpend, spends } = round()
    await drainGroupRoundThenSpend(async () => {}, clipSpend)
    expect(spends).toEqual([])
  })

  it('spends only what the FIRST compile read: a Clip attached later in the round is left for the next message', async () => {
    const { clipSpend, spends, setCountdownClipIds } = round(['clip-once'])
    await clipSpend.noteCompiled()
    // Attached during the first speaker's reply, for the user's NEXT message: the second speaker
    // reads it too, but the user's message this round answers did not carry it.
    setCountdownClipIds(['clip-once', 'clip-for-the-next-message'])
    await clipSpend.noteCompiled()
    await clipSpend.settle()
    expect(spends).toEqual([['clip-once']])
  })

  it('a first record whose read failed leaves the record to the next speaker', async () => {
    let reads = 0
    const spends: string[][] = []
    const clipSpend = createGroupRoundClipSpend({
      readCountdownClipIds: async () => {
        reads += 1
        if (reads === 1) throw new Error('redis blinked')
        return ['clip-once']
      },
      spend: async (clipIds) => {
        spends.push([...clipIds])
      }
    })
    await expect(clipSpend.noteCompiled()).rejects.toThrow('redis blinked')
    await clipSpend.noteCompiled()
    await clipSpend.settle()
    expect(spends).toEqual([['clip-once']])
  })

  it('a later speaker does not read the Clips again once the first one recorded them', async () => {
    const readCountdownClipIds = vi.fn(async () => ['clip-once'])
    const clipSpend = createGroupRoundClipSpend({ readCountdownClipIds, spend: async () => {} })
    await clipSpend.noteCompiled()
    await clipSpend.noteCompiled()
    await clipSpend.noteCompiled()
    expect(readCountdownClipIds).toHaveBeenCalledTimes(1)
  })

  it('a round that throws after a speaker compiled still spends, and its own error is the one thrown', async () => {
    const { clipSpend, spends } = round()
    await expect(
      drainGroupRoundThenSpend(async () => {
        await clipSpend.noteCompiled()
        throw new Error('the second speaker could not be set up')
      }, clipSpend)
    ).rejects.toThrow('the second speaker could not be set up')
    expect(spends).toEqual([['clip-once']])
  })

  it('a spend that fails after a thrown round is logged, and the round\u2019s error is the one thrown', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const clipSpend = createGroupRoundClipSpend({
      readCountdownClipIds: async () => ['clip-once'],
      spend: async () => {
        throw new Error('redis down')
      }
    })
    await expect(
      drainGroupRoundThenSpend(async () => {
        await clipSpend.noteCompiled()
        throw new Error('the round failed')
      }, clipSpend)
    ).rejects.toThrow('the round failed')
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('spending its Clip countdown failed too'),
      expect.objectContaining({ message: 'redis down' })
    )
    errors.mockRestore()
  })

  it('a spend that fails after a round that ended normally is the round\u2019s failure, and is not tried again', async () => {
    const spend = vi.fn(async () => {
      throw new Error('redis down')
    })
    const clipSpend = createGroupRoundClipSpend({ readCountdownClipIds: async () => ['clip-once'], spend })
    await clipSpend.noteCompiled()
    await expect(drainGroupRoundThenSpend(async () => {}, clipSpend)).rejects.toThrow('redis down')
    await clipSpend.settle()
    expect(spend).toHaveBeenCalledTimes(1)
  })
})

describe('BL-410: an approval click in a group chat is refused', () => {
  it('refuses a click in a group chat only', () => {
    expect(refusesGroupApprovalClick({ groupSession: true, approvalClick: true })).toBe(true)
    expect(refusesGroupApprovalClick({ groupSession: true, approvalClick: false })).toBe(false)
    expect(refusesGroupApprovalClick({ groupSession: false, approvalClick: true })).toBe(false)
  })

  it('says why and what the user can do instead', () => {
    expect(GROUP_APPROVAL_CLICK_REFUSAL.code).toBe('approval_unavailable_in_group')
    expect(GROUP_APPROVAL_CLICK_REFUSAL.error).toMatch(/not available in group chats/)
    expect(GROUP_APPROVAL_CLICK_REFUSAL.details).toMatch(/one-agent chat/)
  })
})
