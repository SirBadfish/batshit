import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { failNextRedisCommand } from '$lib/test-utils/redis-command-failure'
import { redis } from '$lib/server/redis'
import {
  AgentAvatarDeletionError,
  avatarUploadFilename,
  checkBatshitServerCanDeleteAvatars,
  deleteAgentAvatars,
  deleteOwnerAvatars,
  isAvatarOwnerId,
  tidyOwnerAvatars
} from '$lib/server/services/agentAvatarDeletion'

/**
 * BL-41: deleting an agent asks batshit-server to sweep the agent's avatar pictures. The
 * pictures are batshit-server's (it writes the record and the file), so this module only
 * decides WHAT to ask for and turns a refusal into an error the agent delete can show:
 * - the agent's own pictures are found by batshit-server by name, so nothing is sent for them;
 * - a pre-2025-08-12 picture (`avatar_<timestamp>.jpg`) names no owner, so the agent record's
 *   pointer is the only proof, and it is sent only when nobody else points at the same file.
 */

useRedisTestServer()

const USER = 'user-avatar-delete'
const SERVER = 'http://batshit-server.test:5613'
const TOKEN = 'test-r-delete-service-token'

function okResponse(body: Record<string, unknown> = { success: true, deletedRecords: [], deletedFiles: [] }) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body))
}

/**
 * A batshit-server that accepts the connection and never answers. It honours the caller's
 * abort signal the way real `fetch` does; a call made WITHOUT a signal fails on its own after
 * 300 ms with a reason that says so, so a missing time limit fails the test instead of hanging.
 */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          setTimeout(() => reject(new Error('no time limit: this call would hang')), 300)
          return
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
  )
}

