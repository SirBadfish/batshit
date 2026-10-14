/**
 * BL-1397 / BL-1398 / BL-1399: the n8n Instance MCP token's two owners, the saved key
 * `api_keys:{u}:n8n_instance_mcp_token` (canonical) and a legacy `metadata.authToken` copy in an
 * n8n Instance gateway. Default lane: the shared fake store, the REAL `apiKeyService` (so the
 * saved key is an actual encrypted record and the tests read its decrypted value), the real
 * migration, routes and guarded steps (`n8nInstanceCredential.ts`); only the CLI profile syncs and
 * tool discovery are stand-ins. Every token is synthetic; no test token may reach a log or a
 * browser response.
 *
 * Cases titled "changes:" were red on the base `b97ea9876` (the old migration and routes).
 */
import { inspect } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const profileSync = vi.hoisted(() => ({
  codex: vi.fn(async () => undefined),
  claude: vi.fn(async () => ({}))
}))
vi.mock('$lib/server/services/codexProfileManager', () => ({ syncAgentCodexProfiles: profileSync.codex }))
vi.mock('$lib/server/services/claudeProfileManager', () => ({ syncAgentClaudeProfiles: profileSync.claude }))
vi.mock('$lib/server/services/workflowDiscovery', () => ({
  workflowDiscovery: { discoverDirectMCPClients: vi.fn(async () => []) }
}))
vi.mock('$lib/server/services/mcpGatewayDiscovery', () => ({
  mcpGatewayDiscovery: { refreshGateway: vi.fn(async () => ({ success: true, tools: [] })) }
}))

import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import { apiKeyService } from '$lib/services/apiKey.server'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { migrateLegacyN8nInstanceMcpTokens } from '$lib/server/services/mcpGatewayTokenMigration'
import { GET as listRoute, POST as createRoute } from '../../../../routes/api/mcp/gateways/+server'
import { GET as getRoute, PUT as putRoute } from '../../../../routes/api/mcp/gateways/[id]/+server'
import { POST as refreshRoute } from '../../../../routes/api/mcp/gateways/[id]/refresh/+server'
import { DELETE as deleteKeyRoute } from '../../../../routes/api/settings/api-keys/+server'

const USER = 'bl1397_user'
const SERVICE = 'n8n_instance_mcp_token'
const KEY = `api_keys:${USER}:${SERVICE}`
const REGISTRY = `mcp_gateways:${USER}`
const L = 'legacy-token-L1'
const K = 'saved-token-K1'
const K2 = 'saved-token-K2'
const F = 'fresh-token-F1'
const INVALID = 'bad token'
const TOKENS = [L, K, K2, F, INVALID]

const json = redis.json as unknown as Record<string, any>
const originals = new Map<string, (...args: any[]) => any>()
for (const name of ['getRaw', 'setIfUnchanged', 'moveLegacyN8nToken', 'deleteN8nToken']) {
  const implementation = json[name]?.getMockImplementation?.()
  if (implementation) originals.set(name, implementation)
}

let savedEncryptionKey: string | undefined
beforeAll(() => {
  savedEncryptionKey = env.ENCRYPTION_KEY
  env.ENCRYPTION_KEY = 'test-7-synthetic-encryption-key-0123456789abcdef'
})
afterAll(() => {
  if (savedEncryptionKey === undefined) delete env.ENCRYPTION_KEY
  else env.ENCRYPTION_KEY = savedEncryptionKey
})

function n8nInstance(id: string, metadata: Record<string, unknown>) {
  return {
    id,
    name: `n8n ${id}`,
    type: 'n8n-instance-mcp' as const,
    url: 'http://localhost:5678/mcp-server/http',
    enabled: true,
    created_at: '2026-10-11T00:00:00.000Z',
    metadata
  }
}

async function seed(gateways: Array<Record<string, unknown>>) {
  for (const gateway of gateways) await mcpGatewayService.create(USER, gateway as any)
}

