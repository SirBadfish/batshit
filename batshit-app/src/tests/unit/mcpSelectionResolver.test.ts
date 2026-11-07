import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mergeToolSelections,
  resolveDynamicMcpGatewayScope,
  resolveMCPSelections,
  __testUtils
} from '$lib/server/services/mcpSelectionResolver'
import type { MCPToolSelections } from '$lib/types/database'
import { redis } from '$lib/server/redis'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { mcpGatewayDiscovery } from '$lib/server/services/mcpGatewayDiscovery'
import { captureP5OriginalLookup, prepareP5OriginalTask, recordP5ResolvedApiScope, bindP5ApiReplyPart, sealP5OriginalPreparation, retireP5OriginalPreparation, type P5OriginalPreparation } from '$lib/server/services/appActions/mcp/originalTask'
import { withSettingsRecordReplacement } from '$lib/server/services/appActions/settings/lifecycle'
import { registerSessionTurn, stopSessionTurn, __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve: vi.fn(async () => null) } }))

vi.mock('$lib/server/redis', () => ({
  redis: {
    get: vi.fn(),
    execute: vi.fn(async (operation: (client: any) => Promise<unknown>) => operation({ get: async () => 'existing-migration-marker' }))
  }
}))

vi.mock('$lib/server/services/mcpGatewayService', () => ({
  mcpGatewayService: {
    listEnabled: vi.fn()
  }
}))

const { sanitizeStringArray, normalizeToolSelectionsInput } = __testUtils

describe('real resolver original tool ceiling before discovery', () => {
  let apiPreparation: P5OriginalPreparation | undefined
  const owner = { userId: 'ceiling-user', agentId: 'ceiling-agent', sessionId: 'ceiling-chat' }
  beforeEach(() => {
    __resetStreamAbortRegistryForTests()
    vi.mocked(mcpGatewayService.listEnabled).mockResolvedValue([{ id: 'A', name: 'Synthetic A', type: 'custom', enabled: true } as any])
  })
  afterEach(async () => {
    if (apiPreparation) { await sealP5OriginalPreparation(apiPreparation); retireP5OriginalPreparation(apiPreparation); apiPreparation = undefined }
    __resetStreamAbortRegistryForTests(); vi.restoreAllMocks()
  })
  function apiOriginal(tools: string[]) {
    const registration = registerSessionTurn(owner.sessionId, 'single', 'reply')
    if (!registration.ok) throw new Error('API registration refused')
    const agent = { id: owner.agentId, user_id: owner.userId, agentType: 'api' }
    apiPreparation = prepareP5OriginalTask(captureP5OriginalLookup(owner), { ...owner, agent,
      session: { id: owner.sessionId, user_id: owner.userId }, turn: registration.entry })
    if (!apiPreparation) throw new Error('API preparation refused')
    recordP5ResolvedApiScope(apiPreparation, { gateways: ['A'], tools })
    expect(bindP5ApiReplyPart(apiPreparation, { replyId: 'reply', version: 0 })).toBeDefined()
    return apiPreparation // Actual owner DATA; no SDK/run/known-save certificate.
  }
  function lowLevel() {
    return vi.spyOn(mcpGatewayDiscovery, 'discoverFromMultipleGateways').mockResolvedValue([
      { gatewayId: 'A', success: true, tools: [{ name: 'old-tool' }, { name: 'fresh-tool' }] } as any
    ])
  }
  const options = () => ({ ...owner, agent: { id: owner.agentId, user_id: owner.userId, agentType: 'cli',
    defaultMCPToolSelections: ['fresh-tool'] } as any, selectedGateways: ['A'], toolSelections: [], includeGatewayToolMap: true })

  it('keeps absent-bound ordinary empty-override/default semantics unchanged', async () => {
    const discover = lowLevel()
    const result = await resolveMCPSelections(options())
    expect(result.resolvedToolSelections).toEqual(['fresh-tool'])
    expect(result.gatewayToolMap).toEqual({ A: ['fresh-tool'] })
    expect(discover).toHaveBeenCalledOnce()
  })
  it('preserves the genuine API original[] after ordinary normalization and before discovery', async () => {
    const discover = lowLevel(), input = options()
    input.agent.agentType = 'api'
    const result = await resolveMCPSelections({ ...input, mcpOriginalPreparation: apiOriginal([]) })
    expect(result.resolvedToolSelections).toEqual([])
    expect(result.gatewayToolMap).toEqual({})
    expect(discover).not.toHaveBeenCalled()
  })
  it('intersects the genuine nonempty API owner before the actual gateway map', async () => {
    const discover = lowLevel(), input = options(), map = vi.spyOn(mcpGatewayDiscovery, 'buildGatewayToolMap')
    input.agent.agentType = 'api'; input.agent.defaultMCPToolSelections = ['old-tool', 'fresh-tool']
    const result = await resolveMCPSelections({ ...input, toolSelections: undefined, mcpOriginalPreparation: apiOriginal(['old-tool']) })
    expect(result.resolvedToolSelections).toEqual(['old-tool'])
    expect(map.mock.calls[0][0].toolSelections).toEqual(['old-tool'])
    expect(result.gatewayToolMap).toEqual({ A: ['old-tool'] })
    expect(discover).toHaveBeenCalledOnce()
  })
  it.each(['forged', 'retired', 'Stop', 'replacement', 'foreign-user', 'foreign-agent'] as const)(
    'refuses a present %s API owner before map or discovery', async boundary => {
      const discover = lowLevel(), map = vi.spyOn(mcpGatewayDiscovery, 'buildGatewayToolMap'), input = options()
      input.agent.agentType = 'api'
      const bound = boundary === 'forged' ? {} as P5OriginalPreparation : apiOriginal([])
      if (boundary === 'retired') retireP5OriginalPreparation(bound)
      if (boundary === 'Stop') expect(stopSessionTurn(owner.sessionId, 'Actual owner Stop before discovery')).toBe(true)
      if (boundary === 'replacement') await withSettingsRecordReplacement(`agent:${owner.agentId}`, async () => {})
      if (boundary === 'foreign-user') { input.userId = 'other-user'; input.agent.user_id = 'other-user' }
      if (boundary === 'foreign-agent') { input.agentId = 'other-agent'; input.agent.id = 'other-agent' }
      await expect(resolveMCPSelections({ ...input, mcpOriginalPreparation: bound })).rejects.toMatchObject({
        code: boundary === 'replacement' ? 'SETTINGS_LIFECYCLE_CHANGED' : 'P5_ORIGINAL_BOOT_READ_REFUSED'
      })
      expect(map).not.toHaveBeenCalled(); expect(discover).not.toHaveBeenCalled()
    }
  )
  it('keeps absent API-owner ordinary results byte-identical', async () => {
    lowLevel()
    const ordinary = await resolveMCPSelections(options())
    const absent = await resolveMCPSelections({ ...options(), mcpOriginalPreparation: undefined })
    expect(JSON.stringify(absent)).toBe(JSON.stringify(ordinary))
    expect(absent.resolvedToolSelections).toEqual(['fresh-tool'])
  })
})

