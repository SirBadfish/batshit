import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ARTIFACT_TOOL_GRID_ID, FABRIC_TOOL_GRID_ID } from '$lib/utils/toolGridBrokerFamilies'
import { CLI_TOOL_GRID_ID } from '$lib/utils/toolGridCli'
import { logger } from '$lib/utils/logger'

const redisMock = vi.hoisted(() => ({
  execute: vi.fn(),
  json: {} as Record<string, unknown>
}))

vi.mock('$lib/server/redis', () => ({
  redis: redisMock
}))

vi.mock('$lib/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

import {
  RESERVED_TOOL_GRID_IDS,
  PRUNE_GATEWAY_REFERENCES_SCRIPT,
  buildGatewayReferenceCleanupKey,
  collectGatewayToolNames,
  extractGatewayIdFromCompositeKey,
  pruneGatewayReferencesFromRecord,
  runGatewayOrphanReferenceCleanup,
  sweepGatewayReferencesForUser
} from '../mcpGatewayReferenceCleanup'
import { mcpGatewayService } from '../mcpGatewayService'
import { createJsonCompareAndWriteTwinsForMap } from '$lib/test-utils/redisJsonCompareAndWriteTwin'

const LIVE_GATEWAY = '475d64ba-4334-4cc1-b637-a89e331c85e1'
const DEAD_GATEWAY = '051664a6-dead-4cc1-b637-a89e331c85e1'

/**
 * Minimal in-memory stand-in for the RedisJSON client surface these modules use.
 * Deliberately not a mock-per-call: the acceptance test needs `delete()` and the
 * sweep to see each other's writes through one store.
 */
function createFakeRedis() {
  const json = new Map<string, any>()
  const strings = new Map<string, string>()
  const sets = new Map<string, string[]>()

  // Explicit schedule point immediately before the atomic CAS (not a Lua emulator).
  let beforeEval: (() => void) | undefined
  const atPath = (key: string, path: string) => {
    const match = /^\$\.([a-zA-Z_]+)(?:\.([a-zA-Z]+)\["((?:\\.|[^"\\])*)"\])?$/.exec(path)
    if (!match) throw new Error(`Unsupported twin path: ${path}`)
    const [, field, map, escaped] = match
    const record = json.get(key)
    const entry = escaped?.replace(/\\(["\\])/g, '$1')
    return map ? { owner: record[field][map], key: entry! } : { owner: record, key: field }
  }
  const client = {
    json: {
      get: vi.fn(async (key: string) => (json.has(key) ? structuredClone(json.get(key)) : null)),
      set: vi.fn(async (key: string, _path: string, value: any) => {
        json.set(key, structuredClone(value))
        return 'OK'
      })
    },
    sendCommand: vi.fn(async ([command, key]: string[]) => {
      if (command !== 'JSON.GET') throw new Error(`Unsupported twin command: ${command}`)
      return json.has(key) ? JSON.stringify(json.get(key)) : null
    }),
    eval: vi.fn(async (script: string, options: { keys: string[]; arguments: string[] }) => {
      expect(script).toBe(PRUNE_GATEWAY_REFERENCES_SCRIPT)
      beforeEval?.()
      const [recordKey, registryKey] = options.keys
      const [recordRaw, registryRaw, plan] = options.arguments
      if (!json.has(registryKey)) return 'REGISTRY_UNAVAILABLE'
      if (JSON.stringify(json.get(registryKey)) !== registryRaw) return 'CHANGED'
      if (!json.has(recordKey)) return 'MISSING'
      if (JSON.stringify(json.get(recordKey)) !== recordRaw) return 'CHANGED'
      const ops = JSON.parse(plan)
      for (const [kind, path] of ops) {
        const { owner, key } = atPath(recordKey, path)
        if (!Object.hasOwn(owner, key) || (kind === 'pop' && !Array.isArray(owner[key]))) {
          throw new Error('Cleanup path unavailable')
        }
      }
      for (const [kind, path, index] of ops) {
        const { owner, key } = atPath(recordKey, path)
        if (kind === 'pop') owner[key].splice(index, 1)
        else delete owner[key]
      }
      return 'OK'
    }),
    get: vi.fn(async (key: string) => strings.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      strings.set(key, value)
      return 'OK'
    }),
    sMembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])])
  }

  redisMock.execute.mockImplementation(async (fn: (c: typeof client) => any) => fn(client))
  // BL-1371: `mcpGatewayService.delete` removes its element with the facade's compare-and-set.
  Object.assign(redisMock.json, createJsonCompareAndWriteTwinsForMap(json))

  return { client, json, strings, sets, beforeEval: (hook: () => void) => { beforeEval = hook } }
}