async function storedMeta(id: string): Promise<Record<string, unknown>> {
  const registry = (await redis.json.get(REGISTRY)) as { gateways: any[] }
  return registry.gateways.find((gateway) => gateway.id === id).metadata
}

const savedValue = () => apiKeyService.retrieve(SERVICE, USER)
const savedRaw = () => redis.json.getRaw(KEY, '$')

async function saveUnreadableKey() {
  await redis.json.set(KEY, '$', { encrypted: 'zz', iv: '00', authTag: '00', updatedAt: 'x' })
}

const routeEvent = (id: string, body?: unknown) => ({
  request: new Request(`http://localhost/api/mcp/gateways/${id}`, {
    method: body === undefined ? 'GET' : 'PUT',
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }),
  locals: { user: { id: USER } },
  params: { id },
  url: new URL(`http://localhost/api/mcp/gateways/${id}`)
})

const put = (id: string, body: Record<string, unknown>) => putRoute(routeEvent(id, body) as any) as Promise<Response>
const deleteKey = () =>
  deleteKeyRoute({
    request: new Request('http://localhost/api/settings/api-keys', { method: 'DELETE', body: JSON.stringify({ service: SERVICE }) }),
    locals: { user: { id: USER } }
  } as any) as Promise<Response>

async function migrate() {
  const gateways = await mcpGatewayService.list(USER)
  await migrateLegacyN8nInstanceMcpTokens({ userId: USER, gateways, logPrefix: 'test' })
  return gateways
}

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = []
function printedText(): string {
  return consoleSpies
    .flatMap((spy) => spy.mock.calls.flat())
    .map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 6 })))
    .join('\n')
}
function expectNoTokenPrinted() {
  const printed = printedText()
  for (const token of TOKENS) expect(printed).not.toContain(token)
}

