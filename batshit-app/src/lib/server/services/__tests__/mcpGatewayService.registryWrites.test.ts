/**
 * BL-1371: every write to the gateway registry (`mcp_gateways:{userId}`) used to read the whole
 * registry and write it whole again, so a write that landed in between was lost with no error.
 * Each case below puts one competing write exactly between a writer's read and its write (the
 * `beforeRegistryWrites` hook runs it just before the writer's write reaches the store) and
 * checks that both writes are stored.
 *
 * The fix is a compare-and-set (CAS) on the raw RedisJSON text: `update` and `delete` compare one
 * gateway (`$.gateways[i]`), `create` and the normalizing write of `list` compare the whole
 * registry (`$`). A refused try reads again and rebuilds from fresh objects, at most three tries,
 * then `GatewayRegistryConflictError` (409 in the gateway route). Only a write that was stored
 * drives what comes after it (saved tool lists, the reference sweep, the response).
 *
 * Default lane only: the shared fake from `vitest-setup.ts`. The real-Redis twin, with the real
 * Lua check landing between the snapshot and the CAS, is `mcpGatewayService.registryWrites.redis.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const profileSync = vi.hoisted(() => ({
  codex: vi.fn(async () => undefined),
  claude: vi.fn(async () => ({}))
}))
vi.mock('$lib/server/services/codexProfileManager', () => ({ syncAgentCodexProfiles: profileSync.codex }))
vi.mock('$lib/server/services/claudeProfileManager', () => ({ syncAgentClaudeProfiles: profileSync.claude }))
vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    // BL-1407: the explicit store writes the same { moved } record the guarded move reads below.
    store: vi.fn(async (service: string, token: string, userId: string) => {
      const { redis } = await import('$lib/server/redis')
      await redis.json.set(`api_keys:${userId}:${service}`, '$', { moved: token.trim() })
    }),
    retrieve: vi.fn(async () => null),
    // BL-1397: the guarded move's helpers over the shared fake; the saved key is a { moved } record.
    storedKeyName: (service: string, userId: string) => `api_keys:${userId}:${service}`,
    readStoredState: vi.fn(async (service: string, userId: string) => {
      const { redis } = await import('$lib/server/redis')
      const raw = await redis.json.getRaw(`api_keys:${userId}:${service}`, '$')
      return raw === null ? { raw: '', state: 'absent' } : { raw, state: 'readable', value: JSON.parse(raw)[0].moved }
    }),
    buildStoredDocument: vi.fn((_service: string, token: string) => ({ moved: token.trim() }))
  }
}))
vi.mock('$lib/server/services/dockerGatewayProfileConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/dockerGatewayProfileConfig')>()),
  // The real one writes the Docker profile into an env file on disk.
  writeDockerMcpProfileEnv: vi.fn(async () => undefined)
}))
vi.mock('$lib/server/services/mcpGatewayReferenceCleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/mcpGatewayReferenceCleanup')>()),
  sweepGatewayReferencesForUser: vi.fn(async () => ({
    scanned: 0,
    updatedRecordKeys: [],
    removedGatewayIds: [],
    removedDcmKeys: [],
    removedToolNames: []
  }))
}))

import { redis } from '$lib/server/redis'
import { GatewayRegistryConflictError, mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { mcpToolListCache } from '$lib/server/services/mcpToolListCache'
import { sweepGatewayReferencesForUser } from '$lib/server/services/mcpGatewayReferenceCleanup'
import { writeDockerMcpProfileEnv } from '$lib/server/services/dockerGatewayProfileConfig'
import { migrateLegacyN8nInstanceMcpTokens } from '$lib/server/services/mcpGatewayTokenMigration'
import { apiKeyService } from '$lib/services/apiKey.server'
import { DELETE as deleteRoute, PUT as putRoute } from '../../../../routes/api/mcp/gateways/[id]/+server'

const USER = 'bl1371_user'
const KEY = `mcp_gateways:${USER}`
const CONFLICT = { name: 'GatewayRegistryConflictError' }

const json = redis.json as unknown as Record<string, any>

function custom(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    type: 'custom' as const,
    url: `https://${id}.example.test/mcp`,
    enabled: true,
    created_at: '2026-10-11T00:00:00.000Z',
    ...extra
  }
}

function stdio(id: string, name: string) {
  return {
    id,
    name,
    type: 'stdio' as const,
    enabled: true,
    created_at: '2026-10-11T00:00:00.000Z',
    stdioConfig: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      cwdPolicy: 'none' as const
    }
  }
}

function docker(id: string) {
  return {
    id,
    name: 'Docker MCP',
    type: 'docker-catalog' as const,
    url: 'http://localhost:8811/mcp',
    enabled: true,
    created_at: '2026-10-11T00:00:00.000Z',
    discoveredTools: ['read_file', 'search'],
    lastDiscovery: 1_700_000_000_000,
    metadata: { dockerProfile: 'default', note: 'kept' }
  }
}

async function storedRegistry(): Promise<{ gateways: any[] }> {
  return (await redis.json.get(KEY)) as { gateways: any[] }
}

async function stored(id: string): Promise<any> {
  return (await storedRegistry())?.gateways.find((gateway) => gateway.id === id) ?? null
}

function n8nInstance(id: string, metadata: Record<string, unknown>) {
  return {
    id,
    name: 'n8n MCP',
    type: 'n8n-instance-mcp' as const,
    url: 'http://localhost:5678/mcp-server/http',
    enabled: true,
    created_at: '2026-10-11T00:00:00.000Z',
    metadata
  }
}

/** Another writer changes only some metadata keys of a gateway, in one step. */
async function metadataWrittenElsewhere(id: string, fields: Record<string, unknown>) {
  const registry = await storedRegistry()
  Object.assign(registry.gateways.find((gateway) => gateway.id === id).metadata, fields)
  await redis.json.set(KEY, '$', registry)
}