function gateway(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Gateway ${id.slice(0, 4)}`,
    type: 'custom',
    url: `https://example.test/${id}`,
    enabled: true,
    ...extra
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('composite key contract', () => {
  it('reads the gateway ID back out of a composite key', () => {
    // The cleanup module cannot import buildCompositeKey without an import
    // cycle, so it restates the `::` separator. Equality with the real builder
    // is pinned in dynamicMcpIndex.test.ts, which already imports it.
    expect(extractGatewayIdFromCompositeKey(`${LIVE_GATEWAY}::HuggingFace`)).toBe(LIVE_GATEWAY)
  })

  it('returns null for keys that carry no gateway prefix', () => {
    expect(extractGatewayIdFromCompositeKey('HuggingFace')).toBeNull()
    expect(extractGatewayIdFromCompositeKey('::Orphaned')).toBeNull()
    expect(extractGatewayIdFromCompositeKey('')).toBeNull()
  })

  it('reserves the three Tool Grid family IDs and the unknown-gateway placeholder', () => {
    expect(RESERVED_TOOL_GRID_IDS.has(CLI_TOOL_GRID_ID)).toBe(true)
    expect(RESERVED_TOOL_GRID_IDS.has(FABRIC_TOOL_GRID_ID)).toBe(true)
    expect(RESERVED_TOOL_GRID_IDS.has(ARTIFACT_TOOL_GRID_ID)).toBe(true)
    expect(RESERVED_TOOL_GRID_IDS.has('unknown_gateway')).toBe(true)
  })
})

describe('pruneGatewayReferencesFromRecord', () => {
  const isOrphanGatewayId = (id: string) => id === DEAD_GATEWAY

  it('removes orphan gateway IDs from both field spellings and keeps live ones', () => {
    const result = pruneGatewayReferencesFromRecord(
      {
        defaultMCPGateways: [LIVE_GATEWAY, DEAD_GATEWAY],
        default_mcp_gateways: [DEAD_GATEWAY]
      },
      { isOrphanGatewayId }
    )

    expect(result.changed).toBe(true)
    expect(result.next.defaultMCPGateways).toEqual([LIVE_GATEWAY])
    expect(result.next.default_mcp_gateways).toEqual([])
    expect(result.removedGatewayIds).toEqual([DEAD_GATEWAY, DEAD_GATEWAY])
  })

  it('removes orphan keys from all four dcmDisplaySettings maps', () => {
    const result = pruneGatewayReferencesFromRecord(
      {
        dcmDisplaySettings: {
          version: 1,
          groups: {
            [`${LIVE_GATEWAY}::HuggingFace`]: 'group-only',
            [`${DEAD_GATEWAY}::Filesystem`]: 'group+tools+hints'
          },
          tools: {
            [`${DEAD_GATEWAY}::read_file`]: 'name+hint'
          },
          groupDisplayPreferences: {
            [`${DEAD_GATEWAY}::Filesystem`]: 'group+tools+hints'
          },
          toolDisplayPreferences: {
            [`${DEAD_GATEWAY}::read_file`]: 'name+hint',
            [`${LIVE_GATEWAY}::search`]: 'name-only'
          }
        }
      },
      { isOrphanGatewayId }
    )

    expect(result.changed).toBe(true)
    const settings = result.next.dcmDisplaySettings
    expect(Object.keys(settings.groups)).toEqual([`${LIVE_GATEWAY}::HuggingFace`])
    expect(settings.tools).toEqual({})
    expect(settings.groupDisplayPreferences).toEqual({})
    expect(Object.keys(settings.toolDisplayPreferences)).toEqual([`${LIVE_GATEWAY}::search`])
    expect(result.removedDcmKeys).toHaveLength(4)
  })

  it('sweeps the snake_case dcm settings field too', () => {
    const result = pruneGatewayReferencesFromRecord(
      {
        dcm_display_settings: {
          version: 1,
          groups: { [`${DEAD_GATEWAY}::Filesystem`]: 'group-only' }
        }
      },
      { isOrphanGatewayId }
    )

    expect(result.changed).toBe(true)
    expect(result.next.dcm_display_settings.groups).toEqual({})
  })

  it('never sweeps the synthetic Tool Grid family rows', () => {
    const record = {
      dcmDisplaySettings: {
        version: 1,
        groups: {
          [`${CLI_TOOL_GRID_ID}::CLI Tools`]: 'group+tools+hints',
          [`${FABRIC_TOOL_GRID_ID}::Fabric Controls`]: 'group-only',
          [`${ARTIFACT_TOOL_GRID_ID}::Artifact Tools`]: 'group+tools+hints',
          ['unknown_gateway::Ungrouped Tools']: 'group-only'
        }
      }
    }

    // Predicate says everything is an orphan; the reserved list must still win.
    const result = pruneGatewayReferencesFromRecord(record, {
      isOrphanGatewayId: () => true
    })

    expect(result.changed).toBe(false)
    expect(Object.keys(result.next.dcmDisplaySettings.groups)).toHaveLength(4)
  })

  it('removes only tool names the caller marked orphaned', () => {
    const result = pruneGatewayReferencesFromRecord(
      { defaultMCPToolSelections: ['read_file', 'search_docs'] },
      { isOrphanGatewayId, orphanToolNames: new Set(['read_file']) }
    )

    expect(result.next.defaultMCPToolSelections).toEqual(['search_docs'])
    expect(result.removedToolNames).toEqual(['read_file'])
  })

  it('reports no change and does not mutate the input when nothing is orphaned', () => {
    const record = {
      defaultMCPGateways: [LIVE_GATEWAY],
      dcmDisplaySettings: { version: 1, groups: { [`${LIVE_GATEWAY}::HuggingFace`]: 'group-only' } }
    }
    const snapshot = structuredClone(record)

    const result = pruneGatewayReferencesFromRecord(record, { isOrphanGatewayId })

    expect(result.changed).toBe(false)
    expect(record).toEqual(snapshot)
  })

  it('tolerates malformed records without throwing', () => {
    expect(pruneGatewayReferencesFromRecord(null, { isOrphanGatewayId }).changed).toBe(false)
    expect(
      pruneGatewayReferencesFromRecord(
        { defaultMCPGateways: 'not-an-array', dcmDisplaySettings: 42 },
        { isOrphanGatewayId }
      ).changed
    ).toBe(false)
  })
})

describe('collectGatewayToolNames', () => {
  it('collects names from discoveredTools and toolGroupings', () => {
    const names = collectGatewayToolNames(
      gateway(DEAD_GATEWAY, {
        discoveredTools: ['read_file'],
        toolGroupings: [{ mcpName: 'Filesystem', toolIds: ['write_file'] }]
      }) as any
    )
    expect([...names].sort()).toEqual(['read_file', 'write_file'])
  })
})

describe('sweepGatewayReferencesForUser', () => {
  it('keeps a candidate name that a gateway in the registry still serves', async () => {
    const fake = createFakeRedis()
    fake.json.set('mcp_gateways:josh', { gateways: [gateway(LIVE_GATEWAY, { discoveredTools: ['search_docs'] })] })
    fake.sets.set('user:josh:agents', ['bob'])
    fake.json.set('agent:bob', { id: 'bob', defaultMCPToolSelections: ['read_file', 'search_docs'] })

    await sweepGatewayReferencesForUser({ userId: 'josh', orphanToolNames: new Set(['read_file', 'search_docs']) })

    // search_docs is still reachable through the live gateway, so removing it
    // from the agent's selections would silently disable a working tool.
    expect(fake.json.get('agent:bob').defaultMCPToolSelections).toEqual(['search_docs'])
  })

  it('fails closed when the gateway registry cannot be read', async () => {
    const fake = createFakeRedis()
    fake.sets.set('user:josh:agents', ['bob'])
    fake.json.set('agent:bob', { id: 'bob', defaultMCPGateways: [DEAD_GATEWAY] })

    await expect(sweepGatewayReferencesForUser({ userId: 'josh' })).rejects.toThrow('registry unavailable')
    expect(fake.json.get('agent:bob').defaultMCPGateways).toEqual([DEAD_GATEWAY])
    expect(fake.client.json.set).not.toHaveBeenCalled()
  })

  it('sweeps subagents as well as agents (DL-8)', async () => {
    const fake = createFakeRedis()
    fake.json.set('mcp_gateways:josh', { gateways: [gateway(LIVE_GATEWAY)] })
    fake.sets.set('user:josh:agents', ['bob'])
    fake.sets.set('user:josh:subagents', ['researcher'])
    fake.json.set('agent:bob', { id: 'bob', defaultMCPGateways: [DEAD_GATEWAY, LIVE_GATEWAY] })
    fake.json.set('subagent:researcher', {
      id: 'researcher',
      defaultMCPGateways: [DEAD_GATEWAY],
      dcmDisplaySettings: {
        version: 1,
        groups: { [`${DEAD_GATEWAY}::Filesystem`]: 'group-only' }
      }
    })

    const result = await sweepGatewayReferencesForUser({ userId: 'josh' })

    expect(result.scanned).toBe(2)
    expect(result.updatedRecordKeys.sort()).toEqual(['agent:bob', 'subagent:researcher'])
    expect(fake.json.get('agent:bob').defaultMCPGateways).toEqual([LIVE_GATEWAY])
    expect(fake.json.get('subagent:researcher').defaultMCPGateways).toEqual([])
    expect(fake.json.get('subagent:researcher').dcmDisplaySettings.groups).toEqual({})
  })
})

describe('mcpGatewayService.delete leaves no references behind', () => {
  it('removes every agent and subagent reference to the deleted gateway', async () => {
    const fake = createFakeRedis()

    fake.json.set('mcp_gateways:josh', {
      gateways: [
        gateway(DEAD_GATEWAY, { discoveredTools: ['read_file', 'search_docs'] }),
        gateway(LIVE_GATEWAY, { discoveredTools: ['search_docs'] })
      ]
    })
    fake.sets.set('user:josh:agents', ['bob'])
    fake.sets.set('user:josh:subagents', ['researcher'])

    fake.json.set('agent:bob', {
      id: 'bob',
      defaultMCPGateways: [DEAD_GATEWAY, LIVE_GATEWAY],
      defaultMCPToolSelections: ['read_file', 'search_docs'],
      dcmDisplaySettings: {
        version: 1,
        groups: {
          [`${DEAD_GATEWAY}::Filesystem`]: 'group+tools+hints',
          [`${LIVE_GATEWAY}::HuggingFace`]: 'group-only',
          [`${FABRIC_TOOL_GRID_ID}::Fabric Controls`]: 'group-only'
        },
        tools: { [`${DEAD_GATEWAY}::read_file`]: 'name+hint' },
        groupDisplayPreferences: { [`${DEAD_GATEWAY}::Filesystem`]: 'group+tools+hints' },
        toolDisplayPreferences: { [`${DEAD_GATEWAY}::read_file`]: 'name+hint' }
      }
    })
    fake.json.set('subagent:researcher', {
      id: 'researcher',
      default_mcp_gateways: [DEAD_GATEWAY],
      dcm_display_settings: {
        version: 1,
        groups: { [`${DEAD_GATEWAY}::Filesystem`]: 'group-only' }
      }
    })

    await mcpGatewayService.delete('josh', DEAD_GATEWAY)

    const registry = fake.json.get('mcp_gateways:josh')
    expect(registry.gateways.map((g: any) => g.id)).toEqual([LIVE_GATEWAY])

    const remaining = JSON.stringify([
      fake.json.get('agent:bob'),
      fake.json.get('subagent:researcher')
    ])
    expect(remaining).not.toContain(DEAD_GATEWAY)

    const bob = fake.json.get('agent:bob')
    expect(bob.defaultMCPGateways).toEqual([LIVE_GATEWAY])
    // read_file was only served by the deleted gateway; search_docs survives on
    // the live one and must be kept.
    expect(bob.defaultMCPToolSelections).toEqual(['search_docs'])
    expect(Object.keys(bob.dcmDisplaySettings.groups).sort()).toEqual(
      [`${FABRIC_TOOL_GRID_ID}::Fabric Controls`, `${LIVE_GATEWAY}::HuggingFace`].sort()
    )
    expect(bob.dcmDisplaySettings.tools).toEqual({})
    expect(bob.dcmDisplaySettings.groupDisplayPreferences).toEqual({})
    expect(bob.dcmDisplaySettings.toolDisplayPreferences).toEqual({})

    const researcher = fake.json.get('subagent:researcher')
    expect(researcher.default_mcp_gateways).toEqual([])
    expect(researcher.dcm_display_settings.groups).toEqual({})
  })

  it('also clears references left by earlier deletes it never saw', async () => {
    const fake = createFakeRedis()
    const olderOrphan = '0f67c098-0000-4000-8000-000000000000'

    fake.json.set('mcp_gateways:josh', {
      gateways: [gateway(DEAD_GATEWAY), gateway(LIVE_GATEWAY)]
    })
    fake.sets.set('user:josh:agents', ['n8n_primary_agent'])
    fake.json.set('agent:n8n_primary_agent', {
      id: 'n8n_primary_agent',
      defaultMCPGateways: [olderOrphan, DEAD_GATEWAY, LIVE_GATEWAY]
    })

    await mcpGatewayService.delete('josh', DEAD_GATEWAY)

    expect(fake.json.get('agent:n8n_primary_agent').defaultMCPGateways).toEqual([LIVE_GATEWAY])
  })

  it('does not throw when the sweep fails after the registry write succeeds', async () => {
    const fake = createFakeRedis()
    fake.json.set('mcp_gateways:josh', { gateways: [gateway(DEAD_GATEWAY)] })
    fake.sets.set('user:josh:agents', ['bob'])
    fake.json.set('agent:bob', { id: 'bob', defaultMCPGateways: [DEAD_GATEWAY] })

    fake.client.sMembers.mockRejectedValueOnce(new Error('redis exploded'))

    await expect(mcpGatewayService.delete('josh', DEAD_GATEWAY)).resolves.toBeUndefined()
    expect(fake.json.get('mcp_gateways:josh').gateways).toEqual([])
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('failed to sweep references'), expect.any(Error))
  })
})

