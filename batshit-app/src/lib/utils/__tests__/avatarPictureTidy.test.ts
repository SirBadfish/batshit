import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  avatarPictureName,
  requestAvatarPictureTidy,
  shouldTidyAvatarPictures
} from '$lib/utils/avatarPictureTidy'

/**
 * BL-142 / BL-145 (2026-09-25): the agent and Subagent settings no longer delete the old
 * picture when a new one is uploaded (a save the form then refused kept pointing at the deleted
 * picture). After a save that CHANGED the picture, and only while nothing newer is on its way
 * (no upload running, the form still shows what was saved), the panel asks the server to tidy:
 * every picture of that owner except the one the saved record shows.
 */

describe('avatarPictureName', () => {
  it.each([
    ['/uploads/avatars/agent_bob_1790000000000.jpg', 'agent_bob_1790000000000.jpg'],
    ['http://localhost:5610/uploads/avatars/agent_bob_1790000000000.jpg?v=1', 'agent_bob_1790000000000.jpg'],
    ['https://tunnel.example/uploads/avatars/agent_bob_1790000000000.jpg#x', 'agent_bob_1790000000000.jpg']
  ])('reads %s', (value, expected) => {
    expect(avatarPictureName(value)).toBe(expected)
  })

  it.each([null, undefined, '', '/assets/batshit_default_AI_Avatar_1.png', '/uploads/images/a.jpg', 7])(
    'reads %s as no picture',
    (value) => {
      expect(avatarPictureName(value)).toBeNull()
    }
  )
})

describe('shouldTidyAvatarPictures', () => {
  const OLD = 'http://localhost:5610/uploads/avatars/agent_bob_1790000000001.jpg'
  const NEW = '/uploads/avatars/agent_bob_1790000000002.jpg'

  it('a save that changed the picture, with the form still showing it and no upload running: tidy', () => {
    expect(shouldTidyAvatarPictures({ previous: OLD, saved: NEW, current: NEW, uploading: false })).toBe(true)
  })

  it('a save that cleared the picture (or chose an icon): tidy', () => {
    expect(shouldTidyAvatarPictures({ previous: OLD, saved: null, current: null, uploading: false })).toBe(true)
  })

  it('the same picture under another host or form of URL is no change: no tidy', () => {
    expect(
      shouldTidyAvatarPictures({
        previous: 'http://localhost:5600/uploads/avatars/agent_bob_1790000000001.jpg',
        saved: '/uploads/avatars/agent_bob_1790000000001.jpg',
        current: '/uploads/avatars/agent_bob_1790000000001.jpg',
        uploading: false
      })
    ).toBe(false)
  })

  it('a save of other fields: no tidy', () => {
    expect(shouldTidyAvatarPictures({ previous: null, saved: null, current: null, uploading: false })).toBe(false)
  })

  it('an upload still running: no tidy (its picture would be swept before its save lands)', () => {
    expect(shouldTidyAvatarPictures({ previous: OLD, saved: NEW, current: NEW, uploading: true })).toBe(false)
  })

  it('the form already shows a newer picture than the one saved: no tidy yet (the next save tidies)', () => {
    expect(
      shouldTidyAvatarPictures({
        previous: OLD,
        saved: NEW,
        current: '/uploads/avatars/agent_bob_1790000000003.jpg',
        uploading: false
      })
    ).toBe(false)
  })
})

describe('requestAvatarPictureTidy', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each(['agent', 'subagent', 'group', 'user'] as const)(
    'asks DELETE /api/uploads/avatar for the %s only (BL-281: Groups and the user too)',
    async (entityType) => {
      const fetchMock = vi.fn(async () => Response.json({ success: true, deletedRecords: [], deletedFiles: [], kept: [] }))
      vi.stubGlobal('fetch', fetchMock)

      await requestAvatarPictureTidy(entityType, 'helper')

      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('/api/uploads/avatar')
      expect(init.method).toBe('DELETE')
      expect(JSON.parse(String(init.body))).toEqual({ entityType, entityId: 'helper' })
    }
  )

  // BL-288: the picture the save replaced goes along, so a cleared picture's tidy can delete it
  // (and older ones) at once while a newer upload on its way to a save stays.
  it('names the picture the save replaced, and nothing when it replaced none', async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true }))
    vi.stubGlobal('fetch', fetchMock)

    await requestAvatarPictureTidy('group', 'crew', 'http://localhost:5610/uploads/avatars/group_crew_1790000000001.jpg?v=2')
    await requestAvatarPictureTidy('group', 'crew', null)

    const bodies = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).map((call) => JSON.parse(String(call[1].body)))
    expect(bodies).toEqual([
      { entityType: 'group', entityId: 'crew', replaced: 'group_crew_1790000000001.jpg' },
      { entityType: 'group', entityId: 'crew' }
    ])
  })

  it('a refusal is reported in the console, never thrown into the save that already succeeded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'batshit-server did not answer' }), { status: 503 }))
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(requestAvatarPictureTidy('agent', 'bob')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('old avatar pictures'),
      expect.stringContaining('batshit-server did not answer')
    )
  })
})