beforeEach(() => {
  vi.stubEnv('BATSHIT_SERVER_URL', SERVER)
  vi.stubEnv('BATSHIT_TOKEN', TOKEN)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('avatarUploadFilename', () => {
  it.each([
    ['/uploads/avatars/agent_bob_1790000000000.jpg', 'agent_bob_1790000000000.jpg'],
    ['http://localhost:5600/uploads/avatars/avatar_1754000000000.jpg', 'avatar_1754000000000.jpg'],
    ['https://127.0.0.1:5613/uploads/avatars/avatar_1754000000000.jpg?v=2#top', 'avatar_1754000000000.jpg'],
    ['/uploads/avatars/%61vatar_1754000000000.jpg', 'avatar_1754000000000.jpg']
  ])('reads %s as %s', (value, expected) => {
    expect(avatarUploadFilename(value)).toBe(expected)
  })

  it.each([
    ['another upload type', '/uploads/images/avatar_1754000000000.jpg'],
    ['a nested path', '/uploads/avatars/a/avatar_1754000000000.jpg'],
    ['an encoded slash', '/uploads/avatars/..%2Favatar_1754000000000.jpg'],
    ['a bundled asset', '/assets/batshit_default_AI_Avatar_1.png'],
    ['an empty string', ''],
    ['a non-string', 42],
    ['null', null]
  ])('ignores %s', (_label, value) => {
    expect(avatarUploadFilename(value)).toBeNull()
  })
})

describe('deleteAgentAvatars', () => {
  it('asks batshit-server, with the service token, to sweep the agent by id; its own organized picture is found by name, not sent', async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        success: true,
        deletedRecords: ['upload:avatars:agent:agent_bob_1790000000000.jpg'],
        deletedFiles: ['avatars/agent_bob_1790000000000.jpg']
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await deleteAgentAvatars(USER, {
      id: 'bob',
      avatar: '/uploads/avatars/agent_bob_1790000000000.jpg',
      avatar_url: '/uploads/avatars/agent_bob_1790000000000.jpg'
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${SERVER}/api/upload/avatar`)
    expect(init.method).toBe('DELETE')
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      'x-batshit-service-token': TOKEN
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(sentBody(fetchMock)).toEqual({ entityType: 'agent', entityId: 'bob', legacyFilenames: [] })
    expect(result).toEqual({
      deletedRecords: ['upload:avatars:agent:agent_bob_1790000000000.jpg'],
      deletedFiles: ['avatars/agent_bob_1790000000000.jpg'],
      keptSharedLegacy: []
    })
  })

  it('sends the legacy flat picture the agent points at when nobody else points at it', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    await redis.set(`user:${USER}:settings`, { avatar_url: '/uploads/avatars/user_user-avatar-delete_1790000000000.jpg' })

    await deleteAgentAvatars(USER, {
      id: 'bob',
      avatar: 'http://localhost:5600/uploads/avatars/avatar_1754000000000.jpg',
      avatar_url: '/uploads/avatars/avatar_1754000000000.jpg'
    })

    expect(sentBody(fetchMock).legacyFilenames).toEqual(['avatar_1754000000000.jpg'])
  })

  it.each([
    [
      'the user',
      async () => {
        await redis.set(`user:${USER}:settings`, { avatar_url: '/uploads/avatars/avatar_1754000000000.jpg' })
      }
    ],
    [
      'another agent',
      async () => {
        await redis.createAgent({ id: 'alice', user_id: USER, avatar: '/uploads/avatars/avatar_1754000000000.jpg' } as any)
      }
    ],
    [
      'a Subagent',
      async () => {
        await redis.set('subagent:helper', { id: 'helper', user_id: USER, avatar: '/uploads/avatars/avatar_1754000000000.jpg' })
        await redis.sAdd(`user:${USER}:subagents`, 'helper')
      }
    ],
    [
      'a Group',
      async () => {
        await redis.set('group:crew', { id: 'crew', user_id: USER, avatar_url: '/uploads/avatars/avatar_1754000000000.jpg' })
        await redis.sAdd(`user:${USER}:groups`, 'crew')
      }
    ]
  ])('keeps a legacy flat picture that %s also points at', async (_owner, seedOtherReference) => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    await redis.createAgent({ id: 'bob', user_id: USER, avatar: '/uploads/avatars/avatar_1754000000000.jpg' } as any)
    await seedOtherReference()

    const result = await deleteAgentAvatars(USER, {
      id: 'bob',
      avatar: '/uploads/avatars/avatar_1754000000000.jpg'
    })

    expect(sentBody(fetchMock).legacyFilenames).toEqual([])
    expect(result.keptSharedLegacy).toEqual(['avatar_1754000000000.jpg'])
  })

  it('a Redis error while checking the other records refuses; it never reads as "nobody else shows it"', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    await redis.set('group:crew', { id: 'crew', user_id: USER, avatar_url: '/uploads/avatars/avatar_1754000000000.jpg' })
    await redis.sAdd(`user:${USER}:groups`, 'crew')
    // BL-607: failed at the client the code reads through, so it fails on real Redis too.
    const failure = failNextRedisCommand('json.get', new Error('Socket closed unexpectedly'))

    const error = await deleteAgentAvatars(USER, {
      id: 'bob',
      avatar: '/uploads/avatars/avatar_1754000000000.jpg'
    })
      .catch((caught) => caught)
      .finally(failure.restore)

    expect(failure.failed()).toBe(true)
    expect(error).toBeInstanceOf(AgentAvatarDeletionError)
    expect(error.status).toBe(500)
    expect(error.message).toMatch(/Socket closed unexpectedly/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never sends another owner’s organized picture or a bundled default, even when the agent points at it', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    await deleteAgentAvatars(USER, {
      id: 'bob',
      avatar: '/uploads/avatars/user_user-avatar-delete_1790000000000.jpg',
      avatar_url: '/uploads/avatars/default_agent_avatar.png'
    })

    expect(sentBody(fetchMock).legacyFilenames).toEqual([])
  })

  it('turns "batshit-server did not answer" into a 503 the agent delete can show', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:5613') })
      })
    )

    const error = await deleteAgentAvatars(USER, { id: 'bob' }).catch((caught) => caught)

    expect(error).toBeInstanceOf(AgentAvatarDeletionError)
    expect(error.status).toBe(503)
    expect(error.code).toBe('agent_avatar_delete_failed')
    expect(error.message).toMatch(/avatar pictures/)
    expect(error.message).toMatch(/batshit-server did not answer/)
    expect(error.message).toMatch(/ECONNREFUSED/)
  })

  it('gives up on a batshit-server that never answers: a 503 that says it did not answer in time', async () => {
    vi.stubGlobal('fetch', hangingFetch())

    const error = await deleteAgentAvatars(USER, { id: 'bob' }, { timeoutMs: 50 }).catch((caught) => caught)

    // Only the time limit produces this wording; the mock's own no-signal failure says otherwise.
    expect(error).toBeInstanceOf(AgentAvatarDeletionError)
    expect(error.status).toBe(503)
    expect(error.message).toMatch(/batshit-server did not answer within 50 ms/)
  })

  it('carries batshit-server’s own refusal and reason (503 stays 503, anything else is 502)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: 'Upload storage unavailable: Redis is not connected, so no avatar was deleted.' }),
          { status: 503, headers: { 'content-type': 'application/json' } }
        )
      )
    )
    const unavailable = await deleteAgentAvatars(USER, { id: 'bob' }).catch((caught) => caught)
    expect(unavailable).toBeInstanceOf(AgentAvatarDeletionError)
    expect(unavailable.status).toBe(503)
    expect(unavailable.message).toMatch(/Redis is not connected/)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: 'Avatar delete failed', details: 'Avatar record x points at avatars/y.jpg' }),
          { status: 500, headers: { 'content-type': 'application/json' } }
        )
      )
    )
    const failed = await deleteAgentAvatars(USER, { id: 'bob' }).catch((caught) => caught)
    expect(failed).toBeInstanceOf(AgentAvatarDeletionError)
    expect(failed.status).toBe(502)
    expect(failed.message).toMatch(/answered 500/)
    expect(failed.message).toMatch(/points at avatars\/y\.jpg/)
  })
})

describe('deleteOwnerAvatars for a Subagent or a Group (BL-139, BL-140)', () => {
  it.each([
    ['subagent', 'Subagent', { avatar: '/uploads/avatars/subagent_cr_subagent_1770865895722.jpg' }],
    ['group', 'Group', { avatar_url: 'http://localhost:5600/uploads/avatars/group_new_group_1775792747492.jpg' }]
  ] as const)('asks batshit-server to sweep the %s by id', async (type, _label, fields) => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    await deleteOwnerAvatars(USER, { type, id: type === 'group' ? 'new_group' : 'cr_subagent', ...fields })

    expect(sentBody(fetchMock)).toEqual({
      entityType: type,
      entityId: type === 'group' ? 'new_group' : 'cr_subagent',
      legacyFilenames: []
    })
  })

  it('a Subagent’s legacy flat picture that an AGENT with the same id shows stays (the owner skipped is the Subagent, not the agent)', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    await redis.createAgent({ id: 'helper', user_id: USER, avatar: '/uploads/avatars/avatar_1754000000000.jpg' } as any)
    await redis.set('subagent:helper', { id: 'helper', user_id: USER, avatar: '/uploads/avatars/avatar_1754000000000.jpg' })
    await redis.sAdd(`user:${USER}:subagents`, 'helper')

    const result = await deleteOwnerAvatars(USER, {
      type: 'subagent',
      id: 'helper',
      avatar: '/uploads/avatars/avatar_1754000000000.jpg'
    })

    expect(sentBody(fetchMock).legacyFilenames).toEqual([])
    expect(result.keptSharedLegacy).toEqual(['avatar_1754000000000.jpg'])
  })

  it('a Group’s own legacy flat picture that nothing else shows goes with it', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    await redis.set('group:crew', { id: 'crew', user_id: USER, avatar_url: '/uploads/avatars/avatar_1754000000000.jpg' })
    await redis.sAdd(`user:${USER}:groups`, 'crew')

    await deleteOwnerAvatars(USER, { type: 'group', id: 'crew', avatar_url: '/uploads/avatars/avatar_1754000000000.jpg' })

    expect(sentBody(fetchMock).legacyFilenames).toEqual(['avatar_1754000000000.jpg'])
  })

  it('names the owner in a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:5613') })
      })
    )

    const error = await deleteOwnerAvatars(USER, { type: 'group', id: 'crew' }).catch((caught) => caught)

    expect(error).toBeInstanceOf(AgentAvatarDeletionError)
    expect(error.status).toBe(503)
    expect(error.message).toMatch(/^Could not delete this Group's avatar pictures: batshit-server did not answer/)
  })
})

describe('isAvatarOwnerId', () => {
  it.each(['bob', 'n8n_agent_ctrlain', 'b2c8f713-12af-4448-84ac-bf80a2866dab'])('accepts %s', (id) => {
    expect(isAvatarOwnerId(id)).toBe(true)
  })
  it.each(['', 'a.b', 'a b', 'a*', '../x', 7, null])('refuses %s', (id) => {
    expect(isAvatarOwnerId(id)).toBe(false)
  })
})

describe('tidyOwnerAvatars (BL-142: after a save, the owner keeps only the picture it shows)', () => {
  it('keeps the owner’s own picture its saved record shows and asks for the rest', async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        success: true,
        deletedRecords: ['upload:avatars:subagent:subagent_helper_1790000000001.jpg'],
        deletedFiles: ['avatars/subagent_helper_1790000000001.jpg']
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await tidyOwnerAvatars({
      type: 'subagent',
      id: 'helper',
      avatar: 'http://localhost:5600/uploads/avatars/subagent_helper_1790000000002.jpg'
    })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${SERVER}/api/upload/avatar`)
    expect(init.method).toBe('DELETE')
    expect(init.headers).toMatchObject({ 'x-batshit-service-token': TOKEN })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(sentBody(fetchMock)).toEqual({
      tidy: true,
      entityType: 'subagent',
      entityId: 'helper',
      keepFilenames: ['subagent_helper_1790000000002.jpg']
    })
    expect(result).toEqual({
      deletedRecords: ['upload:avatars:subagent:subagent_helper_1790000000001.jpg'],
      deletedFiles: ['avatars/subagent_helper_1790000000001.jpg'],
      kept: ['subagent_helper_1790000000002.jpg']
    })
  })

  it('an owner showing no picture (cleared, or an icon) keeps none of its pictures', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    await tidyOwnerAvatars({ type: 'agent', id: 'bob', avatar: null, avatar_url: '' })

    expect(sentBody(fetchMock)).toEqual({ tidy: true, entityType: 'agent', entityId: 'bob', keepFilenames: [] })
  })

  // BL-281 (2026-09-27): the user's own pictures are tidied too, and the refusal speaks to them.
  it('tidies the user’s pictures, keeping the one their settings show', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Upload storage unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = await tidyOwnerAvatars({
      type: 'user',
      id: 'josh',
      avatar_url: 'http://localhost:5610/uploads/avatars/user_josh_1790000000005.jpg'
    }).catch((caught) => caught)

    expect(sentBody(fetchMock)).toEqual({
      tidy: true,
      entityType: 'user',
      entityId: 'josh',
      keepFilenames: ['user_josh_1790000000005.jpg']
    })
    expect(error).toBeInstanceOf(AgentAvatarDeletionError)
    expect(error.message).toMatch(/^Could not delete your old avatar pictures: batshit-server answered 503/)
  })

  it('a picture that is not the owner’s own (another owner’s, a legacy flat one, a bundled default) is never named, and never swept either', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    await tidyOwnerAvatars({
      type: 'agent',
      id: 'bob',
      avatar: '/uploads/avatars/agent_bob_2_1790000000000.jpg',
      avatar_url: '/uploads/avatars/avatar_1754000000000.jpg'
    })

    // Only the owner's own names are swept by batshit-server, so neither of these is at risk.
    expect(sentBody(fetchMock).keepFilenames).toEqual([])
  })

  it('carries a refusal as an error with the owner named', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'Avatar delete failed', details: 'x points at avatars/y.jpg' }), {
          status: 500,
          headers: { 'content-type': 'application/json' }
        })
      )
    )

    const error = await tidyOwnerAvatars({ type: 'agent', id: 'bob' }).catch((caught) => caught)

    expect(error).toBeInstanceOf(AgentAvatarDeletionError)
    expect(error.status).toBe(502)
    expect(error.message).toMatch(/^Could not delete this agent's old avatar pictures: batshit-server answered 500/)
  })
})

