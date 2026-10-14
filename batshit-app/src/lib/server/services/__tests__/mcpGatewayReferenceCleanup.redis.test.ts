/**
 * BL-889 actual RedisJSON conformance, never the default fake. Parent releases
 * one owned Redis 8.10.1 + JSON instance. Explicit loopback DB15 URL, non-runtime
 * port and matching fixture-owner sentinel are required. No shared DB clearing;
 * this suite deletes only its UUID-namespaced registry/records/index/marker.
 *
 * VITEST_USE_REAL_REDIS=true VITEST_REDIS_URL=redis://127.0.0.1:<owned>/15
 * BL889_USE_OWNED_REDIS=true BL889_REDIS_FIXTURE_TOKEN=<owned-token>; fixture key bl889:fixture:owner must
 * contain that token. No suite startup, installation or service-control authority.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from 'redis'

const adapter = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('$lib/server/redis', () => ({ redis: adapter }))
vi.mock('$lib/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import {
  PRUNE_GATEWAY_REFERENCES_SCRIPT,
  buildGatewayReferenceCleanupKey,
  pruneGatewayReferencesFromRecord,
  runGatewayOrphanReferenceCleanup,
  sweepGatewayReferencesForUser
} from '../mcpGatewayReferenceCleanup'

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
const OWNED_FIXTURE_LANE = process.env.BL889_USE_OWNED_REDIS === 'true'
const LIVE = 'live'
const DEAD = 'dead'
const gateway = (id: string, discoveredTools: string[] = []) => ({ id, discoveredTools })

/** COMMAND INFO preserves a null descriptor when a command is unavailable. */
function assertJsonCommandAvailable(reply: unknown): void {
  if (!Array.isArray(reply) || reply.length !== 1 || !Array.isArray(reply[0]) || reply[0][0] !== 'json.get') {
    throw new Error('BL-889 fixture JSON.GET command unavailable')
  }
}

describe('BL-889 fixture command admission (pure)', () => {
  it('requires the actual JSON.GET descriptor', () => {
    expect(() => assertJsonCommandAvailable([['json.get', -1]])).not.toThrow()
  })
  for (const reply of [null, [], [null], [['get', 2]], [[], null]]) {
    it(`refuses absent or incorrect command descriptor ${JSON.stringify(reply)}`, () => {
      expect(() => assertJsonCommandAvailable(reply)).toThrow('unavailable')
    })
  }
})