/** What a Refresh or Test writes: only the check fields, in one step (the Lua's stand-in here). */
async function checkWritesResult(id: string, fields: Record<string, unknown>) {
  const registry = await storedRegistry()
  Object.assign(registry.gateways.find((gateway) => gateway.id === id).stdioConfig, fields)
  await redis.json.set(KEY, '$', registry)
}

const WRITE_METHODS = ['set', 'setIfUnchanged', 'delIfUnchanged'] as const
const READ_METHODS = ['get', 'getRaw'] as const
const originals = new Map<string, (...args: any[]) => any>()
for (const name of [...WRITE_METHODS, ...READ_METHODS]) {
  const implementation = json[name]?.getMockImplementation?.()
  if (implementation) originals.set(name, implementation)
}

function restoreFake() {
  for (const [name, implementation] of originals) json[name].mockImplementation(implementation)
}

/**
 * Runs `competitor(n)` just before each of the next `times` writes of the registry by anyone
 * else. Writes made inside a competitor pass straight through, so the competitor's own writes
 * land whole between the writer's read and its write.
 */
function beforeRegistryWrites(times: number, competitor: (n: number) => Promise<unknown>) {
  return interleave(WRITE_METHODS, () => true, times, competitor)
}

/** The same for reads; `pathMatches` picks which registry reads count. */
function beforeRegistryReads(
  pathMatches: (path: string | undefined) => boolean,
  times: number,
  competitor: (n: number) => Promise<unknown>
) {
  return interleave(READ_METHODS, pathMatches, times, competitor)
}

function interleave(
  methods: readonly string[],
  pathMatches: (path: string | undefined) => boolean,
  times: number,
  competitor: (n: number) => Promise<unknown>
) {
  let remaining = times
  let fired = 0
  let insideCompetitor = false
  for (const name of methods) {
    const original = originals.get(name)
    if (!original) continue
    json[name].mockImplementation(async (key: string, ...rest: any[]) => {
      const path = typeof rest[0] === 'string' ? rest[0] : rest[0]?.path
      if (key === KEY && remaining > 0 && !insideCompetitor && pathMatches(path)) {
        remaining -= 1
        fired += 1
        insideCompetitor = true
        try {
          await competitor(fired)
        } finally {
          insideCompetitor = false
        }
      }
      return original(key, ...rest)
    })
  }
  return { fired: () => fired }
}