describe('checkBatshitServerCanDeleteAvatars (before the agent delete removes anything)', () => {
  function healthResponse(status: number, redis: boolean) {
    return new Response(
      JSON.stringify({ ok: redis, service: 'batshit-server', checks: { http: true, redis } }),
      { status, headers: { 'content-type': 'application/json' } }
    )
  }

  it('asks batshit-server’s health check with the service token and a time limit, and passes when its Redis is ready', async () => {
    const fetchMock = vi.fn(async () => healthResponse(200, true))
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkBatshitServerCanDeleteAvatars()).resolves.toBeUndefined()

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${SERVER}/health`)
    expect(init.method).toBe('GET')
    expect(init.headers).toMatchObject({ 'x-batshit-service-token': TOKEN })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('batshit-server not running: 503, and the reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:5613') })
      })
    )

    const error = await checkBatshitServerCanDeleteAvatars().catch((caught) => caught)

    expect(error).toBeInstanceOf(AgentAvatarDeletionError)
    expect(error.status).toBe(503)
    expect(error.code).toBe('batshit_server_unavailable')
    expect(error.message).toMatch(/batshit-server did not answer \(connect ECONNREFUSED 127\.0\.0\.1:5613\)/)
  })

  it('batshit-server running without its Redis (health answers 503): refused, because its sweep would be too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => healthResponse(503, false)))

    const error = await checkBatshitServerCanDeleteAvatars().catch((caught) => caught)

    expect(error).toBeInstanceOf(AgentAvatarDeletionError)
    expect(error.status).toBe(503)
    expect(error.message).toMatch(/its Redis is not ready/)
  })

  it('batshit-server that never answers: gives up at the time limit', async () => {
    vi.stubGlobal('fetch', hangingFetch())

    const error = await checkBatshitServerCanDeleteAvatars({ timeoutMs: 50 }).catch((caught) => caught)

    expect(error).toBeInstanceOf(AgentAvatarDeletionError)
    expect(error.status).toBe(503)
    expect(error.message).toMatch(/batshit-server did not answer within 50 ms/)
  })
})
