import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-120 P1 — `buildDynamicMcpIndex().discoverable`: the typed refs the Judge Juice hint
 * lane judges over. It must follow discoverability (not the collapsed DCM text), keep
 * enabled MCP tools flagged, and carry the same hints the text would show.
 */

const redisMock = vi.hoisted(() => ({ get: vi.fn(), getUserSettings: vi.fn(), execute: vi.fn() }))
const loadToolsForUserMock = vi.hoisted(() => vi.fn())
const resolveMCPSelectionsMock = vi.hoisted(() => vi.fn())
const listCliToolsMock = vi.hoisted(() => vi.fn())
const resolveCliToolSelectionScopeMock = vi.hoisted(() => vi.fn())
const listVisibleControlsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/redis', () => ({ redis: redisMock }))
vi.mock('../mcpGatewayDiscovery', () => ({ mcpGatewayDiscovery: { loadToolsForUser: loadToolsForUserMock } }))
vi.mock('../mcpSelectionResolver', () => ({ resolveMCPSelections: resolveMCPSelectionsMock }))
vi.mock('../cliToolRegistry', () => ({ listCliTools: listCliToolsMock, resolveCliToolSelectionScope: resolveCliToolSelectionScopeMock }))
vi.mock('../fabricRegistry', () => ({ listVisibleControls: listVisibleControlsMock }))

import { buildDynamicMcpIndex } from '../dynamicMcpIndex'

function schema(required: string) {
  return { type: 'object', properties: { [required]: { type: 'string' } }, required: [required] }
}

