import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { failRedisJsonGets, stopFailingRedisJsonGets } from '$lib/test-utils/failRedisJsonGets'
import { listLocalAiServers, resolveLocalAiRuntimeBaseUrl, saveLocalAiServers, saveKoboldManagedProfileReference } from '../localAiServers'

import { deleteLocalAiServer } from '../localAiServerDeletion'

const managedHelper = vi.hoisted(() => vi.fn())
vi.mock('../localAiManagedProfiles', async original => ({ ...await original<typeof import('../localAiManagedProfiles')>(), managedProfileHelper: managedHelper }))
import { redis } from '$lib/server/redis'
useRedisTestServer()

describe('localAiServers', () => {
  it('rewrites loopback local AI base URLs for server-side Docker callers', () => {
    expect(
      resolveLocalAiRuntimeBaseUrl('http://localhost:11434', {
        BATSHIT_CONTAINERIZED: '1'
      })
    ).toBe('http://host.docker.internal:11434/')
  })

  it('leaves loopback local AI base URLs visible outside Docker', () => {
    expect(resolveLocalAiRuntimeBaseUrl('http://localhost:11434', {})).toBe(
      'http://localhost:11434'
    )
  })

  it('leaves explicit sidecar or remote local AI URLs unchanged', () => {
    expect(
      resolveLocalAiRuntimeBaseUrl('http://ollama:11434', {
        BATSHIT_CONTAINERIZED: '1'
      })
    ).toBe('http://ollama:11434')
  })
})

/**
 * BL-977: a failed Redis read of the saved Local AI servers used to be caught in the list, and each
 * server whose read failed was listed as its built-in default (`source: 'default'`). The route
 * answered 200, the Local AI panel counted that as a good read, and one edit then posted every
 * server over the saved addresses. Now a read that failed FAILS the list: nothing is ever listed as
 * a default because a read went wrong. The failure is made in the REAL Redis wrapper (not at a
 * fetch stub) and the REAL route handlers answer it.
 */
describe('a failed read of the saved Local AI servers is a failed list (BL-977)', () => {
  const USER = 'bl977_user'
  const recordKey = (id: string) => `local_provider:${USER}:${id}`
  type RouteModule = typeof import('../../../../routes/api/settings/local-ai/+server')
  let route: RouteModule

  beforeAll(async () => {
    route = await import('../../../../routes/api/settings/local-ai/+server')
  }, 60_000)

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    stopFailingRedisJsonGets()
    vi.restoreAllMocks()
  })

  const seed = () =>
    saveLocalAiServers(USER, [
      { id: 'ollama', baseUrl: 'http://192.168.1.20:11434', openaiPath: '/v1', enabled: true, imageTransport: 'url', imageBaseUrl: 'http://192.168.1.20:5600' },
      { id: 'lmstudio', baseUrl: 'http://192.168.1.21:1234', openaiPath: '/v1', enabled: true, imageTransport: 'auto', imageBaseUrl: 'http://192.168.1.21:5600' }
    ])

  const post = (servers: unknown[]) =>
    route.POST({
      request: new Request('http://localhost/api/settings/local-ai', { method: 'POST', body: JSON.stringify({ servers }) }),
      locals: { user: { id: USER } }
    } as any) as Promise<Response>
  const get = () => route.GET({ locals: { user: { id: USER } } } as any) as Promise<Response>

  it('one server whose record cannot be read fails the list; it is not listed as a default', async () => {
    await seed()
    const failing = failRedisJsonGets((key) => key === recordKey('lmstudio'))
    await expect(listLocalAiServers(USER)).rejects.toThrow('Could not read the saved Local AI servers.')
    expect(failing.failures).toBe(1)
    failing.stop()
    // The read works again: the saved address is still the saved one.
    const list = await listLocalAiServers(USER)
    expect(list.find((server) => server.id === 'lmstudio')).toMatchObject({
      baseUrl: 'http://192.168.1.21:1234',
      source: 'stored'
    })
  })

  it('every record unreadable (Redis down) fails the list; it is not eight defaults', async () => {
    await seed()
    const failing = failRedisJsonGets((key) => key.startsWith(`local_provider:${USER}:`))
    await expect(listLocalAiServers(USER)).rejects.toThrow('Could not read the saved Local AI servers.')
    failing.stop()
  })

  it('keeps the cause of the failed read, for the log', async () => {
    await seed()
    const cause = new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
    failRedisJsonGets((key) => key === recordKey('ollama'), cause)
    const error = await listLocalAiServers(USER).catch((caught) => caught)
    expect((error as Error).cause).toBe(cause)
  })

  it('regression guard, not a proof of a fix (green on the parent code too): a server that was never saved is still listed as its default', async () => {
    const list = await listLocalAiServers(USER)
    expect(list.length).toBeGreaterThan(0)
    expect(list.every((server) => server.source === 'default')).toBe(true)
    expect(list.find((server) => server.id === 'ollama')?.baseUrl).toBe('http://localhost:11434')
  })

  it('GET answers an error, never the defaults, and answers the saved servers again once the read works', async () => {
    await seed()
    const failing = failRedisJsonGets((key) => key === recordKey('lmstudio'))
    const failed = await get()
    expect(failed.status).toBe(500)
    const failedBody = await failed.json()
    expect(failedBody.success).toBe(false)
    expect(failedBody.servers).toBeUndefined()
    failing.stop()

    const good = await get()
    expect(good.status).toBe(200)
    const goodBody = await good.json()
    expect(goodBody.servers.find((server: any) => server.id === 'lmstudio')).toMatchObject({
      baseUrl: 'http://192.168.1.21:1234',
      source: 'stored'
    })
  })

  it('POST with no servers (a plain read) answers an error when the read fails', async () => {
    await seed()
    const failing = failRedisJsonGets((key) => key === recordKey('lmstudio'))
    const failed = await post([])
    expect(failed.status).toBe(400)
    const body = await failed.json()
    expect(body.success).toBe(false)
    expect(body.servers).toBeUndefined()
    failing.stop()
  })

  it('regression guard, not a proof of a fix (green on the parent code too): a save whose read of the saved record fails writes nothing', async () => {
    await seed()
    const failing = failRedisJsonGets((key) => key === recordKey('ollama'))
    const failed = await post([{ id: 'ollama', baseUrl: 'http://localhost:11434', openaiPath: '/v1', enabled: false }])
    expect(failed.status).toBe(400)
    failing.stop()
    const list = await listLocalAiServers(USER)
    expect(list.find((server) => server.id === 'ollama')).toMatchObject({
      baseUrl: 'http://192.168.1.20:11434',
      enabled: true,
      source: 'stored'
    })
  })

  it('a save whose write lands but whose read-back fails answers an error, and the stored record holds what was sent', async () => {
    await seed()
    // The save reads and writes ollama only; the read-back of the whole list reads lmstudio too.
    const failing = failRedisJsonGets((key) => key === recordKey('lmstudio'))
    const failed = await post([{ id: 'ollama', baseUrl: 'http://192.168.1.99:11434', openaiPath: '/v1', enabled: true }])
    expect(failed.status).toBe(400)
    expect((await failed.json()).error).toBe('Could not read the saved Local AI servers.')
    failing.stop()
    const list = await listLocalAiServers(USER)
    expect(list.find((server) => server.id === 'ollama')?.baseUrl).toBe('http://192.168.1.99:11434')
    expect(list.find((server) => server.id === 'lmstudio')).toMatchObject({
      baseUrl: 'http://192.168.1.21:1234',
      source: 'stored'
    })
  })
})

