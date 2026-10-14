import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisGet = vi.hoisted(() => vi.fn())
const listEnabled = vi.hoisted(() => vi.fn())
const loadToolsForUser = vi.hoisted(() => vi.fn())
const executeG1 = vi.hoisted(() => vi.fn())
const executeG2 = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/redis', () => ({ redis: { get: redisGet } }))
vi.mock('../mcpGatewayService', () => ({ mcpGatewayService: { listEnabled } }))
vi.mock('../mcpGatewayDiscovery', () => ({ mcpGatewayDiscovery: { loadToolsForUser } }))
vi.mock('../dynamicMcpVisibility', () => ({
  resolveAgentDcmDisplaySettings: vi.fn(async () => null),
  resolveGatewayDisplayDefaults: vi.fn(async () => new Map()),
  resolveMcpToolDcmVisibility: vi.fn(() => ({ isToolDiscoverable: true }))
}))
vi.mock('../nativeToolConstants', () => ({ shouldHideInternalMcpTool: vi.fn(() => false) }))

import {
  executeDynamicMcpFind,
  executeDynamicMcpUse,
  loadDynamicMcpGatewayTools,
  type GatewayToolsCache
} from '../dynamicMcpTools'

describe('shared Dynamic MCP gateway scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisGet.mockResolvedValue({ id: 'agent_1', user_id: 'josh', defaultMCPGateways: ['g1'] })
    listEnabled.mockResolvedValue([{ id: 'g1' }, { id: 'g2' }])
    executeG1.mockResolvedValue('g1-result')
    executeG2.mockResolvedValue('g2-result')
    loadToolsForUser.mockImplementation(async (_userId: string, gatewayIds: string[]) => {
      const tools: Record<string, any> = {}
      const metadata = new Map<string, any>()
      for (const gatewayId of gatewayIds) {
        const execute = gatewayId === 'g1' ? executeG1 : executeG2
        const name = `${gatewayId}_tool`
        tools[name] = { description: `${gatewayId} tool`, execute }
        metadata.set(name, {
          gatewayId,
          gatewayName: gatewayId,
          mcpServerName: gatewayId,
          originalToolName: name
        })
      }
      return { tools, metadata }
    })
  })

  it('does not discover or execute a caller-selected gateway outside the agent scope', async () => {
    const found = await executeDynamicMcpFind({
      userId: 'josh', agentId: 'agent_1', selectedGateways: ['g2']
    })
    expect(found.results).toEqual([])
    expect(loadToolsForUser).toHaveBeenCalledWith(
      'josh', [], undefined, { skipFiltering: true, projectPath: null }
    )

    const used = await executeDynamicMcpUse({
      userId: 'josh', agentId: 'agent_1', selectedGateways: ['g2'], toolName: 'g2_tool'
    })
    expect(used.success).toBe(false)
    expect(executeG2).not.toHaveBeenCalled()
  })

  it('keys cached discovery by the bound snapshot and preserves an explicit empty filter', async () => {
    const cache: GatewayToolsCache = new Map()
    const common = {
      userId: 'josh', agentId: 'agent_1', selectedGateways: ['g2'], gatewayToolsCache: cache
    }
    const closed = await executeDynamicMcpFind({ ...common, mcpGatewayScope: ['g1'] })
    expect(closed.results).toEqual([])
    const open = await executeDynamicMcpFind({ ...common, mcpGatewayScope: ['g2'] })
    expect(open.results.map((entry: any) => entry.toolName)).toEqual(['g2_tool'])
    expect(cache.size).toBe(2)
    expect(loadToolsForUser).toHaveBeenNthCalledWith(
      1, 'josh', [], undefined, { skipFiltering: true, projectPath: null }
    )
    expect(loadToolsForUser).toHaveBeenNthCalledWith(
      2, 'josh', ['g2'], undefined, { skipFiltering: true, projectPath: null }
    )

    const used = await executeDynamicMcpUse({
      ...common, mcpGatewayScope: ['g2'], toolName: 'g2_tool'
    })
    expect(used).toMatchObject({ success: true, result: 'g2-result' })
    expect(executeG2).toHaveBeenCalledTimes(1)
    expect(loadToolsForUser).toHaveBeenCalledTimes(2)

    const disabled = await executeDynamicMcpFind({
      ...common, mcpGatewayScope: ['g2'], selectedGateways: []
    })
    expect(disabled.results).toEqual([])
    expect(cache.size).toBe(3)
  })

  it('does not reuse user-global cached tools for explicit missing actor metadata', async () => {
    const cache: GatewayToolsCache = new Map()
    const common = { userId: 'josh', cache }
    const global = await loadDynamicMcpGatewayTools(common)
    expect(Object.keys(global.tools)).toEqual(['g1_tool', 'g2_tool'])
    const missingActor = await loadDynamicMcpGatewayTools({ ...common, agentMetadata: null })
    expect(Object.keys(missingActor.tools)).toEqual([])
    expect(cache.size).toBe(2)
    expect(loadToolsForUser).toHaveBeenNthCalledWith(
      2, 'josh', [], undefined, { skipFiltering: true, projectPath: null }
    )
  })
})