describe('buildDynamicMcpIndex discoverable refs (SA-120 P1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisMock.getUserSettings.mockResolvedValue({ admin_settings: { dcm_tool_name_threshold: 2 } })
    redisMock.execute.mockImplementation(async (callback: (client: unknown) => unknown) =>
      callback({ json: { get: vi.fn().mockResolvedValue({ gateways: [] }) } })
    )
    resolveMCPSelectionsMock.mockResolvedValue({ resolvedToolSelections: ['hf_search'], resolvedGateways: ['gw_hf'] })
    loadToolsForUserMock.mockResolvedValue({
      tools: {
        hf_model_info: { description: 'Get model info', inputSchema: schema('model') },
        hf_search: { description: 'Search models', inputSchema: schema('query') },
        hf_whoami: { description: 'Current account', inputSchema: schema('token') }
      },
      metadata: new Map(
        ['hf_model_info', 'hf_search', 'hf_whoami'].map((name) => [
          name,
          { gatewayId: 'gw_hf', gatewayName: 'HuggingFace MCP', mcpServerName: 'HuggingFace', originalToolName: name }
        ])
      )
    })
    listCliToolsMock.mockResolvedValue([
      { toolId: 'ffmpeg', status: 'active', title: 'ffmpeg', description: 'Convert media', inputSchema: schema('input') }
    ])
    resolveCliToolSelectionScopeMock.mockResolvedValue({ toolIds: ['ffmpeg'] })
    listVisibleControlsMock.mockResolvedValue([
      { controlId: 'sys.memory.save', title: 'Save memory', schemaHint: 'lane, content' }
    ])
  })

  it('lists every discoverable ref even when the text collapsed the group, flags enabled MCP tools, and keeps hints', async () => {
    const result = await buildDynamicMcpIndex({
      userId: 'josh',
      selectedGateways: ['gw_hf'],
      nativeDynamicMcpEnabled: true,
      toolNameThreshold: 1,
      runtime: 'api'
    })

    // The text collapses HuggingFace (2 unenabled tools > threshold 1) and never names them…
    expect(result.text).toContain('HuggingFace (')
    expect(result.text).not.toContain('hf_model_info')
    // …but the discoverable list carries all three, with the enabled one flagged.
    const mcp = result.discoverable.filter((entry) => entry.family === 'mcp')
    expect(mcp.map((entry) => entry.ref).sort()).toEqual(['mcp:hf_model_info', 'mcp:hf_search', 'mcp:hf_whoami'])
    expect(mcp.find((entry) => entry.name === 'hf_search')).toMatchObject({ enabled: true, description: 'Search models', hint: 'required: query:string', group: 'HuggingFace' })
    expect(mcp.find((entry) => entry.name === 'hf_whoami')?.enabled).toBe(false)

    expect(result.discoverable.find((entry) => entry.ref === 'cli:ffmpeg')).toMatchObject({ family: 'cli', description: 'ffmpeg — Convert media', hint: 'required: input:string' })
    expect(result.discoverable.find((entry) => entry.ref === 'fabric:sys.memory.save')).toMatchObject({ family: 'fabric', hint: 'Save memory — lane, content' })
    expect(result.resolvedGatewayIds).toEqual(['gw_hf'])
  })

  it('returns an empty list and null gateways when no family is reachable', async () => {
    resolveMCPSelectionsMock.mockResolvedValue({ resolvedToolSelections: [], resolvedGateways: [] })
    listCliToolsMock.mockResolvedValue([])
    const result = await buildDynamicMcpIndex({
      userId: 'josh',
      nativeDynamicMcpEnabled: false,
      cliToolsEnabled: false,
      brokerToggles: {
        fetchZipEnabled: false, dynamicMcpEnabled: false, cliToolsEnabled: false,
        artifactRuntimeEnabled: false, batshitToolsEnabled: false, agentBrowserEnabled: false
      },
      runtime: 'api'
    })
    expect(result.discoverable).toEqual([])
    expect(result.resolvedGatewayIds).toBeNull()
  })
  it('keeps an authorized utility discoverable while retired Fabric presentation choices leave its fixed line unchanged', async () => {
    listVisibleControlsMock.mockResolvedValue([{ controlId: 'sys.judge.ask', title: 'Ask Judge Juice', schemaHint: 'state, questions' }])
    const options = { userId: 'josh', nativeDynamicMcpEnabled: false, cliToolsEnabled: false, runtime: 'api' as const, allowFabricControlTools: false, judgeControlsEnabled: true,
      brokerToggles: { fetchZipEnabled: false, dynamicMcpEnabled: false, cliToolsEnabled: false, artifactRuntimeEnabled: false, batshitToolsEnabled: true, agentBrowserEnabled: false } }
    const expected = [expect.objectContaining({ ref: 'batshit:sys.judge.ask', family: 'batshit', group: 'Fabric & Utilities', hint: 'Ask Judge Juice — state, questions' })]
    let fixedLine: string | undefined
    for (const mode of ['hidden', 'group-only', 'group+tools+names', 'group+tools+hints'] as const) {
      const result = await buildDynamicMcpIndex({ ...options, dcmDisplaySettings: { version: 1, groups: { '__fabric_controls__::Fabric Controls': mode }, tools: {} } })
      expect(result.text).toContain('Fabric & Utilities')
      expect(result.discoverable).toEqual(expected)
      expect(result.text).not.toContain('sys.judge.ask')
      expect(result.text).not.toContain('state, questions')
      fixedLine ??= result.text
      expect(result.text).toBe(fixedLine)
    }
    const hiddenTool = await buildDynamicMcpIndex({ ...options, dcmDisplaySettings: { version: 1, groups: { '__fabric_controls__::Fabric Controls': 'group+tools+hints' }, tools: { '__fabric_controls__::sys.judge.ask': 'hidden' } } })
    expect(hiddenTool.discoverable).toEqual(expected)
    expect(hiddenTool.text).toBe(fixedLine)
    // Actual capability switches still decide reachability; a presentation choice never grants it.
    for (const [judgeControlsEnabled, batshitToolsEnabled] of [[false, true], [true, false], [false, false]] as const) {
      const disabled = await buildDynamicMcpIndex({ ...options, judgeControlsEnabled,
        brokerToggles: { ...options.brokerToggles, batshitToolsEnabled } })
      expect(disabled.discoverable).toEqual([])
      expect(disabled.text).toBe('')
    }
  })

})