/** CAS calls of the registry key (fix only; the tip has no CAS). */
function casCalls(name: 'setIfUnchanged' | 'delIfUnchanged') {
  return json[name].mock.calls.filter((call: any[]) => call[0] === KEY).length
}

async function saveToolListCopy(gatewayId: string) {
  await mcpToolListCache.read({ userId: USER, gatewayId, inputs: { probe: true } }, async () => ({
    ok: true,
    tools: []
  }))
}

async function toolListCopyKept(gatewayId: string): Promise<boolean> {
  const lookup = vi.fn(async () => ({ ok: true as const, tools: [] }))
  await mcpToolListCache.read({ userId: USER, gatewayId, inputs: { probe: true } }, lookup)
  return lookup.mock.calls.length === 0
}

function put(id: string, body: Record<string, unknown>) {
  return putRoute({
    request: new Request(`http://localhost/api/mcp/gateways/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    }),
    locals: { user: { id: USER } },
    params: { id }
  } as any) as Promise<Response>
}

function del(id: string) {
  return deleteRoute({ locals: { user: { id: USER } }, params: { id } } as any) as Promise<Response>
}

describe.runIf(process.env.VITEST_USE_REAL_REDIS !== 'true')('BL-1371: registry writes keep each other', () => {
  beforeEach(() => {
    ;(redis as any).__resetTestStore()
    restoreFake()
    vi.clearAllMocks()
    mcpToolListCache.clearAll()
  })

  afterEach(() => {
    restoreFake()
  })

  it('R1: a save of one gateway keeps a save of another made in its window, with no retry', async () => {
    await mcpGatewayService.create(USER, custom('gw-a', 'Alpha'))
    await mcpGatewayService.create(USER, custom('gw-b', 'Beta'))
    vi.clearAllMocks()
    beforeRegistryWrites(1, () => mcpGatewayService.update(USER, 'gw-b', { enabled: false }))

    await mcpGatewayService.update(USER, 'gw-a', { name: 'Alpha renamed' })

    expect((await stored('gw-a')).name).toBe('Alpha renamed')
    expect((await stored('gw-b')).enabled).toBe(false)
    // Different gateways never conflict: one compare-and-set each, no retry.
    expect(casCalls('setIfUnchanged')).toBe(2)
  })

  it('R2: six saves of six gateways at once all stay, each with one compare-and-set', async () => {
    const ids = ['gw-1', 'gw-2', 'gw-3', 'gw-4', 'gw-5', 'gw-6']
    for (const id of ids) await mcpGatewayService.create(USER, custom(id, `Gateway ${id}`))
    vi.clearAllMocks()

    // The Tool Grid Reset: one PUT per gateway in `Promise.all`.
    await Promise.all(ids.map((id) => mcpGatewayService.update(USER, id, { name: `Reset ${id}` })))

    const names = (await storedRegistry()).gateways.map((gateway) => gateway.name)
    expect(names).toEqual(ids.map((id) => `Reset ${id}`))
    expect(casCalls('setIfUnchanged')).toBe(6)
  })

  it('R3: a launch save keeps the check result written in its window, after one retry', async () => {
    await mcpGatewayService.create(USER, stdio('gw-s', 'Files'))
    vi.clearAllMocks()
    beforeRegistryWrites(1, () => checkWritesResult('gw-s', { lastTestStatus: 'passed', toolCount: 7 }))

    const saved = await mcpGatewayService.update(USER, 'gw-s', {
      stdioConfig: { ...stdio('gw-s', 'Files').stdioConfig, args: ['-y', 'server', '/Users/example'] }
    })

    const config = (await stored('gw-s')).stdioConfig
    expect(config.args).toEqual(['-y', 'server', '/Users/example'])
    expect(config).toMatchObject({ lastTestStatus: 'passed', toolCount: 7 })
    // The answer is the copy that was stored, check result included.
    expect(saved.stdioConfig).toEqual(config)
    expect(casCalls('setIfUnchanged')).toBe(2)
  })

  it('R4: a groups PUT of a Docker gateway keeps a profile change saved in its window', async () => {
    await mcpGatewayService.create(USER, docker('gw-d'))
    vi.clearAllMocks()
    let settingsStatus = 0
    beforeRegistryWrites(1, async () => {
      settingsStatus = (await put('gw-d', { metadata: { dockerProfile: 'work' } })).status
    })

    const response = await put('gw-d', { toolGroupings: [{ mcpName: 'Files', toolIds: ['read_file'] }] })

    expect(settingsStatus).toBe(200)
    expect(response.status).toBe(200)
    const gateway = await stored('gw-d')
    expect(gateway.metadata).toEqual({ dockerProfile: 'work', note: 'kept' })
    expect(gateway.discoveredTools).toEqual([])
    expect(gateway.lastDiscovery).toBe(0)
    expect(gateway.toolGroupings).toEqual([{ mcpName: 'Files', toolIds: ['read_file'] }])
    expect((await response.json()).gateway.metadata.dockerProfile).toBe('work')
    expect(vi.mocked(writeDockerMcpProfileEnv).mock.calls).toEqual([['work']])
  })

  it('R5: a list that saves a missing slug keeps a rename made in its window and answers what is stored', async () => {
    await redis.json.set(KEY, '$', {
      gateways: [custom('gw-new', 'Fresh Server'), custom('gw-old', 'Old', { slug: 'old' })]
    })
    beforeRegistryWrites(1, () => mcpGatewayService.update(USER, 'gw-old', { name: 'Old renamed' }))

    const listed = await mcpGatewayService.list(USER)

    const registry = await storedRegistry()
    expect(registry.gateways.find((gateway) => gateway.id === 'gw-old').name).toBe('Old renamed')
    expect(registry.gateways.find((gateway) => gateway.id === 'gw-new').slug).toBe('fresh_server')
    expect(listed).toEqual(registry.gateways)
  })

  it('R6a: an update refused three times throws the conflict error and writes and clears nothing', async () => {
    await mcpGatewayService.create(USER, stdio('gw-s', 'Files'))
    await saveToolListCopy('gw-s')
    vi.clearAllMocks()
    const rivals = [
      () => mcpGatewayService.update(USER, 'gw-s', { discoveredTools: ['t1'] }),
      () => mcpGatewayService.update(USER, 'gw-s', { lastDiscovery: 222 }),
      () => checkWritesResult('gw-s', { toolCount: 9 })
    ]
    beforeRegistryWrites(3, (n) => rivals[n - 1]())

    await expect(mcpGatewayService.update(USER, 'gw-s', { name: 'Mine' })).rejects.toMatchObject(CONFLICT)

    const gateway = await stored('gw-s')
    expect(gateway.name).toBe('Files')
    expect(gateway).toMatchObject({ discoveredTools: ['t1'], lastDiscovery: 222 })
    expect(gateway.stdioConfig.toolCount).toBe(9)
    // The rivals wrote only record keeping; the refused rename would have cleared the copy.
    expect(await toolListCopyKept('gw-s')).toBe(true)
    expect(casCalls('setIfUnchanged')).toBe(5)
  })

  it('R6b: a normalizing list refused three times throws and stores no slug of its own', async () => {
    await redis.json.set(KEY, '$', {
      gateways: [
        custom('gw-new', 'Fresh Server'),
        custom('gw-1', 'One', { slug: 'one' }),
        custom('gw-2', 'Two', { slug: 'two' }),
        custom('gw-3', 'Three', { slug: 'three' })
      ]
    })
    beforeRegistryWrites(3, (n) => mcpGatewayService.update(USER, `gw-${n}`, { name: `Renamed ${n}` }))

    await expect(mcpGatewayService.list(USER)).rejects.toMatchObject(CONFLICT)

    const registry = await storedRegistry()
    expect(registry.gateways.find((gateway) => gateway.id === 'gw-new')).not.toHaveProperty('slug')
    expect(registry.gateways.slice(1).map((gateway) => gateway.name)).toEqual(['Renamed 1', 'Renamed 2', 'Renamed 3'])
  })

  it('R6c: a delete refused three times throws, keeps the gateway, its copy, and sweeps nothing', async () => {
    await mcpGatewayService.create(USER, custom('gw-a', 'Alpha'))
    await saveToolListCopy('gw-a')
    vi.clearAllMocks()
    beforeRegistryWrites(3, (n) => mcpGatewayService.update(USER, 'gw-a', { discoveredTools: [`t${n}`] }))

    await expect(mcpGatewayService.delete(USER, 'gw-a')).rejects.toMatchObject(CONFLICT)

    expect((await stored('gw-a')).discoveredTools).toEqual(['t3'])
    expect(await toolListCopyKept('gw-a')).toBe(true)
    expect(sweepGatewayReferencesForUser).not.toHaveBeenCalled()
  })

  it('R6d: the gateway PUT answers 409 on the conflict error and syncs no profile', async () => {
    await mcpGatewayService.create(USER, custom('gw-a', 'Alpha'))
    vi.clearAllMocks()
    beforeRegistryWrites(3, (n) => mcpGatewayService.update(USER, 'gw-a', { discoveredTools: [`t${n}`] }))

    const response = await put('gw-a', { name: 'Mine' })

    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error).not.toMatch(/not found|Invalid/)
    expect((await stored('gw-a')).name).toBe('Alpha')
    expect(profileSync.codex).not.toHaveBeenCalled()
    expect(profileSync.claude).not.toHaveBeenCalled()
  })

  it('R6e: the gateway DELETE answers 409 on the conflict error and syncs no profile', async () => {
    await mcpGatewayService.create(USER, custom('gw-a', 'Alpha'))
    vi.clearAllMocks()
    beforeRegistryWrites(3, (n) => mcpGatewayService.update(USER, 'gw-a', { discoveredTools: [`t${n}`] }))

    const response = await del('gw-a')

    expect(response.status).toBe(409)
    expect(await stored('gw-a')).not.toBeNull()
    expect(profileSync.codex).not.toHaveBeenCalled()
  })

  it('R6f: a PUT whose write was stored never answers 409 "nothing was saved" when the read back fails', async () => {
    await mcpGatewayService.create(USER, custom('gw-a', 'Alpha'))
    vi.clearAllMocks()
    // After the stored save, a gateway that needs a slug appears and three writes refuse the
    // read back's normalizing write, so `get` throws the conflict error after the save.
    profileSync.codex.mockImplementationOnce(async () => {
      const registry = await storedRegistry()
      registry.gateways.push(custom('gw-new', 'Fresh Server'))
      await redis.json.set(KEY, '$', registry)
      beforeRegistryWrites(3, (n) => mcpGatewayService.update(USER, 'gw-a', { discoveredTools: [`t${n}`] }))
    })

    const response = await put('gw-a', { name: 'Mine' })

    expect(response.status).toBe(500)
    expect((await stored('gw-a')).name).toBe('Mine')
  })

  it('R6g: a DELETE whose delete was stored never answers 409 when the profile sync then fails with the conflict', async () => {
    await mcpGatewayService.create(USER, custom('gw-a', 'Alpha'))
    vi.clearAllMocks()
    profileSync.codex.mockImplementationOnce(async () => {
      throw new GatewayRegistryConflictError()
    })

    const response = await del('gw-a')

    expect(response.status).toBe(500)
    expect(await stored('gw-a')).toBeNull()
  })

  it('R13: an update function answers plain fields synchronously; bad fields are refused with no retry; no change writes nothing', async () => {
    await mcpGatewayService.create(USER, custom('gw-a', 'Alpha'))
    const before = await storedRegistry()
    vi.clearAllMocks()

    await expect(
      mcpGatewayService.update(USER, 'gw-a', (async () => ({ name: 'Later' })) as any)
    ).rejects.toThrow('synchronously')
    await expect(mcpGatewayService.update(USER, 'gw-a', (() => [{ name: 'x' }]) as any)).rejects.toThrow(
      'synchronously'
    )
    await expect(mcpGatewayService.update(USER, 'gw-a', () => ({ type: 'bogus' as any }))).rejects.toThrow(
      'Invalid gateway type'
    )
    const unchanged = await mcpGatewayService.update(USER, 'gw-a', () => ({}))

    expect(unchanged).toEqual(before.gateways[0])
    expect(await storedRegistry()).toEqual(before)
    expect(casCalls('setIfUnchanged')).toBe(0)
  })

  it('R7: two creates with the same name at once both stay, with distinct slugs that are the ones answered', async () => {
    const [first, second] = await Promise.all([
      mcpGatewayService.create(USER, custom('gw-x', 'Twin')),
      mcpGatewayService.create(USER, custom('gw-y', 'Twin'))
    ])

    const registry = await storedRegistry()
    expect(registry.gateways.map((gateway) => gateway.id).sort()).toEqual(['gw-x', 'gw-y'])
    expect(new Set(registry.gateways.map((gateway) => gateway.slug)).size).toBe(2)
    expect(first.slug).toBe((await stored('gw-x')).slug)
    expect(second.slug).toBe((await stored('gw-y')).slug)
  })

  it('R8 (guard): a gateway deleted in a save\'s window is refused "not found" and never made again', async () => {
    await mcpGatewayService.create(USER, custom('gw-a', 'Alpha'))
    await mcpGatewayService.create(USER, custom('gw-b', 'Beta'))
    beforeRegistryWrites(1, () => mcpGatewayService.delete(USER, 'gw-a'))

    await expect(mcpGatewayService.update(USER, 'gw-a', { name: 'Alpha renamed' })).rejects.toThrow(
      'Gateway with ID gw-a not found'
    )

    expect(await stored('gw-a')).toBeNull()
    expect((await stored('gw-b')).name).toBe('Beta')
  })

  it('R9 (guard): a delete that shifts the list between the find and the snapshot never lands the save on a sibling', async () => {
    await mcpGatewayService.create(USER, custom('gw-a', 'Alpha'))
    await mcpGatewayService.create(USER, custom('gw-b', 'Beta'))
    await mcpGatewayService.create(USER, custom('gw-c', 'Gamma'))
    const siblingBefore = await stored('gw-c')
    // Fires on the read of one element, after the read that found the gateway's position.
    beforeRegistryReads((path) => typeof path === 'string' && /\[\d+\]$/.test(path), 1, () =>
      mcpGatewayService.delete(USER, 'gw-a')
    )

    await mcpGatewayService.update(USER, 'gw-b', { name: 'Beta renamed' })

    expect(await stored('gw-a')).toBeNull()
    expect((await stored('gw-b')).name).toBe('Beta renamed')
    expect(await stored('gw-c')).toEqual(siblingBefore)
  })

  it('R9b (guard): a delete that shifts the list between the snapshot and the write is refused and retried', async () => {
    await mcpGatewayService.create(USER, custom('gw-a', 'Alpha'))
    await mcpGatewayService.create(USER, custom('gw-b', 'Beta'))
    await mcpGatewayService.create(USER, custom('gw-c', 'Gamma'))
    const siblingBefore = await stored('gw-c')
    beforeRegistryWrites(1, () => mcpGatewayService.delete(USER, 'gw-a'))

    await mcpGatewayService.update(USER, 'gw-b', { name: 'Beta renamed' })

    expect(await stored('gw-a')).toBeNull()
    expect((await stored('gw-b')).name).toBe('Beta renamed')
    expect(await stored('gw-c')).toEqual(siblingBefore)
  })

  // BL-1397: the migration moves a copy only into an absent saved key, in one guarded step that
  // compares the key and the gateway element; the PUT moves it with the same step after its write.
  // (The saved key here is the mock's `{ moved }` record; the owning file with the real key store
  // and encryption is n8nInstanceCredential.test.ts.)
  function beforeTokenMove(competitor: () => Promise<unknown>) {
    const original = json.moveLegacyN8nToken.getMockImplementation()
    let fired = false
    json.moveLegacyN8nToken.mockImplementation(async (...args: any[]) => {
      if (!fired) {
        fired = true
        await competitor()
      }
      return original(...args)
    })
    return () => json.moveLegacyN8nToken.mockImplementation(original)
  }

  it('R11: the token migration moves the copy and keeps metadata saved in its window', async () => {
    await mcpGatewayService.create(USER, n8nInstance('gw-n', { authToken: ' old-token ', base: 'x' }))
    const listCopy = await mcpGatewayService.list(USER)
    // A save of other metadata lands between the migration's read and its write.
    const restore = beforeTokenMove(() => metadataWrittenElsewhere('gw-n', { label: 'saved meanwhile' }))

    try {
      await migrateLegacyN8nInstanceMcpTokens({ userId: USER, gateways: listCopy, logPrefix: 'test' })
    } finally {
      restore()
    }

    expect(json.moveLegacyN8nToken).toHaveBeenCalledTimes(2)
    expect(await redis.json.get(`api_keys:${USER}:n8n_instance_mcp_token`)).toEqual({ moved: 'old-token' })
    expect((await stored('gw-n')).metadata).toEqual({ base: 'x', label: 'saved meanwhile' })
    // The caller's copy is the stored metadata, for the profile sync that follows.
    expect(listCopy[0].metadata).toEqual({ base: 'x', label: 'saved meanwhile' })
  })

  it('R11b: a different copy stored since the read (a restore) is the one that moves', async () => {
    await mcpGatewayService.create(USER, n8nInstance('gw-n', { authToken: 'old-token', base: 'x' }))
    const listCopy = await mcpGatewayService.list(USER)
    const restore = beforeTokenMove(() => metadataWrittenElsewhere('gw-n', { authToken: 'restored-token' }))

    try {
      await migrateLegacyN8nInstanceMcpTokens({ userId: USER, gateways: listCopy, logPrefix: 'test' })
    } finally {
      restore()
    }

    expect(await redis.json.get(`api_keys:${USER}:n8n_instance_mcp_token`)).toEqual({ moved: 'restored-token' })
    expect((await stored('gw-n')).metadata).toEqual({ base: 'x' })
  })

  it('R12: an n8n PUT keeps metadata saved in its window and removes the token it replaced', async () => {
    await mcpGatewayService.create(USER, n8nInstance('gw-n', { authToken: 'legacy-token', base: 'x' }))
    beforeRegistryWrites(1, () => metadataWrittenElsewhere('gw-n', { note: 'saved meanwhile' }))

    const response = await put('gw-n', { metadata: { authToken: 'fresh-token', label: 'L' } })

    expect(response.status).toBe(200)
    expect(apiKeyService.store).toHaveBeenCalledWith('n8n_instance_mcp_token', 'fresh-token', USER)
    // BL-1407: stored after the gateway write; the old copy then left through the guarded move.
    expect(await redis.json.get(`api_keys:${USER}:n8n_instance_mcp_token`)).toEqual({ moved: 'fresh-token' })
    expect((await stored('gw-n')).metadata).toEqual({ base: 'x', label: 'L', note: 'saved meanwhile' })
  })

  it('R12b: an n8n PUT with no token stores none itself; its guarded move takes a copy stored after its read', async () => {
    await mcpGatewayService.create(USER, n8nInstance('gw-n', { authToken: 'legacy-token', base: 'x' }))
    beforeRegistryWrites(1, () => metadataWrittenElsewhere('gw-n', { authToken: 'restored-token' }))

    const response = await put('gw-n', { metadata: { label: 'L' } })

    expect(response.status).toBe(200)
    expect(apiKeyService.store).not.toHaveBeenCalled()
    expect(await redis.json.get(`api_keys:${USER}:n8n_instance_mcp_token`)).toEqual({ moved: 'restored-token' })
    expect((await stored('gw-n')).metadata).toEqual({ base: 'x', label: 'L' })
  })

  it('R10: a delete sweeps the tool names of the gateway it actually removed', async () => {
    await mcpGatewayService.create(USER, custom('gw-a', 'Alpha'))
    await mcpGatewayService.create(USER, custom('gw-b', 'Beta', { discoveredTools: ['shared'] }))
    beforeRegistryWrites(1, () =>
      mcpGatewayService.update(USER, 'gw-a', { discoveredTools: ['only_alpha', 'shared'] })
    )

    await mcpGatewayService.delete(USER, 'gw-a')

    expect(await stored('gw-a')).toBeNull()
    expect(sweepGatewayReferencesForUser).toHaveBeenCalledTimes(1)
    const [{ orphanToolNames }] = vi.mocked(sweepGatewayReferencesForUser).mock.calls[0] as any
    // BL-1396: every name of the removed element is a candidate; the sweep's own registry read
    // keeps `shared` for gw-b (mcpGatewayReferenceCleanup.test.ts, BL-1396 cases).
    expect([...orphanToolNames]).toEqual(['only_alpha', 'shared'])
  })
})
