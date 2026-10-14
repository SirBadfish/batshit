// @vitest-environment node
// Server-only request handlers; node's native Request/FormData/File parse multipart correctly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * BL-143 (2026-09-25): the avatar upload proxy checks the owner before batshit-server sees the
 * upload. batshit-server names every picture after its owner, which is the only way a delete or
 * a tidy can find it again, so an owner id outside the owner id rule, an owner that does not
 * exist, or another user's owner is refused; before, `entityId` went through unchecked and a
 * missing one made an ownerless `avatar_<ts>.jpg`. The proxy forwards exactly the fields it
 * checked (a fresh form), never the browser's form as is.
 *
 * BL-142 (2026-09-25): `DELETE /api/uploads/avatar` tidies a living owner after its settings
 * save: every picture of that owner except the one its SAVED record shows. The user and Groups
 * too since BL-281 (2026-09-27), and no upload deletes a picture any more.
 */

useRedisTestServer()

const USER = 'user-avatar-proxy'
const SERVER = 'http://batshit-server.test:5600'

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubEnv('BATSHIT_TOKEN', 'proxy-test-token')
  vi.stubEnv('BATSHIT_SERVER_URL', SERVER)
  vi.stubEnv('PUBLIC_BATSHIT_SERVER_URL', 'http://localhost:5610')
  fetchSpy = vi.fn(async () =>
    Response.json({ success: true, url: `${SERVER}/uploads/avatars/x.jpg`, filename: 'x.jpg' })
  )
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function seedOwner(type: 'agent' | 'subagent' | 'group', id: string, fields: Record<string, unknown> = {}) {
  await redis.json.set(`${type}:${id}`, '$', { id, user_id: USER, ...fields })
}

function uploadForm(fields: Record<string, string>) {
  const form = new FormData()
  form.append('file', new File(['png-bytes'], 'picked.png', { type: 'image/png' }))
  for (const [name, value] of Object.entries(fields)) form.append(name, value)
  return form
}

async function upload(fields: Record<string, string>, user: { id: string } | null = { id: USER }) {
  const { POST } = await import('./+server')
  return POST({
    request: new Request('http://localhost/api/uploads/avatar', { method: 'POST', body: uploadForm(fields) }),
    locals: { user }
  } as never)
}

async function tidy(body: unknown, user: { id: string } | null = { id: USER }) {
  const { DELETE } = await import('./+server')
  return DELETE({
    request: new Request('http://localhost/api/uploads/avatar', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user }
  } as never)
}

