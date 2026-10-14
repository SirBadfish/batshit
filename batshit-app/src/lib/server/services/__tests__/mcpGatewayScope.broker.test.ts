import { beforeEach, describe, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ discovered: [] as string[][], executed: [] as string[] }))
vi.mock('../mcpGatewayDiscovery', () => ({ mcpGatewayDiscovery: {
  loadToolsForUser: vi.fn(async (_user: string, ids?: string[]) => {
    calls.discovered.push(ids ?? ['UNSCOPED'])
    const tools: Record<string, any> = {}; const metadata = new Map()
    for (const id of ids ?? []) {
      const name = `mcp_${id}_probe`
      tools[name] = { description: `Probe ${id}`, inputSchema: { type: 'object', properties: {} }, execute: async () => { calls.executed.push(id); return { content: [{ type: 'text', text: id }] } } }
      metadata.set(name, { gatewayId: id, gatewayName: id, originalToolName: 'probe', mcpServerName: id })
    }
    return { tools, metadata }
  })
} }))
vi.mock('$lib/server/artifacts/artifactsService', () => ({ ArtifactsService: class { async listByUser() { return [] } } }))
import { redis } from '$lib/server/redis'
import { nativeToolService } from '../nativeTools'
import { useControl } from '../fabricRegistry'
const owner = { userId: 'broker-gateway-user', agentId: 'broker-gateway-agent', sessionId: 'broker-gateway-chat' }
const settings = { nativeTools: { dynamicMcpEnabled: true, batshitToolsEnabled: true, cliToolsEnabled: false, artifactRuntimeEnabled: false, fetchZipEnabled: false, agentBrowserEnabled: false, webSearchEnabled: false, bashEnabled: false } }
beforeEach(async () => {
  calls.discovered.length = 0; calls.executed.length = 0
  await redis.set(`agent:${owner.agentId}`, { id: owner.agentId, user_id: owner.userId, defaultMCPGateways: ['saved'], provider_specific_settings: settings } as any)
})
describe('MCP scope across API broker and Fabric', () => {
  it('API executes a human-selected wider snapshot but ignores forged authority', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({ ...owner, selectedGateways: ['extra'], selectedCliToolIds: [], providerSettings: settings } as any)
    await tools.native_batshit_tool_use.execute({ ref: 'mcp:mcp_extra_probe', input: {}, mcpGatewayScope: ['forbidden'] })
    expect(calls.executed).toEqual(['extra'])
    await tools.native_batshit_tool_use.execute({ ref: 'mcp:mcp_forbidden_probe', input: {}, selectedGateways: ['forbidden'], mcpGatewayScope: ['forbidden'] })
    expect(calls.executed).toEqual(['extra']); expect(calls.discovered.flat()).not.toContain('forbidden')
  })
  it('API honors an empty filter, including brokered Fabric MCP calls', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({ ...owner, selectedGateways: ['extra'], selectedCliToolIds: [], providerSettings: settings } as any)
    await tools.native_batshit_tool_use.execute({ ref: 'mcp:mcp_extra_probe', input: {}, selectedGateways: [] })
    await tools.native_batshit_tool_use.execute({ ref: 'fabric:sys.mcp.dynamic.use', input: { toolName: 'mcp_extra_probe' }, selectedGateways: [] })
    expect(calls.executed).toEqual([]); expect(calls.discovered.every(ids => ids.length === 0)).toBe(true)
  })
  it('an API run with no bound scope cannot reload saved defaults', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({ ...owner, selectedCliToolIds: [], providerSettings: settings } as any)
    await tools.native_batshit_tool_use.execute({ ref: 'mcp:mcp_saved_probe', input: {} })
    expect(calls.executed).toEqual([]); expect(calls.discovered.flat()).toEqual([])
  })
  it('Fabric intersects both outer and inner caller filters with its scope', async () => {
    await useControl({ ...owner, actorType: 'agent', runtimeMode: 'mode4', controlId: 'sys.mcp.dynamic.use', mcpGatewayScope: ['extra'], selectedGateways: [], input: { toolName: 'mcp_extra_probe', selectedGateways: ['extra'], mcpGatewayScope: ['forbidden'] } })
    expect(calls.executed).toEqual([])
    await useControl({ ...owner, actorType: 'agent', runtimeMode: 'mode4', controlId: 'sys.mcp.dynamic.use', mcpGatewayScope: ['extra'], input: { toolName: 'mcp_extra_probe', selectedGateways: ['extra', 'forbidden'] } })
    expect(calls.executed).toEqual(['extra']); expect(calls.discovered.flat()).not.toContain('forbidden')
  })
  it('an old managed caller cannot borrow saved defaults through Fabric', async () => {
    await useControl({ ...owner, actorType: 'agent', runtimeMode: 'mode4', controlId: 'sys.mcp.dynamic.use', input: { toolName: 'mcp_saved_probe', selectedGateways: ['saved'] } })
    expect(calls.executed).toEqual([]); expect(calls.discovered.flat()).toEqual([])
  })
})
