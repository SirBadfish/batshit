import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ARTIFACT_TOOL_GRID_ID, FABRIC_TOOL_GRID_ID } from '$lib/utils/toolGridBrokerFamilies'
import { CLI_TOOL_GRID_ID } from '$lib/utils/toolGridCli'

const redisMock = vi.hoisted(() => ({
  execute: vi.fn()
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
  buildGatewayReferenceCleanupKey,
  collectGatewayToolNames,
  extractGatewayIdFromCompositeKey,
  pruneGatewayReferencesFromRecord,
  resolveOrphanToolNames,
  runGatewayOrphanReferenceCleanup,
  sweepGatewayReferencesForUser
} from '../mcpGatewayReferenceCleanup'
import { mcpGatewayService } from '../mcpGatewayService'

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

  const client = {
    json: {
      get: vi.fn(async (key: string) => (json.has(key) ? structuredClone(json.get(key)) : null)),
      set: vi.fn(async (key: string, _path: string, value: any) => {
        json.set(key, structuredClone(value))
        return 'OK'
      })
    },
    get: vi.fn(async (key: string) => strings.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      strings.set(key, value)
      return 'OK'
    }),
    sMembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])])
  }

  redisMock.execute.mockImplementation(async (fn: (c: typeof client) => any) => fn(client))

  return { client, json, strings, sets }
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

describe('resolveOrphanToolNames', () => {
  it('collects names from discoveredTools and toolGroupings', () => {
    const names = collectGatewayToolNames(
      gateway(DEAD_GATEWAY, {
        discoveredTools: ['read_file'],
        toolGroupings: [{ mcpName: 'Filesystem', toolIds: ['write_file'] }]
      }) as any
    )
    expect([...names].sort()).toEqual(['read_file', 'write_file'])
  })

  it('keeps a name that a surviving gateway still serves', () => {
    const orphans = resolveOrphanToolNames(
      gateway(DEAD_GATEWAY, { discoveredTools: ['read_file', 'search_docs'] }) as any,
      [gateway(LIVE_GATEWAY, { discoveredTools: ['search_docs'] }) as any]
    )

    // search_docs is still reachable through the live gateway, so removing it
    // from the agent's selections would silently disable a working tool.
    expect([...orphans]).toEqual(['read_file'])
  })
})

describe('sweepGatewayReferencesForUser', () => {
  it('fails closed when the gateway registry cannot be read', async () => {
    const fake = createFakeRedis()
    fake.sets.set('user:josh:agents', ['bob'])
    fake.json.set('agent:bob', { id: 'bob', defaultMCPGateways: [DEAD_GATEWAY] })

    const result = await sweepGatewayReferencesForUser({ userId: 'josh' })

    expect(result.updatedRecordKeys).toEqual([])
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
    fake.client.json.get.mockRejectedValueOnce(new Error('redis exploded'))

    await expect(runGatewayOrphanReferenceCleanup('josh')).resolves.toBeUndefined()
    expect(fake.strings.get(buildGatewayReferenceCleanupKey('josh'))).toBeUndefined()
  })
})