/**
 * BL-1396: a delete hands the sweep EVERY tool name of the gateway it removed, as candidates; the
 * sweep keeps a name that a gateway in the registry as it reads it still serves, and its
 * compare-and-set refuses a write when the registry changed. A survivor list from the delete's
 * own earlier read must not decide: a sibling deleted meanwhile is still on it.
 */
describe('BL-1396: a delete passes every name of the removed gateway as a candidate', () => {
  const GW_A = 'a0000000-0000-4000-8000-00000000000a'
  const GW_B = 'b0000000-0000-4000-8000-00000000000b'
  const GW_C = 'c0000000-0000-4000-8000-00000000000c'

  function seed(gateways: Array<Record<string, unknown>>, selections: string[]) {
    const fake = createFakeRedis()
    fake.json.set('mcp_gateways:josh', { gateways })
    fake.sets.set('user:josh:agents', ['bob'])
    fake.json.set('agent:bob', {
      id: 'bob',
      defaultMCPGateways: gateways.map((entry) => entry.id),
      defaultMCPToolSelections: selections
    })
    return fake
  }

  it('two deletes of two gateways that serve the same tool, overlapping, leave no selection of it', async () => {
    const fake = seed(
      [gateway(GW_A, { discoveredTools: ['shared_x'] }), gateway(GW_B, { discoveredTools: ['shared_x'] })],
      ['shared_x', 'keep_me']
    )
    // B's whole delete lands after A read the registry and before A reads its own element.
    const twins = redisMock.json as Record<string, any>
    const getRaw = twins.getRaw
    let raced = false
    twins.getRaw = async (key: string, path: string) => {
      if (!raced && key === 'mcp_gateways:josh' && path === '$.gateways[0]') {
        raced = true
        await mcpGatewayService.delete('josh', GW_B)
      }
      return getRaw(key, path)
    }

    await mcpGatewayService.delete('josh', GW_A)

    expect(raced).toBe(true)
    expect(fake.json.get('mcp_gateways:josh').gateways).toEqual([])
    const bob = fake.json.get('agent:bob')
    expect(bob.defaultMCPGateways).toEqual([])
    // shared_x has no gateway left; keep_me was never a name of either gateway.
    expect(bob.defaultMCPToolSelections).toEqual(['keep_me'])
  })

  it('a gateway that starts serving the tool before the sweep keeps its selection', async () => {
    const fake = seed([gateway(GW_A, { discoveredTools: ['shared_x'] })], ['shared_x', 'keep_me'])
    const twins = redisMock.json as Record<string, any>
    const delIfUnchanged = twins.delIfUnchanged
    twins.delIfUnchanged = async (...args: any[]) => {
      const deleted = await delIfUnchanged(...args)
      if (deleted) {
        fake.json.get('mcp_gateways:josh').gateways.push(gateway(GW_C, { discoveredTools: ['shared_x'] }))
      }
      return deleted
    }

    await mcpGatewayService.delete('josh', GW_A)

    expect(fake.json.get('mcp_gateways:josh').gateways.map((g: any) => g.id)).toEqual([GW_C])
    const bob = fake.json.get('agent:bob')
    expect(bob.defaultMCPGateways).toEqual([])
    expect(bob.defaultMCPToolSelections).toEqual(['shared_x', 'keep_me'])
  })

  it('a gateway that starts serving the tool at the sweep\'s write refuses it, and the retry keeps the selection', async () => {
    const fake = seed([gateway(GW_A, { discoveredTools: ['shared_x'] })], ['shared_x', 'keep_me'])
    let scheduled = false
    fake.beforeEval(() => {
      if (scheduled) return
      scheduled = true
      fake.json.get('mcp_gateways:josh').gateways.push(gateway(GW_C, { discoveredTools: ['shared_x'] }))
    })

    await mcpGatewayService.delete('josh', GW_A)

    expect(fake.client.eval).toHaveBeenCalledTimes(2)
    const bob = fake.json.get('agent:bob')
    expect(bob.defaultMCPGateways).toEqual([])
    expect(bob.defaultMCPToolSelections).toEqual(['shared_x', 'keep_me'])
  })
})

