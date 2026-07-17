import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisExistsMock = vi.hoisted(() => vi.fn())
const redisKeysMock = vi.hoisted(() => vi.fn())
const redisSMembersMock = vi.hoisted(() => vi.fn())
const redisSRemMock = vi.hoisted(() => vi.fn())
const redisDelMock = vi.hoisted(() => vi.fn())
const removeClipFromSessionStateMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/redis', () => ({
  redis: {
    exists: redisExistsMock,
    keys: redisKeysMock,
    sMembers: redisSMembersMock,
    sRem: redisSRemMock,
    del: redisDelMock
  }
}))

vi.mock('$lib/server/services/clipDeletion', () => ({
  removeClipFromSessionState: removeClipFromSessionStateMock
}))

import { removeRetiredSystemClips } from '$lib/server/services/retiredSystemClips'

describe('removeRetiredSystemClips', () => {
  beforeEach(() => {
    redisExistsMock.mockReset()
    redisKeysMock.mockReset()
    redisSMembersMock.mockReset()
    redisSRemMock.mockReset()
    redisDelMock.mockReset()
    removeClipFromSessionStateMock.mockReset()
    redisSRemMock.mockResolvedValue(undefined)
    redisDelMock.mockResolvedValue(undefined)
    removeClipFromSessionStateMock.mockResolvedValue(undefined)
  })

  it('is a no-op when the retired clip record and membership are both gone', async () => {
    redisExistsMock.mockResolvedValue(false)
    redisSMembersMock.mockResolvedValue([])

    await removeRetiredSystemClips()

    expect(redisKeysMock).not.toHaveBeenCalled()
    expect(redisSRemMock).not.toHaveBeenCalled()
    expect(redisDelMock).not.toHaveBeenCalled()
    expect(removeClipFromSessionStateMock).not.toHaveBeenCalled()
  })

  it('removes the record, membership, and session references when the retired clip exists', async () => {
    redisExistsMock.mockResolvedValue(true)
    redisSMembersMock.mockImplementation(async (key: string) => {
      if (key === 'user:system:clips') return ['batshit_guide', 'goon_guide']
      if (key === 'user:user-1:sessions') return ['session-a', 'session-b']
      return []
    })
    redisKeysMock.mockResolvedValue(['user:user-1:sessions'])

    await removeRetiredSystemClips()

    expect(removeClipFromSessionStateMock).toHaveBeenCalledWith('session-a', 'batshit_guide')
    expect(removeClipFromSessionStateMock).toHaveBeenCalledWith('session-b', 'batshit_guide')
    expect(redisSRemMock).toHaveBeenCalledWith('user:system:clips', 'batshit_guide')
    expect(redisDelMock).toHaveBeenCalledWith('clip:system:batshit_guide')
    // Goon Guide is not retired and must remain untouched.
    expect(redisSRemMock).not.toHaveBeenCalledWith('user:system:clips', 'goon_guide')
    expect(redisDelMock).not.toHaveBeenCalledWith('clip:system:goon_guide')
  })

  it('still removes a dangling membership when only the set entry remains', async () => {
    redisExistsMock.mockResolvedValue(false)
    redisSMembersMock.mockImplementation(async (key: string) => {
      if (key === 'user:system:clips') return ['batshit_guide']
      return []
    })
    redisKeysMock.mockResolvedValue([])

    await removeRetiredSystemClips()

    expect(redisSRemMock).toHaveBeenCalledWith('user:system:clips', 'batshit_guide')
    expect(redisDelMock).toHaveBeenCalledWith('clip:system:batshit_guide')
  })
})