describe('mcpSelectionResolver utils', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(redis.get).mockResolvedValue(null as any)
    vi.mocked(mcpGatewayService.listEnabled).mockResolvedValue([])
  })

  it('sanitizes gateway arrays and preserves explicit disable', () => {
    expect(sanitizeStringArray([' gateway-1 ', 'gateway-1', 'G2'])).toEqual(['gateway-1', 'G2'])
    expect(sanitizeStringArray('foo')).toBeUndefined()
    expect(sanitizeStringArray([])).toEqual([])
  })

  it('normalizes tool selections with undefined and empty arrays (flat model)', () => {
    const source: MCPToolSelections = {
      alpha: {
        redis: [' get ', 'set', ''],
        github: undefined
      },
      beta: {
        tavily: []
      }
    }

    // Legacy nested objects flatten to a deduped array
    expect(normalizeToolSelectionsInput(source)).toEqual(['get', 'set'])

    expect(normalizeToolSelectionsInput(undefined)).toBeUndefined()
  })

  it('merges default and override tool selections (flat array)', () => {
    const defaults: MCPToolSelections = ['get', 'set']
    const overrides: MCPToolSelections = ['set', 'del']

    expect(mergeToolSelections(defaults, overrides)).toEqual(['del', 'set'])
  })

  it('treats empty override arrays as explicit clear', () => {
    const defaults: MCPToolSelections = ['get', 'set']
    const overrides: MCPToolSelections = []

    expect(mergeToolSelections(defaults, overrides)).toEqual([])
  })

  it('cannot widen a missing agent scope with caller-selected gateways', async () => {
    const result = await resolveDynamicMcpGatewayScope({
      userId: 'josh',
      agentId: 'agent_1',
      selectedGateways: [' gw_1 ', 'gw_1', 'gw_2']
    })

    expect(result).toEqual({
      resolvedGateways: [],
      defaultGateways: [],
      source: 'agent'
    })
    expect(mcpGatewayService.listEnabled).not.toHaveBeenCalled()
  })

  it('uses a trusted run snapshot even when it is wider than agent defaults, then narrows it', async () => {
    const result = await resolveDynamicMcpGatewayScope({
      userId: 'josh',
      agentId: 'agent_1',
      mcpGatewayScope: [' gw_1 ', 'gw_2', 'gw_1'],
      selectedGateways: ['gw_2', 'unbound']
    })

    expect(result).toEqual({
      resolvedGateways: ['gw_2'],
      defaultGateways: null,
      source: 'selected'
    })
    expect(redis.get).not.toHaveBeenCalled()
  })

  it('treats empty, null, and malformed bound scopes as disable-all, even with caller selections', async () => {
    for (const mcpGatewayScope of [[], null, 'gw_1' as any]) {
      const result = await resolveDynamicMcpGatewayScope({
        userId: 'josh',
        mcpGatewayScope,
        selectedGateways: ['gw_1']
      })
      expect(result.resolvedGateways).toEqual([])
      expect(result.source).toBe('selected')
    }
    expect(mcpGatewayService.listEnabled).not.toHaveBeenCalled()
  })

  it('resolves agent default gateways when no explicit selection is passed', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      id: 'agent_1',
      user_id: 'josh',
      defaultMCPGateways: ['gw_agent_a', 'gw_agent_b']
    } as any)

    const result = await resolveDynamicMcpGatewayScope({
      userId: 'josh',
      agentId: 'agent_1'
    })

    expect(result).toEqual({
      resolvedGateways: ['gw_agent_a', 'gw_agent_b'],
      defaultGateways: ['gw_agent_a', 'gw_agent_b'],
      source: 'agent'
    })
  })

  it('treats the caller list as an intersection of owned agent defaults', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      id: 'agent_1',
      user_id: 'josh',
      defaultMCPGateways: ['gw_agent_a', 'gw_agent_b']
    } as any)

    const result = await resolveDynamicMcpGatewayScope({
      userId: 'josh',
      agentId: 'agent_1',
      selectedGateways: ['gw_agent_b', 'gw_foreign']
    })
    expect(result.resolvedGateways).toEqual(['gw_agent_b'])
    expect(result.defaultGateways).toEqual(['gw_agent_a', 'gw_agent_b'])
  })

  it('resolves empty agent defaults as explicit disable-all scope', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      id: 'agent_1',
      user_id: 'josh',
      defaultMCPGateways: []
    } as any)

    const result = await resolveDynamicMcpGatewayScope({
      userId: 'josh',
      agentId: 'agent_1'
    })

    expect(result).toEqual({
      resolvedGateways: [],
      defaultGateways: [],
      source: 'agent'
    })
  })

  it('does not widen an agent-scoped request to all global gateways when no agent defaults are saved', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      id: 'agent_1',
      user_id: 'josh'
    } as any)
    vi.mocked(mcpGatewayService.listEnabled).mockResolvedValue([{ id: 'gw_global' }] as any)

    const result = await resolveDynamicMcpGatewayScope({
      userId: 'josh',
      agentId: 'agent_1'
    })

    expect(result).toEqual({
      resolvedGateways: [],
      defaultGateways: [],
      source: 'agent'
    })
    expect(mcpGatewayService.listEnabled).not.toHaveBeenCalled()
  })

  it('refuses a foreign agent record and foreign metadata before reading defaults', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      id: 'agent_1',
      user_id: 'someone_else',
      defaultMCPGateways: ['gw_foreign']
    } as any)
    await expect(resolveDynamicMcpGatewayScope({
      userId: 'josh',
      agentId: 'agent_1',
      selectedGateways: ['gw_foreign']
    })).rejects.toThrow('not owned')

    vi.mocked(redis.get).mockResolvedValue(null as any)
    await expect(resolveDynamicMcpGatewayScope({
      userId: 'josh',
      agentMetadata: { user_id: 'someone_else', defaultMCPGateways: ['gw_foreign'] }
    })).rejects.toThrow('not owned')
    await expect(resolveDynamicMcpGatewayScope({
      userId: 'josh',
      agent: { id: 'agent_1', user_id: 'someone_else' } as any,
      mcpGatewayScope: ['gw_foreign']
    })).rejects.toThrow('not owned')
    expect(mcpGatewayService.listEnabled).not.toHaveBeenCalled()
  })

  it('falls back to user-global enabled gateways when agent scope is unavailable', async () => {
    vi.mocked(mcpGatewayService.listEnabled).mockResolvedValue([
      { id: 'gw_global_a' },
      { id: 'gw_global_b' },
      { id: 'gw_global_a' }
    ] as any)

    const result = await resolveDynamicMcpGatewayScope({
      userId: 'josh'
    })

    expect(result).toEqual({
      resolvedGateways: ['gw_global_a', 'gw_global_b'],
      defaultGateways: null,
      source: 'user-global'
    })
  })

  it('treats explicit null metadata as scoped missing, while omitted metadata allows user-global', async () => {
    vi.mocked(mcpGatewayService.listEnabled).mockResolvedValue([
      { id: 'gw_global_a' },
      { id: 'gw_global_b' }
    ] as any)
    expect((await resolveDynamicMcpGatewayScope({
      userId: 'josh',
      agentMetadata: null,
      selectedGateways: ['gw_global_b', 'gw_not_enabled']
    })).resolvedGateways).toEqual([])
    expect(mcpGatewayService.listEnabled).not.toHaveBeenCalled()
    expect((await resolveDynamicMcpGatewayScope({
      userId: 'josh',
      selectedGateways: ['gw_global_b', 'gw_not_enabled']
    })).resolvedGateways).toEqual(['gw_global_b'])
    expect((await resolveDynamicMcpGatewayScope({
      userId: 'josh',
      selectedGateways: []
    })).resolvedGateways).toEqual([])
  })
})