describe('BL-1213 reference lifecycle', () => {
  beforeEach(() => { vi.stubEnv('BATSHIT_RUNTIME_OWNER', 'mac-app'); vi.stubEnv('BATSHIT_CONTAINERIZED', '0'); managedHelper.mockReset() })
  afterEach(() => vi.unstubAllEnvs())
  const USER = 'managed_profile_test'
  const KEY = `local_provider:${USER}:koboldcpp`
  const reference = { version: 1 as const, registrationId: '11111111-1111-4111-8111-111111111111', state: 'active' as const, desired: { modelId: 'model', contextTokens: 60000 } }
  const seedManaged = async () => {
    await saveLocalAiServers(USER, [{ id: 'koboldcpp', baseUrl: 'http://localhost:5001', enabled: true }])
    await saveKoboldManagedProfileReference(USER, reference)
  }
  it('connection edits preserve the managed reference, and reference edits preserve connection siblings', async () => {
    await seedManaged()
    await saveLocalAiServers(USER, [{ id: 'koboldcpp', baseUrl: 'http://localhost:5002', imageTransport: 'url' }])
    expect(await redis.json.get(KEY)).toMatchObject({ baseUrl: 'http://localhost:5002', imageTransport: 'url', managedProfile: reference })
    await saveKoboldManagedProfileReference(USER, { ...reference, desired: { modelId: 'other', contextTokens: 32768 } })
    expect(await redis.json.get(KEY)).toMatchObject({ baseUrl: 'http://localhost:5002', imageTransport: 'url', managedProfile: { desired: { contextTokens: 32768 } } })
  })
  it('durably revokes before deleting the reference, preserving files and user scope', async () => {
    await seedManaged()
    managedHelper.mockImplementation(async () => {
      expect(await redis.json.get(KEY)).toMatchObject({ managedProfile: reference })
      return { success: true, retainedFiles: true }
    })
    await deleteLocalAiServer(USER, 'koboldcpp')
    expect(managedHelper).toHaveBeenCalledWith('revoke-owner', { userId: USER, requireState: true })
    expect(await redis.json.get(KEY)).toBeNull()
  })
  it('a failed revoke retains the complete connection and reference', async () => {
    await seedManaged()
    managedHelper.mockRejectedValue(new Error('grant directory unreadable'))
    await expect(deleteLocalAiServer(USER, 'koboldcpp')).rejects.toThrow('grant directory unreadable')
    expect(await redis.json.get(KEY)).toMatchObject({ managedProfile: reference })
  })
})