describe('runGatewayOrphanReferenceCleanup', () => {
  it('repairs orphans once and then short-circuits on the marker', async () => {
    const fake = createFakeRedis()
    fake.json.set('mcp_gateways:josh', { gateways: [gateway(LIVE_GATEWAY)] })
    fake.sets.set('user:josh:agents', ['bob'])
    fake.json.set('agent:bob', { id: 'bob', defaultMCPGateways: [DEAD_GATEWAY, LIVE_GATEWAY] })

    await runGatewayOrphanReferenceCleanup('josh')

    expect(fake.json.get('agent:bob').defaultMCPGateways).toEqual([LIVE_GATEWAY])
    expect(fake.strings.get(buildGatewayReferenceCleanupKey('josh'))).toBeTruthy()

    fake.client.json.set.mockClear()
    fake.client.sMembers.mockClear()

    await runGatewayOrphanReferenceCleanup('josh')

    expect(fake.client.sMembers).not.toHaveBeenCalled()
    expect(fake.client.json.set).not.toHaveBeenCalled()
  })

  it('leaves tool selections alone, because a bare name cannot be traced to a dead gateway', async () => {
    const fake = createFakeRedis()
    fake.json.set('mcp_gateways:josh', { gateways: [gateway(LIVE_GATEWAY)] })
    fake.sets.set('user:josh:agents', ['bob'])
    fake.json.set('agent:bob', {
      id: 'bob',
      defaultMCPGateways: [DEAD_GATEWAY],
      defaultMCPToolSelections: ['read_file']
    })

    await runGatewayOrphanReferenceCleanup('josh')

    expect(fake.json.get('agent:bob').defaultMCPToolSelections).toEqual(['read_file'])
  })

  it('does not write the marker when the repair throws, so the next resolve retries', async () => {
    const fake = createFakeRedis()
    fake.client.sendCommand.mockRejectedValueOnce(new Error('redis exploded'))

    await expect(runGatewayOrphanReferenceCleanup('josh')).resolves.toBeUndefined()
    expect(fake.strings.get(buildGatewayReferenceCleanupKey('josh'))).toBeUndefined()
  })
})


