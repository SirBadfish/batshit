import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  mergeToolSelections,
  resolveDynamicMcpGatewayScope,
  __testUtils
} from '$lib/server/services/mcpSelectionResolver'
import type { MCPToolSelections } from '$lib/types/database'
import { redis } from '$lib/server/redis'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'

vi.mock('$lib/server/redis', () => ({
  redis: {
    get: vi.fn()
  }
}))

vi.mock('$lib/server/services/mcpGatewayService', () => ({
  mcpGatewayService: {
    listEnabled: vi.fn()
  }
}))

const { sanitizeStringArray, normalizeToolSelectionsInput } = __testUtils

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