describe.runIf(process.env.VITEST_USE_REAL_REDIS !== 'true')('BL-1397: n8n Instance token, canonical key wins', () => {
  beforeEach(() => {
    ;(redis as any).__resetTestStore()
    vi.clearAllMocks()
    for (const [name, implementation] of originals) json[name].mockImplementation(implementation)
    consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {})
    )
  })
  afterEach(() => {
    expectNoTokenPrinted()
    for (const spy of consoleSpies) spy.mockRestore()
    for (const [name, implementation] of originals) json[name].mockImplementation(implementation)
    profileSync.codex.mockReset().mockImplementation(async () => undefined)
    profileSync.claude.mockReset().mockImplementation(async () => ({}))
  })

  // --- the migration: move / retire / supersede / keep ---

  it('a copy with no saved key moves into it and leaves the gateway', async () => {
    await seed([n8nInstance('gw-n', { authToken: ` ${L} `, base: 'x' })])

    const listCopy = await migrate()

    expect(await savedValue()).toBe(L)
    expect(await storedMeta('gw-n')).toEqual({ base: 'x' })
    expect(listCopy[0].metadata).toEqual({ base: 'x' })
  })

  it('with distinct valid copies and no key, the first successful move wins and the later copy is superseded', async () => {
    await seed([
      n8nInstance('gw-first', { authToken: L, base: 'first' }),
      n8nInstance('gw-later', { authToken: F, base: 'later' })
    ])

    const listCopy = await migrate()

    // Read the real encrypted saved record through apiKeyService, not a mocked store answer.
    expect(await savedValue()).toBe(L)
    expect(await storedMeta('gw-first')).toEqual({ base: 'first' })
    expect(await storedMeta('gw-later')).toEqual({ base: 'later' })
    expect(listCopy.map((gateway) => gateway.metadata)).toEqual([{ base: 'first' }, { base: 'later' }])
    // Only the first step supplies a new encrypted key; the different later copy is retired.
    expect(json.moveLegacyN8nToken.mock.calls.map((call: unknown[]) => call[5] !== null)).toEqual([true, false])
  })

  it('a copy equal to the saved key leaves the gateway; the key is untouched', async () => {
    await apiKeyService.store(SERVICE, L, USER)
    const before = await savedRaw()
    await seed([n8nInstance('gw-n', { authToken: L })])

    await migrate()

    expect(await savedRaw()).toBe(before)
    expect(await storedMeta('gw-n')).toEqual({})
  })

  it('changes: a different readable saved key wins; the copy leaves as superseded', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    const before = await savedRaw()
    await seed([n8nInstance('gw-n', { authToken: L, base: 'x' })])

    await migrate()

    expect(await savedRaw()).toBe(before)
    expect(await savedValue()).toBe(K)
    expect(await storedMeta('gw-n')).toEqual({ base: 'x' })
  })

  it('changes: an unreadable saved key is present: nothing written, the copy stays for recovery', async () => {
    await saveUnreadableKey()
    const before = await savedRaw()
    await seed([n8nInstance('gw-n', { authToken: L })])

    await migrate()

    expect(await savedRaw()).toBe(before)
    expect(await storedMeta('gw-n')).toEqual({ authToken: L })
    expect(printedText()).toContain('cannot be read')
  })

  it('an invalid copy with no saved key is kept and nothing is written', async () => {
    await seed([n8nInstance('gw-n', { authToken: INVALID })])

    await migrate()

    expect(await savedRaw()).toBeNull()
    expect(await storedMeta('gw-n')).toEqual({ authToken: INVALID })
  })

  // --- the gateway PUT ---

  it('changes: an unrelated edit of a gateway with an invalid copy is saved (no synchronous validation)', async () => {
    await seed([n8nInstance('gw-n', { authToken: INVALID })])

    const response = await put('gw-n', { name: 'Renamed' })

    expect(response.status).toBe(200)
    const registry = (await redis.json.get(REGISTRY)) as { gateways: any[] }
    expect(registry.gateways[0].name).toBe('Renamed')
    expect(registry.gateways[0].metadata).toEqual({ authToken: INVALID })
    expect(await savedRaw()).toBeNull()
  })

  it('changes: an unrelated edit never lets a copy replace a saved key; the copy leaves as superseded', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    const before = await savedRaw()
    await seed([n8nInstance('gw-n', { authToken: L })])

    const response = await put('gw-n', { enabled: false })

    expect(response.status).toBe(200)
    expect(await savedRaw()).toBe(before)
    expect(await storedMeta('gw-n')).toEqual({})
  })

  it('with both CLI profile syncs doing nothing (providers off), an edit still moves the copy', async () => {
    await seed([n8nInstance('gw-n', { authToken: L })])

    const response = await put('gw-n', { name: 'Renamed' })

    expect(response.status).toBe(200)
    expect(profileSync.codex).toHaveBeenCalledTimes(1)
    expect(await savedValue()).toBe(L)
    expect(await storedMeta('gw-n')).toEqual({})
  })

  it('a token sent in the body is an explicit replacement of the saved key and retires the copy', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    await seed([n8nInstance('gw-n', { authToken: L })])

    const response = await put('gw-n', { metadata: { authToken: F } })

    expect(response.status).toBe(200)
    expect(await savedValue()).toBe(F)
    expect(await storedMeta('gw-n')).toEqual({})
  })

  it('changes: a blank body token keeps the copy for the guarded move (no loss)', async () => {
    await seed([n8nInstance('gw-n', { authToken: L })])

    const response = await put('gw-n', { metadata: { authToken: '' } })

    expect(response.status).toBe(200)
    expect(await savedValue()).toBe(L)
    expect(await storedMeta('gw-n')).toEqual({})
  })

  // --- the explicit delete ---

  it.each(['key', 'registry'] as const)('a wrong-type %s makes DELETE fail without changing either owner or syncing profiles', async (owner) => {
    await apiKeyService.store(SERVICE, K, USER)
    await seed([n8nInstance('gw-n', { authToken: L, base: 'retained' })])
    await redis.set(owner === 'key' ? KEY : REGISTRY, 'synthetic-corrupt-store')
    const before = {
      key: structuredClone(await redis.get(KEY)),
      registry: structuredClone(await redis.get(REGISTRY))
    }
    const bareDelete = vi.spyOn(apiKeyService, 'delete')
    try {
      const response = await deleteKey()

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ success: false, error: 'Failed to delete API key' })
      expect(await redis.get(KEY)).toEqual(before.key)
      expect(await redis.get(REGISTRY)).toEqual(before.registry)
      expect(json.deleteN8nToken).not.toHaveBeenCalled()
      expect(bareDelete).not.toHaveBeenCalled()
      expect(profileSync.codex).not.toHaveBeenCalled()
      expect(profileSync.claude).not.toHaveBeenCalled()
    } finally {
      bareDelete.mockRestore()
    }
  })

  it('changes: the API Keys delete removes the saved key and every copy; the next sync cannot bring one back', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    await seed([
      n8nInstance('gw-a', { authToken: L, base: 'a' }),
      { id: 'gw-c', name: 'Custom', type: 'custom', url: 'https://c.example.test/mcp', enabled: true, metadata: { authToken: 'other' } },
      n8nInstance('gw-b', { authToken: K })
    ])

    const response = await deleteKey()

    expect(response.status).toBe(200)
    expect(await savedRaw()).toBeNull()
    expect(await storedMeta('gw-a')).toEqual({ base: 'a' })
    expect(await storedMeta('gw-b')).toEqual({})
    // Only n8n Instance copies are this credential.
    expect(await storedMeta('gw-c')).toEqual({ authToken: 'other' })
    await migrate()
    expect(await savedRaw()).toBeNull()
  })

  it('a token saved after the delete read the key is never deleted: 409, nothing deleted', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    await seed([n8nInstance('gw-n', { authToken: L })])
    let saved = false
    json.getRaw.mockImplementation(async (key: string, path: string) => {
      const answer = await originals.get('getRaw')!(key, path)
      if (key === KEY && !saved) {
        saved = true
        await apiKeyService.store(SERVICE, K2, USER)
      }
      return answer
    })

    const response = await deleteKey()

    expect(response.status).toBe(409)
    expect(await savedValue()).toBe(K2)
    expect(await storedMeta('gw-n')).toEqual({ authToken: L })
  })

  it('a registry that keeps changing refuses the delete three times: 409, nothing deleted', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    await seed([n8nInstance('gw-n', { authToken: L, n: 0 })])
    json.deleteN8nToken.mockImplementation(async (...args: any[]) => {
      const registry = (await redis.json.get(REGISTRY)) as { gateways: any[] }
      registry.gateways[0].metadata.n += 1
      await redis.json.set(REGISTRY, '$', registry)
      return originals.get('deleteN8nToken')!(...args)
    })

    const response = await deleteKey()

    expect(response.status).toBe(409)
    expect(json.deleteN8nToken).toHaveBeenCalledTimes(3)
    expect(await savedValue()).toBe(K)
    expect(await storedMeta('gw-n')).toEqual({ authToken: L, n: 3 })
  })

  it('a copy added after the delete read the registry refuses that try; the retry removes it too', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    await seed([n8nInstance('gw-a', { authToken: L })])
    let added = false
    json.deleteN8nToken.mockImplementation(async (...args: any[]) => {
      if (!added) {
        added = true
        await mcpGatewayService.create(USER, n8nInstance('gw-new', { authToken: L }) as any)
      }
      return originals.get('deleteN8nToken')!(...args)
    })

    const response = await deleteKey()

    expect(response.status).toBe(200)
    expect(json.deleteN8nToken).toHaveBeenCalledTimes(2)
    expect(await storedMeta('gw-a')).toEqual({})
    expect(await storedMeta('gw-new')).toEqual({})
    expect(await savedRaw()).toBeNull()
  })

  it('absent-key ABA for the delete: a save and another delete between its read and its write lose nothing', async () => {
    await seed([n8nInstance('gw-n', { authToken: L, base: 'x' })])
    let raced = false
    json.deleteN8nToken.mockImplementation(async (...args: any[]) => {
      if (!raced) {
        raced = true
        // This delete pinned an ABSENT key. Meanwhile a save and a whole other delete land.
        await apiKeyService.store(SERVICE, K, USER)
        expect((await deleteKey()).status).toBe(200)
      }
      return originals.get('deleteN8nToken')!(...args)
    })

    const response = await deleteKey()

    expect(response.status).toBe(200)
    // The key is absent again (as pinned) but the registry changed, so the first try was refused
    // and the retry deleted only what was still there: nothing anyone kept is lost.
    expect(json.deleteN8nToken).toHaveBeenCalledTimes(3)
    expect(await savedRaw()).toBeNull()
    expect(await storedMeta('gw-n')).toEqual({ base: 'x' })
  })

  it('a profile sync failure after a completed delete still answers deleted', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    profileSync.codex.mockRejectedValueOnce(new Error('sync down'))

    const response = await deleteKey()

    expect(response.status).toBe(200)
    expect(await savedRaw()).toBeNull()
  })

  it('a delete that stops part way says the token was not deleted (never "nothing deleted")', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    await seed([n8nInstance('gw-n', { authToken: L })])
    json.deleteN8nToken.mockImplementation(async () => ({ kind: 'partial', copiesCleared: 1 }))

    const response = await deleteKey()

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error).toMatch(/was not deleted/)
    expect(body.error).toMatch(/may already be removed/)
    expect(await savedValue()).toBe(K)
  })

  // --- races of the migration ---

  it('a save and a delete between the move read and its write (absent-key ABA) cannot bring the token back', async () => {
    await seed([n8nInstance('gw-n', { authToken: L })])
    let raced = false
    json.moveLegacyN8nToken.mockImplementation(async (...args: any[]) => {
      if (!raced) {
        raced = true
        await apiKeyService.store(SERVICE, K, USER)
        expect((await deleteKey()).status).toBe(200)
      }
      return originals.get('moveLegacyN8nToken')!(...args)
    })

    await migrate()

    expect(raced).toBe(true)
    expect(await savedRaw()).toBeNull()
    expect(await storedMeta('gw-n')).toEqual({})
  })

  it('a save between the move read and its write wins; the copy then leaves as superseded', async () => {
    await seed([n8nInstance('gw-n', { authToken: L })])
    let raced = false
    json.moveLegacyN8nToken.mockImplementation(async (...args: any[]) => {
      if (!raced) {
        raced = true
        await apiKeyService.store(SERVICE, K, USER)
      }
      return originals.get('moveLegacyN8nToken')!(...args)
    })

    await migrate()

    expect(json.moveLegacyN8nToken).toHaveBeenCalledTimes(2)
    expect(await savedValue()).toBe(K)
    expect(await storedMeta('gw-n')).toEqual({})
  })

  it('a move that wrote the key but not the copy is reported, not taken for success', async () => {
    await seed([n8nInstance('gw-n', { authToken: L })])
    json.moveLegacyN8nToken.mockImplementation(async () => ({ kind: 'partial_key_written' }))

    const listCopy = await migrate()

    expect(printedText()).toContain('could not be removed')
    expect(listCopy[0].metadata).toEqual({ authToken: L })
  })

  // --- BL-1398: browser responses redact a copy ---

  it('every gateway response leaves out metadata.authToken; the stored record and the service keep it', async () => {
    await saveUnreadableKey() // so the PUT's move keeps the copy in place
    await seed([n8nInstance('gw-n', { authToken: L, base: 'x' })])

    const responses = [
      await listRoute({ locals: { user: { id: USER } }, url: new URL('http://localhost/api/mcp/gateways') } as any),
      await getRoute(routeEvent('gw-n') as any),
      await put('gw-n', { name: 'Renamed' }),
      await refreshRoute(routeEvent('gw-n', {}) as any),
      await createRoute({
        request: new Request('http://localhost/api/mcp/gateways', {
          method: 'POST',
          body: JSON.stringify({ name: 'Custom', type: 'custom', url: 'https://c.example.test/mcp', metadata: { authToken: F } })
        }),
        locals: { user: { id: USER } }
      } as any)
    ]

    for (const response of responses) {
      expect(response.status).toBeLessThan(300)
      const text = await response.text()
      expect(text).not.toContain(L)
      expect(text).not.toContain(F)
      expect(text).not.toContain('authToken')
    }
    expect(await storedMeta('gw-n')).toEqual({ authToken: L, base: 'x' })
    const listed = await mcpGatewayService.list(USER)
    expect(listed.find((gateway) => gateway.id === 'gw-n')?.metadata?.authToken).toBe(L)
  })

  // --- BL-1407: a token sent in a gateway save is stored only after the gateway is ---

  const TOKEN_NOT_CONFIRMED =
    'The gateway settings were saved, but Batshit could not confirm saving the n8n Instance MCP token. Save the token again, or save it in Settings → API Keys.'
  const N8N_URL = 'http://localhost:5678/mcp-server/http'

  const post = (body: Record<string, unknown>) =>
    createRoute({
      request: new Request('http://localhost/api/mcp/gateways', { method: 'POST', body: JSON.stringify(body) }),
      locals: { user: { id: USER } }
    } as any) as Promise<Response>

  async function storedGateway(id: string) {
    const registry = (await redis.json.get(REGISTRY)) as { gateways: any[] }
    return registry.gateways.find((gateway) => gateway.id === id) ?? null
  }

  /** `apiKeyService.store` that writes the key, then throws as if its answer was lost. */
  function storeThatWritesThenFails() {
    const write = apiKeyService.store.bind(apiKeyService)
    return vi.spyOn(apiKeyService, 'store').mockImplementationOnce(async (...args: Parameters<typeof write>) => {
      await write(...args)
      throw new Error('reply lost after the write')
    })
  }

  it('changes: a refused gateway save (409) stores no token; the saved key is byte-identical', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    await seed([n8nInstance('gw-n', { authToken: L, base: 'x' })])
    const before = await savedRaw()
    json.setIfUnchanged.mockClear().mockImplementation(async () => false)

    const response = await put('gw-n', { name: 'Renamed', metadata: { authToken: F } })

    expect(response.status).toBe(409)
    // All three refused writes were `update`'s tries at the element, never a normalizing write at `$`.
    expect(json.setIfUnchanged.mock.calls.map((call: any[]) => call[1])).toEqual(Array(3).fill('$.gateways[0]'))
    expect(await savedRaw()).toBe(before)
    expect(await storedMeta('gw-n')).toEqual({ authToken: L, base: 'x' })
    expect(profileSync.codex).not.toHaveBeenCalled()
  })

  it('changes: a save of a gateway deleted after the route read it (404) stores no token', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    await seed([n8nInstance('gw-n', {})])
    const before = await savedRaw()
    const read = mcpGatewayService.get.bind(mcpGatewayService)
    const earlierRead = vi.spyOn(mcpGatewayService, 'get').mockImplementationOnce(async (userId, id) => {
      const gateway = await read(userId, id)
      await redis.json.set(REGISTRY, '$', { gateways: [] })
      return gateway
    })
    try {
      const response = await put('gw-n', { metadata: { authToken: F } })

      expect(response.status).toBe(404)
      expect(await savedRaw()).toBe(before)
    } finally {
      earlierRead.mockRestore()
    }
  })

  it('changes: a save whose gateway fields fail validation (400) stores no token', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    await seed([n8nInstance('gw-n', {})])
    const before = await savedRaw()

    const response = await put('gw-n', { url: 'not a url', metadata: { authToken: F } })

    expect(response.status).toBe(400)
    expect(await savedRaw()).toBe(before)
  })

  it('a token that fails the key checks is refused (400) before anything is written', async () => {
    await seed([n8nInstance('gw-n', { base: 'x' })])
    const registryBefore = await redis.json.getRaw(REGISTRY, '$')

    const response = await put('gw-n', { name: 'Renamed', metadata: { authToken: INVALID } })

    expect(response.status).toBe(400)
    expect(await savedRaw()).toBeNull()
    expect(await redis.json.getRaw(REGISTRY, '$')).toBe(registryBefore)
  })

  it('changes: a gateway write with no answer (500 before it is confirmed) runs no side effect', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    await seed([n8nInstance('gw-n', { authToken: L })])
    const before = await savedRaw()
    json.setIfUnchanged.mockRejectedValueOnce(new Error('socket closed before the answer'))

    const response = await put('gw-n', { metadata: { authToken: F } })

    expect(response.status).toBe(500)
    expect((await response.json()).error).toBe('Failed to update gateway')
    expect(await savedRaw()).toBe(before)
    expect(json.moveLegacyN8nToken).not.toHaveBeenCalled()
    expect(profileSync.codex).not.toHaveBeenCalled()
  })

  it('changes: a token store that fails before writing answers the 500 that says the gateway was saved; the next save stores it', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    await seed([n8nInstance('gw-n', { authToken: L, base: 'x' })])
    const before = await savedRaw()
    const store = vi.spyOn(apiKeyService, 'store').mockRejectedValueOnce(new Error('connection reset'))
    try {
      const response = await put('gw-n', { name: 'Renamed', metadata: { authToken: F } })

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: TOKEN_NOT_CONFIRMED, gatewaySaved: true, gatewayId: 'gw-n' })
      expect((await storedGateway('gw-n')).name).toBe('Renamed')
      // Not retried, not undone. The readable saved key wins by the move's own rule: the copy leaves.
      expect(store).toHaveBeenCalledTimes(1)
      expect(await savedRaw()).toBe(before)
      expect(await storedMeta('gw-n')).toEqual({ base: 'x' })
      expect(profileSync.codex).toHaveBeenCalledTimes(1)
      expect(printedText()).toContain('connection reset')

      // The repair is the user's next save, never a retry by the route.
      const again = await put('gw-n', { metadata: { authToken: F } })

      expect(again.status).toBe(200)
      expect(store).toHaveBeenCalledTimes(2)
      expect(await savedValue()).toBe(F)
    } finally {
      store.mockRestore()
    }
  })

  it('changes: a token store that wrote and then failed is not undone; the 500 says it could not be confirmed', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    await seed([n8nInstance('gw-n', { authToken: L })])
    const store = storeThatWritesThenFails()
    try {
      const response = await put('gw-n', { metadata: { authToken: F } })

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: TOKEN_NOT_CONFIRMED, gatewaySaved: true, gatewayId: 'gw-n' })
      expect(store).toHaveBeenCalledTimes(1)
      expect(await savedValue()).toBe(F)
      // The move reads F as the readable saved key: the copy leaves as superseded.
      expect(await storedMeta('gw-n')).toEqual({})
    } finally {
      store.mockRestore()
    }
  })

  it('changes: with no saved key, a failed token store never costs the legacy copy', async () => {
    await seed([n8nInstance('gw-n', { authToken: L })])
    const store = vi.spyOn(apiKeyService, 'store').mockRejectedValueOnce(new Error('connection reset'))
    try {
      const response = await put('gw-n', { metadata: { authToken: F } })

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: TOKEN_NOT_CONFIRMED, gatewaySaved: true, gatewayId: 'gw-n' })
      // The gateway write kept the copy; the guarded move then took it into the absent key.
      expect(await savedValue()).toBe(L)
      expect(await storedMeta('gw-n')).toEqual({})
    } finally {
      store.mockRestore()
    }
  })

  it('changes: after the gateway write is stored, an error that says "not found" or "Invalid" is a 500 that says it was saved', async () => {
    await seed([n8nInstance('gw-n', {})])
    profileSync.codex.mockRejectedValueOnce(new Error('Agent profile not found'))
    const first = await put('gw-n', { name: 'One' })
    profileSync.claude.mockRejectedValueOnce(new Error('Invalid managed profile'))
    const second = await put('gw-n', { name: 'Two' })

    for (const response of [first, second]) {
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: expect.stringMatching(/^The gateway settings were saved, but /), gatewaySaved: true, gatewayId: 'gw-n' })
    }
    expect((await storedGateway('gw-n')).name).toBe('Two')
  })

  it('a token store failure and a later failure after the save are both named', async () => {
    await seed([n8nInstance('gw-n', {})])
    const store = vi.spyOn(apiKeyService, 'store').mockRejectedValueOnce(new Error('connection reset'))
    profileSync.codex.mockRejectedValueOnce(new Error('sync down'))
    try {
      const response = await put('gw-n', { metadata: { authToken: F } })

      expect(response.status).toBe(500)
      const { error } = await response.json()
      expect(error.startsWith(TOKEN_NOT_CONFIRMED)).toBe(true)
      expect(error.length).toBeGreaterThan(TOKEN_NOT_CONFIRMED.length)
    } finally {
      store.mockRestore()
    }
  })

  it('changes: POST stores the token only after the gateway is created', async () => {
    await apiKeyService.store(SERVICE, K, USER)
    await seed([n8nInstance('gw-n', {})])
    const before = await savedRaw()

    const refused = await post({ id: 'gw-n', name: 'Again', type: 'n8n-instance-mcp', url: N8N_URL, metadata: { authToken: F } })

    expect(refused.status).toBe(400)
    expect(await savedRaw()).toBe(before)

    const invalid = await post({ id: 'gw-i', name: 'Bad', type: 'n8n-instance-mcp', url: N8N_URL, metadata: { authToken: INVALID } })

    expect(invalid.status).toBe(400)
    expect(await storedGateway('gw-i')).toBeNull()
    expect(await savedRaw()).toBe(before)

    const created = await post({ id: 'gw-2', name: 'Second', type: 'n8n-instance-mcp', url: N8N_URL, metadata: { authToken: F } })

    expect(created.status).toBe(201)
    expect(await savedValue()).toBe(F)
    expect(await storedMeta('gw-2')).toEqual({})
  })

  it('changes: a POST whose token store fails (before or after writing) answers the 500 that says it was saved', async () => {
    const before = vi.spyOn(apiKeyService, 'store').mockRejectedValueOnce(new Error('connection reset'))
    let response: Response
    try {
      response = await post({ id: 'gw-3', name: 'Third', type: 'n8n-instance-mcp', url: N8N_URL, metadata: { authToken: F } })
    } finally {
      before.mockRestore()
    }
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: TOKEN_NOT_CONFIRMED, gatewaySaved: true, gatewayId: 'gw-3' })
    expect(await storedGateway('gw-3')).not.toBeNull()
    expect(await savedRaw()).toBeNull()

    const after = storeThatWritesThenFails()
    try {
      response = await post({ id: 'gw-4', name: 'Fourth', type: 'n8n-instance-mcp', url: N8N_URL, metadata: { authToken: F } })
    } finally {
      after.mockRestore()
    }
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: TOKEN_NOT_CONFIRMED, gatewaySaved: true, gatewayId: 'gw-4' })
    expect(await storedGateway('gw-4')).not.toBeNull()
    expect(await savedValue()).toBe(F)
  })

  it('changes: after POST created the gateway, an error that says "Invalid" is a 500 that says it was saved', async () => {
    profileSync.codex.mockRejectedValueOnce(new Error('Invalid managed profile'))

    const response = await post({ id: 'gw-5', name: 'Fifth', type: 'n8n-instance-mcp', url: N8N_URL })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: expect.stringMatching(/^The gateway settings were saved, but /), gatewaySaved: true, gatewayId: 'gw-5' })
    expect(await storedGateway('gw-5')).not.toBeNull()
  })
})