describe.runIf(OWNED_FIXTURE_LANE)('BL-889 owned actual RedisJSON conformance', () => {
  let client: ReturnType<typeof createClient>
  let writer: ReturnType<typeof createClient>
  let userId: string
  let ownedKeys: string[] = []
  let hook: (() => Promise<void>) | undefined
  const registryKey = () => `mcp_gateways:${userId}`
  const recordKey = (prefix: string) => `${prefix}:${userId}`

  beforeAll(async () => {
    if (!REAL_REDIS_LANE) throw new Error('BL-889 owned fixture requires the real-Redis lane opt-in')
    const url = process.env.VITEST_REDIS_URL
    const token = process.env.BL889_REDIS_FIXTURE_TOKEN
    if (!url || !token) throw new Error('BL-889 requires an explicitly released owned fixture')
    const parsed = new URL(url)
    if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/15' || !parsed.port ||
        ['5639', '6379', '6380', '5649'].includes(parsed.port)) {
      throw new Error('BL-889 refuses shared/runtime Redis; owned loopback DB15 required')
    }
    client = createClient({ url, database: 15, socket: { connectTimeout: 3000, reconnectStrategy: false } })
    client.on('error', () => {})
    await client.connect()
    expect(await client.get('bl889:fixture:owner')).toBe(token)
    expect(await client.info('server')).toMatch(/redis_version:8\.10\.1\r?\n/)
    assertJsonCommandAvailable(await client.sendCommand(['COMMAND', 'INFO', 'JSON.GET']))
    writer = client.duplicate()
    writer.on('error', () => {})
    await writer.connect()
    adapter.execute.mockImplementation(async (fn) => fn({
      sendCommand: client.sendCommand.bind(client),
      // Redis sets are unordered; fixture IDs sort to schedule legacy before flat.
      sMembers: async (key: string) => (await client.sMembers(key)).sort(),
      get: client.get.bind(client), set: client.set.bind(client),
      eval: async (script: string, options: { keys: string[]; arguments: string[] }) => {
        await hook?.()
        return client.eval(script, options)
      }
    }))
  })

  beforeEach(async () => {
    hook = undefined
    if (ownedKeys.length) await client.unlink(ownedKeys)
    userId = `bl889-${randomUUID()}`
    ownedKeys = [registryKey(), recordKey('agent'), recordKey('subagent'),
      `user:${userId}:agents`, `user:${userId}:subagents`, buildGatewayReferenceCleanupKey(userId)]
  })

  afterAll(async () => {
    if (client?.isOpen) {
      if (ownedKeys.length) await client.unlink(ownedKeys)
      await client.quit()
    }
    if (writer?.isOpen) await writer.quit()
  })

  const seed = async (prefix: string) => {
    await client.json.set(registryKey(), '$', { gateways: [gateway(LIVE)] })
    await client.sAdd(`user:${userId}:${prefix}s`, userId)
    await client.json.set(recordKey(prefix), '$', {
      defaultMCPGateways: [DEAD, LIVE], defaultMCPToolSelections: ['dead_tool', 'shared'],
      codex_settings: { model: 'old' }, claude_settings: { model: 'old' },
      dcmDisplaySettings: { groups: { 'dead::gone': 'hidden', 'live::kept': 'hidden' } }
    })
  }

  for (const prefix of ['agent', 'subagent']) {
    for (const race of ['settings', 'selections', 'delete', 'registry']) {
      it(`${prefix}: deterministic old/new ${race} race`, async () => {
        const edit = async () => {
          if (race === 'settings') {
            await writer.json.set(recordKey(prefix), '$.codex_settings.model', 'new')
            await writer.json.set(recordKey(prefix), '$.claude_settings.model', 'new')
            await writer.json.set(recordKey(prefix), '$.dcmDisplaySettings.groups["live::kept"]', 'group-only')
          } else if (race === 'selections') {
            await writer.json.set(registryKey(), '$.gateways', [gateway(LIVE), gateway('new', ['shared'])])
            await writer.json.set(recordKey(prefix), '$.defaultMCPGateways', [LIVE, 'new', DEAD])
            await writer.json.set(recordKey(prefix), '$.defaultMCPToolSelections', ['new_tool', 'dead_tool', 'shared'])
            await writer.json.set(recordKey(prefix), '$.dcmDisplaySettings.groups["new::kept"]', 'group-only')
          } else if (race === 'delete') await writer.unlink(recordKey(prefix))
          else await writer.json.set(registryKey(), '$.gateways', [gateway(LIVE), gateway(DEAD, ['dead_tool', 'shared'])])
        }
        await seed(prefix)
        const oldRead = await client.json.get(recordKey(prefix)) as Record<string, any>
        const oldNext = pruneGatewayReferencesFromRecord(oldRead, {
          isOrphanGatewayId: (id) => id !== LIVE, orphanToolNames: new Set(['dead_tool', 'shared'])
        }).next
        await edit()
        const expected = await client.json.get(recordKey(prefix))
        await client.json.set(recordKey(prefix), '$', oldNext)
        expect(await client.json.get(recordKey(prefix))).not.toEqual(expected)

        await seed(prefix)
        let edited = false
        hook = async () => { if (!edited) { edited = true; await edit() } }
        const result = await sweepGatewayReferencesForUser({ userId, orphanToolNames: new Set(['dead_tool', 'shared']) })
        const actual = await client.json.get(recordKey(prefix)) as Record<string, any> | null
        if (race === 'delete' || race === 'registry') {
          expect(actual).toEqual(expected)
          expect(result.updatedRecordKeys).toEqual([])
        } else {
          expect(actual!.defaultMCPGateways).toEqual(race === 'selections' ? [LIVE, 'new'] : [LIVE])
          if (race === 'settings') {
            expect(actual!.codex_settings.model).toBe('new')
            expect(actual!.claude_settings.model).toBe('new')
            expect(actual!.dcmDisplaySettings.groups['live::kept']).toBe('group-only')
          } else {
            expect(actual!.defaultMCPToolSelections).toEqual(['new_tool', 'shared'])
            expect(actual!.dcmDisplaySettings.groups['new::kept']).toBe('group-only')
          }
        }
      })
    }
  }

  for (const prefix of ['agent', 'subagent']) {
    for (const field of ['defaultMCPToolSelections', 'default_mcp_tool_selections']) {
      it(`${prefix} ${field}: legacy-first cleanup keeps nested selections and reaches later flat record`, async () => {
        const legacyId = `${userId}-a-legacy`
        const laterId = `${userId}-b-flat`
        const legacyKey = `${prefix}:${legacyId}`
        const laterKey = `${prefix}:${laterId}`
        ownedKeys.push(legacyKey, laterKey)
        const legacy = { dead: { group: ['dead_tool'] }, live: { group: ['keep'] }, optional: null }
        await client.json.set(registryKey(), '$', { gateways: [gateway(LIVE)] })
        await client.sAdd(`user:${userId}:${prefix}s`, [legacyId, laterId])
        await client.json.set(legacyKey, '$', {
          defaultMCPGateways: [DEAD, LIVE], [field]: legacy,
          dcmDisplaySettings: { groups: { 'dead::g': 'hidden' } }
        })
        await client.json.set(laterKey, '$', { defaultMCPGateways: [DEAD, LIVE], [field]: ['dead_tool', 'keep'] })
        const result = await sweepGatewayReferencesForUser({ userId, orphanToolNames: new Set(['dead_tool']) })
        expect(result.updatedRecordKeys).toEqual([legacyKey, laterKey])
        const currentLegacy = await client.json.get(legacyKey) as Record<string, any>
        expect(currentLegacy[field]).toEqual(legacy)
        expect(currentLegacy.defaultMCPGateways).toEqual([LIVE])
        expect(currentLegacy.dcmDisplaySettings.groups).toEqual({})
        const currentFlat = await client.json.get(laterKey) as Record<string, any>
        expect(currentFlat[field]).toEqual(['keep'])
        expect(currentFlat.defaultMCPGateways).toEqual([LIVE])
      })
    }
  }

  it('removes only entries: escaping, all maps/spellings, duplicates, reserved IDs and exact stored numbers', async () => {
    const unusual = 'quote" slash\\ newline\n tab\t emoji😀 [*].end'
    const maps = Object.fromEntries(['groups', 'tools', 'groupDisplayPreferences', 'toolDisplayPreferences'].map((name) => [name,
      { [`dead::${unusual}`]: 'hidden', [`live::${unusual}`]: 'group-only', ['__proto__']: { safe: true },
        '__cli_tools__::x': 'hidden', '__fabric_controls__::x': 'hidden', '__artifact_runtime__::x': 'hidden', 'unknown_gateway::x': 'hidden' }
    ]))
    await client.json.set(registryKey(), '$', { gateways: [gateway(LIVE)] })
    await client.sAdd(`user:${userId}:agents`, userId)
    const raw = JSON.stringify({
      defaultMCPGateways: [DEAD, LIVE, DEAD, LIVE, '__cli_tools__', 17, null], default_mcp_gateways: [DEAD],
      defaultMCPToolSelections: ['dead_tool', 'keep', 'dead_tool'], default_mcp_tool_selections: ['dead_tool'],
      dcmDisplaySettings: maps, dcm_display_settings: maps, precision: 'REPLACE_NUMBER'
    }).replace('"REPLACE_NUMBER"', '9007199254740993')
    await client.sendCommand(['JSON.SET', recordKey('agent'), '$', raw])
    const result = await sweepGatewayReferencesForUser({ userId, orphanToolNames: new Set(['dead_tool']) })
    const actual = await client.json.get(recordKey('agent')) as Record<string, any>
    expect(actual.defaultMCPGateways).toEqual([LIVE, LIVE, '__cli_tools__', 17, null])
    expect(actual.default_mcp_gateways).toEqual([])
    expect(actual.defaultMCPToolSelections).toEqual(['keep'])
    expect(actual.default_mcp_tool_selections).toEqual([])
    expect(await client.sendCommand(['JSON.GET', recordKey('agent'), '.precision'])).toBe('9007199254740993')
    expect(result.removedDcmKeys).toHaveLength(8)
    for (const field of ['dcmDisplaySettings', 'dcm_display_settings']) {
      for (const map of Object.values(actual[field]) as any[]) {
        expect(Object.hasOwn(map, '__proto__')).toBe(true)
        expect(Object.keys(map)).toHaveLength(6)
        expect(map[`live::${unusual}`]).toBe('group-only')
      }
    }
  })

  it('preflights every path before any pop (Redis Lua has no rollback)', async () => {
    await seed('agent')
    const recordRaw = await client.sendCommand(['JSON.GET', recordKey('agent')]) as string
    const registryRaw = await client.sendCommand(['JSON.GET', registryKey()]) as string
    await expect(client.eval(PRUNE_GATEWAY_REFERENCES_SCRIPT, {
      keys: [recordKey('agent'), registryKey()], arguments: [recordRaw, registryRaw,
        JSON.stringify([['pop', '$.defaultMCPGateways', 0], ['del', '$.missing["bad"]']])]
    })).rejects.toThrow()
    expect(await client.sendCommand(['JSON.GET', recordKey('agent')])).toBe(recordRaw)
  })

  for (const failure of ['missing registry', 'wrongtype registry', 'malformed registry', 'wrongtype record', 'churn']) {
    it(`rejects safely without a marker: ${failure}`, async () => {
      await seed('agent')
      if (failure === 'missing registry') await client.unlink(registryKey())
      if (failure === 'wrongtype registry') { await client.unlink(registryKey()); await client.set(registryKey(), 'wrong type') }
      if (failure === 'malformed registry') await client.json.set(registryKey(), '$', { gateways: [null] })
      if (failure === 'wrongtype record') { await client.unlink(recordKey('agent')); await client.set(recordKey('agent'), 'wrong type') }
      let attempts = 0
      if (failure === 'churn') hook = async () => { await writer.json.set(recordKey('agent'), '$.counter', ++attempts) }
      await runGatewayOrphanReferenceCleanup(userId)
      expect(await client.get(buildGatewayReferenceCleanupKey(userId))).toBeNull()
      if (failure === 'churn') expect(attempts).toBe(3)
    })
  }
})