describe('BL-889 deterministic old/new schedules (pure twin; real conformance separate)', () => {
  for (const prefix of ['agent', 'subagent']) {
    for (const race of ['settings save', 'selection edit', 'deletion', 'registry change']) {
      it(`${prefix}: old loses ${race}; CAS preserves current state`, async () => {
        const seed = () => {
          const fake = createFakeRedis()
          fake.json.set('mcp_gateways:josh', { gateways: [gateway(LIVE_GATEWAY)] })
          fake.sets.set(`user:josh:${prefix}s`, ['bob'])
          fake.json.set(`${prefix}:bob`, {
            id: 'bob', codex_settings: { model: 'old' }, claude_settings: { model: 'old' },
            defaultMCPGateways: [DEAD_GATEWAY, LIVE_GATEWAY],
            defaultMCPToolSelections: ['read_file', 'shared'],
            dcmDisplaySettings: { groups: { [`${DEAD_GATEWAY}::dead`]: 'hidden', [`${LIVE_GATEWAY}::live`]: 'hidden' } }
          })
          return fake
        }
        const edit = (fake: ReturnType<typeof seed>) => {
          const record = fake.json.get(`${prefix}:bob`)
          if (race === 'settings save') {
            record.codex_settings.model = 'new'; record.claude_settings.model = 'new'
            record.dcmDisplaySettings.groups[`${LIVE_GATEWAY}::live`] = 'group-only'
          } else if (race === 'selection edit') {
            record.defaultMCPGateways = [LIVE_GATEWAY, 'new-live', DEAD_GATEWAY]
            record.defaultMCPToolSelections = ['new-tool', 'read_file', 'shared']
            record.dcmDisplaySettings.groups['new-live::new'] = 'group-only'
            fake.json.get('mcp_gateways:josh').gateways.push(gateway('new-live', { discoveredTools: ['shared'] }))
          } else if (race === 'deletion') fake.json.delete(`${prefix}:bob`)
          else fake.json.get('mcp_gateways:josh').gateways.push(gateway(DEAD_GATEWAY, { discoveredTools: ['read_file', 'shared'] }))
        }
        const old = seed()
        const snapshot = structuredClone(old.json.get(`${prefix}:bob`))
        const pruned = pruneGatewayReferencesFromRecord(snapshot, {
          isOrphanGatewayId: (id) => id !== LIVE_GATEWAY, orphanToolNames: new Set(['read_file', 'shared'])
        })
        edit(old)
        const expected = structuredClone(old.json.get(`${prefix}:bob`))
        old.json.set(`${prefix}:bob`, pruned.next) // The old production root overwrite.
        expect(old.json.get(`${prefix}:bob`)).not.toEqual(expected)

        const fresh = seed()
        let scheduled = false
        fresh.beforeEval(() => { if (!scheduled) { scheduled = true; edit(fresh) } })
        const result = await sweepGatewayReferencesForUser({ userId: 'josh', orphanToolNames: new Set(['read_file', 'shared']) })
        const actual = fresh.json.get(`${prefix}:bob`)
        if (race === 'deletion') {
          expect(actual).toBeUndefined(); expect(result.updatedRecordKeys).toEqual([])
        } else if (race === 'registry change') {
          expect(actual).toEqual(expected); expect(result.updatedRecordKeys).toEqual([])
        } else {
          expect(actual.defaultMCPGateways).toEqual(race === 'selection edit' ? [LIVE_GATEWAY, 'new-live'] : [LIVE_GATEWAY])
          if (race === 'settings save') {
            expect(actual.codex_settings.model).toBe('new'); expect(actual.claude_settings.model).toBe('new')
            expect(actual.dcmDisplaySettings.groups[`${LIVE_GATEWAY}::live`]).toBe('group-only')
          } else {
            expect(actual.defaultMCPToolSelections).toEqual(['new-tool', 'shared'])
            expect(actual.dcmDisplaySettings.groups['new-live::new']).toBe('group-only')
          }
        }
        expect(fresh.client.json.set).not.toHaveBeenCalled()
      })
    }
  }

  it('preserves duplicates, nonstrings and every legacy map, including unusual keys and __proto__', async () => {
    const fake = createFakeRedis()
    fake.json.set('mcp_gateways:josh', { gateways: [gateway(LIVE_GATEWAY)] })
    fake.sets.set('user:josh:agents', ['bob'])
    const weird = 'quote" slash\\ newline\n tab\t emoji😀'
    const maps = Object.fromEntries(['groups', 'tools', 'groupDisplayPreferences', 'toolDisplayPreferences'].map((map) => [map,
      JSON.parse(JSON.stringify({ [`${DEAD_GATEWAY}::${weird}`]: 'hidden', [`${LIVE_GATEWAY}::${weird}`]: 17, ['__proto__']: { safe: true }, ['unknown_gateway::x']: 'hidden' }))
    ]))
    fake.json.set('agent:bob', {
      defaultMCPGateways: [DEAD_GATEWAY, LIVE_GATEWAY, DEAD_GATEWAY, LIVE_GATEWAY, 17, null],
      default_mcp_gateways: [DEAD_GATEWAY], defaultMCPToolSelections: ['dead', 'keep', 'dead'], default_mcp_tool_selections: ['dead'],
      dcmDisplaySettings: structuredClone(maps), dcm_display_settings: structuredClone(maps)
    })
    const result = await sweepGatewayReferencesForUser({ userId: 'josh', orphanToolNames: new Set(['dead']) })
    const actual = fake.json.get('agent:bob')
    expect(actual.defaultMCPGateways).toEqual([LIVE_GATEWAY, LIVE_GATEWAY, 17, null])
    expect(actual.default_mcp_gateways).toEqual([])
    expect(actual.defaultMCPToolSelections).toEqual(['keep'])
    expect(actual.default_mcp_tool_selections).toEqual([])
    expect(result.removedDcmKeys).toHaveLength(8)
    for (const field of ['dcmDisplaySettings', 'dcm_display_settings']) {
      for (const map of Object.values(actual[field]) as any[]) {
        expect(Object.hasOwn(map, '__proto__')).toBe(true)
        expect(map[`unknown_gateway::x`]).toBe('hidden')
        expect(map[`${LIVE_GATEWAY}::${weird}`]).toBe(17)
        expect(map[`${DEAD_GATEWAY}::${weird}`]).toBeUndefined()
      }
    }
  })

  for (const failure of ['registry missing', 'registry malformed', 'record malformed', 'listing', 'read', 'write', 'churn']) {
    it(`leaves the repair marker unset on ${failure}`, async () => {
      const fake = createFakeRedis()
      fake.json.set('mcp_gateways:josh', { gateways: [gateway(LIVE_GATEWAY)] })
      fake.sets.set('user:josh:agents', ['bob'])
      fake.json.set('agent:bob', { defaultMCPGateways: [DEAD_GATEWAY] })
      if (failure === 'registry missing') fake.json.delete('mcp_gateways:josh')
      if (failure === 'registry malformed') fake.json.set('mcp_gateways:josh', { gateways: [null] })
      if (failure === 'record malformed') fake.json.set('agent:bob', [])
      if (failure === 'listing') fake.client.sMembers.mockRejectedValueOnce(new Error('listing'))
      if (failure === 'read') fake.client.sendCommand.mockRejectedValueOnce(new Error('read'))
      if (failure === 'write') fake.client.eval.mockRejectedValueOnce(new Error('write'))
      if (failure === 'churn') fake.beforeEval(() => { fake.json.get('agent:bob').counter = (fake.json.get('agent:bob').counter ?? 0) + 1 })
      await runGatewayOrphanReferenceCleanup('josh')
      expect(fake.strings.has(buildGatewayReferenceCleanupKey('josh'))).toBe(false)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('One-time orphan cleanup failed'), expect.any(Error))
      if (failure === 'churn') expect(fake.client.eval).toHaveBeenCalledTimes(3)
    })
  }

  it('does not mutate any record when a removed key has broken UTF-16', async () => {
    const fake = createFakeRedis()
    fake.json.set('mcp_gateways:josh', { gateways: [] })
    fake.sets.set('user:josh:agents', ['bob'])
    fake.json.set('agent:bob', { defaultMCPGateways: [DEAD_GATEWAY], dcmDisplaySettings: { groups: { [`${DEAD_GATEWAY}::\ud800`]: 'hidden' } } })
    const before = structuredClone(fake.json.get('agent:bob'))
    await expect(sweepGatewayReferencesForUser({ userId: 'josh' })).rejects.toThrow('encoding')
    expect(fake.json.get('agent:bob')).toEqual(before)
    expect(fake.client.eval).not.toHaveBeenCalled()
  })
})