describe('POST /api/uploads/avatar owner check (BL-143)', () => {
  it.each([
    ['agent', 'bob'],
    ['subagent', 'cr_subagent'],
    ['group', 'new_group']
  ] as const)('forwards an upload for the user’s own %s, as a fresh form with only the checked fields', async (type, id) => {
    await seedOwner(type, id)
    const form = { entityType: type, entityId: id, somethingElse: 'dropped' }

    const response = await upload(form)

    expect(response.status).toBe(200)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${SERVER}/api/upload/avatar`)
    const forwarded = init.body as FormData
    expect([...forwarded.keys()].sort()).toEqual(['entityId', 'entityType', 'file'])
    expect(forwarded.get('entityType')).toBe(type)
    expect(forwarded.get('entityId')).toBe(id)
    expect((forwarded.get('file') as File).name).toBe('picked.png')
  })

  it('forwards the user’s own avatar, and refuses another user id', async () => {
    expect((await upload({ entityType: 'user', entityId: USER })).status).toBe(200)
    const refused = await upload({ entityType: 'user', entityId: 'someone-else' })
    expect(refused.status).toBe(403)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['no entityId', { entityType: 'agent' }, 400],
    ['an empty entityId', { entityType: 'agent', entityId: '' }, 400],
    ['a glob in the id', { entityType: 'agent', entityId: 'bob*' }, 400],
    ['a dot in the id', { entityType: 'agent', entityId: 'a.b' }, 400],
    ['a path in the id', { entityType: 'agent', entityId: '../bob' }, 400],
    ['an agent that does not exist', { entityType: 'agent', entityId: 'nobody' }, 404],
    ['a Subagent that does not exist', { entityType: 'subagent', entityId: 'nobody' }, 404],
    ['a Group that does not exist', { entityType: 'group', entityId: 'nobody' }, 404]
  ])('refuses %s before batshit-server sees it', async (_label, fields, status) => {
    const response = await upload(fields as Record<string, string>)

    expect(response.status).toBe(status)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses another user’s agent', async () => {
    await redis.json.set('agent:theirs', '$', { id: 'theirs', user_id: 'someone-else' })

    const response = await upload({ entityType: 'agent', entityId: 'theirs' })

    expect(response.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // BL-281 (2026-09-27): no panel names the picture it replaces any more, and an upload
  // deletes nothing: every panel tidies after its save instead.
  it('never forwards an old picture, not even the same owner’s own', async () => {
    await seedOwner('group', 'new_group')

    await upload({
      entityType: 'group',
      entityId: 'new_group',
      oldAvatarUrl: 'http://localhost:5610/uploads/avatars/group_new_group_1775792747492.jpg'
    })
    await upload({
      entityType: 'user',
      entityId: USER,
      oldAvatarUrl: `/uploads/avatars/user_${USER}_1775362752696.jpg`
    })

    for (const call of fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect((call[1].body as FormData).has('oldAvatarUrl')).toBe(false)
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

describe('DELETE /api/uploads/avatar: tidy after a save (BL-142)', () => {
  it('asks batshit-server to keep only the picture the SAVED record shows', async () => {
    await seedOwner('agent', 'bob', {
      avatar: 'http://localhost:5600/uploads/avatars/agent_bob_1790000000002.jpg',
      avatar_url: '/uploads/avatars/agent_bob_1790000000002.jpg'
    })
    fetchSpy.mockResolvedValueOnce(
      Response.json({
        success: true,
        deletedRecords: ['upload:avatars:agent:agent_bob_1790000000001.jpg'],
        deletedFiles: ['avatars/agent_bob_1790000000001.jpg']
      })
    )

    const response = await tidy({ entityType: 'agent', entityId: 'bob' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      deletedRecords: ['upload:avatars:agent:agent_bob_1790000000001.jpg'],
      deletedFiles: ['avatars/agent_bob_1790000000001.jpg'],
      kept: ['agent_bob_1790000000002.jpg']
    })
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${SERVER}/api/upload/avatar`)
    expect(init.method).toBe('DELETE')
    expect(JSON.parse(String(init.body))).toEqual({
      tidy: true,
      entityType: 'agent',
      entityId: 'bob',
      keepFilenames: ['agent_bob_1790000000002.jpg']
    })
  })

  // BL-288: the replaced picture goes on to batshit-server only when it is the owner's own.
  it('passes the picture the save replaced when it is the owner’s own, and drops anything else', async () => {
    await seedOwner('subagent', 'helper', { avatar: null })

    await tidy({ entityType: 'subagent', entityId: 'helper', replaced: 'subagent_helper_1790000000001.jpg' })
    await tidy({ entityType: 'subagent', entityId: 'helper', replaced: 'agent_helper_1790000000001.jpg' })
    await tidy({ entityType: 'subagent', entityId: 'helper', replaced: '../x.jpg' })

    const bodies = (fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>).map((call) =>
      JSON.parse(String(call[1].body))
    )
    expect(bodies[0]).toEqual({
      tidy: true,
      entityType: 'subagent',
      entityId: 'helper',
      keepFilenames: [],
      replacedFilename: 'subagent_helper_1790000000001.jpg'
    })
    expect(bodies[1]).not.toHaveProperty('replacedFilename')
    expect(bodies[2]).not.toHaveProperty('replacedFilename')
  })

  it('a Subagent that shows no picture (cleared, or an icon) keeps none', async () => {
    await seedOwner('subagent', 'helper', { avatar: null })

    const response = await tidy({ entityType: 'subagent', entityId: 'helper' })

    expect(response.status).toBe(200)
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(String(init.body)).keepFilenames).toEqual([])
  })

  // BL-281: the Group and User panels tidy too.
  it('a Group keeps the picture its SAVED record shows', async () => {
    await seedOwner('group', 'crew', { avatar_url: '/uploads/avatars/group_crew_1790000000004.jpg' })

    const response = await tidy({ entityType: 'group', entityId: 'crew' })

    expect(response.status).toBe(200)
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(String(init.body))).toEqual({
      tidy: true,
      entityType: 'group',
      entityId: 'crew',
      keepFilenames: ['group_crew_1790000000004.jpg']
    })
  })

  it('the user keeps the picture their SAVED settings show', async () => {
    await redis.json.set(`user:${USER}:settings`, '$', {
      id: `settings_${USER}`,
      user_id: USER,
      avatar_url: `http://localhost:5610/uploads/avatars/user_${USER}_1790000000007.jpg`
    })

    const response = await tidy({ entityType: 'user', entityId: USER })

    expect(response.status).toBe(200)
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(String(init.body))).toEqual({
      tidy: true,
      entityType: 'user',
      entityId: USER,
      keepFilenames: [`user_${USER}_1790000000007.jpg`]
    })
    await redis.del(`user:${USER}:settings`)
  })

  it('a user with no saved settings keeps none', async () => {
    const response = await tidy({ entityType: 'user', entityId: USER })

    expect(response.status).toBe(200)
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(String(init.body)).keepFilenames).toEqual([])
  })

  it.each([
    ['no user', { entityType: 'agent', entityId: 'bob' }, null, 401],
    ['another user’s avatar', { entityType: 'user', entityId: 'someone-else' }, { id: USER }, 403],
    ['an unknown owner type', { entityType: 'goon', entityId: 'bob' }, { id: USER }, 400],
    ['an id outside the rule', { entityType: 'agent', entityId: 'a.b' }, { id: USER }, 400],
    ['an owner that does not exist', { entityType: 'agent', entityId: 'nobody' }, { id: USER }, 404]
  ])('refuses %s and asks batshit-server nothing', async (_label, body, user, status) => {
    const response = await tidy(body, user)

    expect(response.status).toBe(status)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses another user’s agent', async () => {
    await redis.json.set('agent:theirs', '$', { id: 'theirs', user_id: 'someone-else' })

    const response = await tidy({ entityType: 'agent', entityId: 'theirs' })

    expect(response.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('carries batshit-server’s refusal', async () => {
    await seedOwner('agent', 'bob')
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Upload storage unavailable: Redis is not connected, so no avatar was deleted.' }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      })
    )

    const response = await tidy({ entityType: 'agent', entityId: 'bob' })

    expect(response.status).toBe(503)
    expect((await response.json()).error).toMatch(/Could not delete this agent's old avatar pictures: .*Redis is not connected/)
  })
})
