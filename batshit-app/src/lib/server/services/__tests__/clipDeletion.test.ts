import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    sMembers: vi.fn(),
    sRem: vi.fn(),
    sAdd: vi.fn()
  }
}))

vi.mock('$lib/server/redis', () => ({
  redis: mocks.redis
}))

vi.mock('$lib/server/services/batshitServerUrls', () => ({
  getInternalBatshitServerUrl: () => 'http://batshit-server.test',
  getInternalBatshitServerAuthHeaders: () => ({ 'x-batshit-service-token': 'test-token' })
}))

import { deleteUserClips } from '../clipDeletion'

describe('clipDeletion', () => {
  const values = new Map<string, any>()

  beforeEach(() => {
    vi.clearAllMocks()
    values.clear()

    mocks.redis.get.mockImplementation(async (key: string) => values.get(key) ?? null)
    mocks.redis.set.mockImplementation(async (key: string, value: any) => {
      values.set(key, value)
    })
    mocks.redis.del.mockImplementation(async (key: string) => {
      values.delete(key)
    })
    mocks.redis.sMembers.mockImplementation(async (key: string) =>
      key === 'user:josh:sessions' ? ['session-a', 'session-b'] : []
    )
    mocks.redis.sRem.mockResolvedValue(undefined)
    mocks.redis.sAdd.mockResolvedValue(undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
    )
  })

  it('deletes clips and removes them from session clip state', async () => {
    values.set('clip:josh:clip-a', {
      id: 'clip-a',
      filename: 'ss.jpg',
      localUrl: 'http://localhost:5600/uploads/images/uploaded-ss.jpg'
    })
    values.set('session:session-a:clip_state', {
      sessionId: 'session-a',
      clips: [
        { clipId: 'clip-a', attachedAt: '2026-05-22T00:00:00.000Z' },
        { clipId: 'clip-keep', attachedAt: '2026-05-22T00:00:01.000Z' }
      ]
    })
    values.set('session:session-b:clip_state', {
      sessionId: 'session-b',
      clips: [{ clipId: 'clip-a', attachedAt: '2026-05-22T00:00:00.000Z' }]
    })

    const results = await deleteUserClips('josh', ['clip-a'])

    expect(results).toEqual([{ clipId: 'clip-a', deleted: true, missing: false }])
    expect(fetch).toHaveBeenCalledWith(
      'http://batshit-server.test/api/upload/asset',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ uploadType: 'images', filename: 'uploaded-ss.jpg' })
      })
    )
    expect(mocks.redis.del).not.toHaveBeenCalledWith('upload:images:ss.jpg')
    expect(mocks.redis.del).not.toHaveBeenCalledWith('upload:documents:ss.jpg')
    expect(mocks.redis.del).toHaveBeenCalledWith('clip:josh:clip-a')
    expect(mocks.redis.sRem).toHaveBeenCalledWith('user:josh:clips', 'clip-a')
    expect(mocks.redis.sRem).toHaveBeenCalledWith('session:session-a:active_clips', 'clip-a')
    expect(mocks.redis.sRem).toHaveBeenCalledWith('session:session-b:active_clips', 'clip-a')
    expect(mocks.redis.del).toHaveBeenCalledWith('session_clip:session-a:clip-a')
    expect(mocks.redis.del).toHaveBeenCalledWith('session_clip:session-b:clip-a')
    expect(values.get('session:session-a:clip_state')?.clips).toEqual([
      expect.objectContaining({
        clipId: 'clip-keep',
        attachedAt: '2026-05-22T00:00:01.000Z'
      })
    ])
    expect(values.get('session:session-b:clip_state')?.clips).toEqual([])
    expect(mocks.redis.sAdd).toHaveBeenCalledWith('session:session-a:active_clips', 'clip-keep')
  })

  it('deletes non-image upload records using the clip upload locator', async () => {
    values.set('clip:josh:clip-doc', {
      id: 'clip-doc',
      filename: 'notes.pdf',
      localUrl: 'http://localhost:5600/uploads/documents/20260613_notes.pdf'
    })

    const results = await deleteUserClips('josh', ['clip-doc'])

    expect(results).toEqual([{ clipId: 'clip-doc', deleted: true, missing: false }])
    expect(fetch).toHaveBeenCalledWith(
      'http://batshit-server.test/api/upload/asset',
      expect.objectContaining({
        body: JSON.stringify({ uploadType: 'documents', filename: '20260613_notes.pdf' })
      })
    )
    expect(mocks.redis.del).not.toHaveBeenCalledWith('upload:images:20260613_notes.pdf')
    expect(mocks.redis.del).not.toHaveBeenCalledWith('upload:documents:notes.pdf')
  })

  it('dedupes requested clip ids while still clearing stale references', async () => {
    const results = await deleteUserClips('josh', ['missing-clip', 'missing-clip', ''])

    expect(results).toEqual([{ clipId: 'missing-clip', deleted: true, missing: true }])
    expect(mocks.redis.sRem).toHaveBeenCalledWith('user:josh:clips', 'missing-clip')
    expect(mocks.redis.sRem).toHaveBeenCalledTimes(5)
  })
})