describe('BL-889 unreadable state stays visible', () => {
  for (const bad of [
    { defaultMCPGateways: 'unreadable' },
    { dcmDisplaySettings: [] },
    { dcm_display_settings: { tools: [] } }
  ]) {
    it(`refuses malformed references ${JSON.stringify(bad)}`, async () => {
      const fake = createFakeRedis()
      fake.json.set('mcp_gateways:josh', { gateways: [] })
      fake.sets.set('user:josh:agents', ['bob'])
      fake.json.set('agent:bob', bad)
      await expect(sweepGatewayReferencesForUser({ userId: 'josh' })).rejects.toThrow('malformed')
      expect(fake.client.eval).not.toHaveBeenCalled()
    })
  }
  it('refuses unreadable survivor tools instead of dropping a possibly shared name', async () => {
    const fake = createFakeRedis()
    fake.json.set('mcp_gateways:josh', { gateways: [gateway(LIVE_GATEWAY, { discoveredTools: 'unreadable' })] })
    fake.sets.set('user:josh:agents', ['bob'])
    fake.json.set('agent:bob', { defaultMCPToolSelections: ['shared'] })
    await expect(sweepGatewayReferencesForUser({ userId: 'josh', orphanToolNames: new Set(['shared']) })).rejects.toThrow('unreadable')
    expect(fake.json.get('agent:bob').defaultMCPToolSelections).toEqual(['shared'])
  })
  it('rejects registry removal at the atomic boundary before any record mutation', async () => {
    const fake = createFakeRedis()
    fake.json.set('mcp_gateways:josh', { gateways: [] })
    fake.sets.set('user:josh:agents', ['bob'])
    fake.json.set('agent:bob', { defaultMCPGateways: [DEAD_GATEWAY] })
    fake.beforeEval(() => { fake.json.delete('mcp_gateways:josh') })
    await expect(sweepGatewayReferencesForUser({ userId: 'josh' })).rejects.toThrow('REGISTRY_UNAVAILABLE')
    expect(fake.json.get('agent:bob').defaultMCPGateways).toEqual([DEAD_GATEWAY])
  })
})


