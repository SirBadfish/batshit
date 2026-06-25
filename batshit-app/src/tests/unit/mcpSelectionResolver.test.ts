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

  it('resolves explicit selected gateways first', async () => {
    const result = await resolveDynamicMcpGatewayScope({
      userId: 'josh',
      agentId: 'agent_1',
      selectedGateways: [' gw_1 ', 'gw_1', 'gw_2']
    })

    expect(result).toEqual({
      resolvedGateways: ['gw_1', 'gw_2'],
      defaultGateways: null,
      source: 'selected'
    })
  })

  it('resolves agent default gateways when no explicit selection is passed', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      id: 'agent_1',
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

  it('resolves empty agent defaults as explicit disable-all scope', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      id: 'agent_1',
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
      id: 'agent_1'
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
})