describe('BL-889 review repair: supported legacy tool selections', () => {
  for (const prefix of ['agent', 'subagent']) {
    for (const field of ['defaultMCPToolSelections', 'default_mcp_tool_selections']) {
      it(`${prefix} ${field}: legacy-first/later-flat sweep preserves legacy and continues cleanup`, async () => {
        const fake = createFakeRedis()
        fake.json.set('mcp_gateways:josh', { gateways: [gateway(LIVE_GATEWAY)] })
        fake.sets.set(`user:josh:${prefix}s`, ['legacy', 'later'])
        const legacy = { dead: { group: ['remove'], optional: null }, live: { group: ['keep', ''] }, empty: {}, optional: null }
        fake.json.set(`${prefix}:legacy`, {
          defaultMCPGateways: [DEAD_GATEWAY, LIVE_GATEWAY], [field]: structuredClone(legacy),
          dcmDisplaySettings: { groups: { [`${DEAD_GATEWAY}::g`]: 'hidden' } }
        })
        fake.json.set(`${prefix}:later`, { defaultMCPGateways: [DEAD_GATEWAY, LIVE_GATEWAY], [field]: ['remove', 'keep'] })
        // The original prune supports legacy records by leaving their nested
        // selection payload intact while still cleaning gateway/DCM references.
        const baseline = pruneGatewayReferencesFromRecord(structuredClone(fake.json.get(`${prefix}:legacy`)), {
          isOrphanGatewayId: (id) => id !== LIVE_GATEWAY, orphanToolNames: new Set(['remove'])
        })
        expect(baseline.next[field]).toEqual(legacy)
        expect(baseline.next.defaultMCPGateways).toEqual([LIVE_GATEWAY])
        const result = await sweepGatewayReferencesForUser({ userId: 'josh', orphanToolNames: new Set(['remove']) })
        expect(result.updatedRecordKeys).toEqual([`${prefix}:legacy`, `${prefix}:later`])
        expect(fake.json.get(`${prefix}:legacy`)[field]).toEqual(legacy)
        expect(fake.json.get(`${prefix}:legacy`).defaultMCPGateways).toEqual([LIVE_GATEWAY])
        expect(fake.json.get(`${prefix}:legacy`).dcmDisplaySettings.groups).toEqual({})
        expect(fake.json.get(`${prefix}:later`)[field]).toEqual(['keep'])
        expect(fake.json.get(`${prefix}:later`).defaultMCPGateways).toEqual([LIVE_GATEWAY])
      })
    }
  }
  for (const malformed of [7, 'bad', { gateway: 7 }, { gateway: [] }, { gateway: { group: 'bad' } }, { gateway: { group: [7] } }]) {
    it(`refuses malformed legacy payload ${JSON.stringify(malformed)}`, async () => {
      const fake = createFakeRedis()
      fake.json.set('mcp_gateways:josh', { gateways: [] })
      fake.sets.set('user:josh:agents', ['bob'])
      fake.json.set('agent:bob', { defaultMCPGateways: [DEAD_GATEWAY], defaultMCPToolSelections: malformed })
      await expect(sweepGatewayReferencesForUser({ userId: 'josh', orphanToolNames: new Set(['remove']) })).rejects.toThrow('malformed')
      expect(fake.client.eval).not.toHaveBeenCalled()
      expect(fake.json.get('agent:bob').defaultMCPGateways).toEqual([DEAD_GATEWAY])
    })
  }
})
