import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CLI_TOOL_GRID_GROUP_NAME, CLI_TOOL_GRID_ID } from '$lib/utils/toolGridCli'

const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  getUserSettings: vi.fn(),
  execute: vi.fn()
}))

const loadToolsForUserMock = vi.hoisted(() => vi.fn())
const resolveMCPSelectionsMock = vi.hoisted(() => vi.fn())
const listCliToolsMock = vi.hoisted(() => vi.fn())
const resolveCliToolSelectionScopeMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/redis', () => ({
  redis: redisMock
}))

vi.mock('../mcpGatewayDiscovery', () => ({
  mcpGatewayDiscovery: {
    loadToolsForUser: loadToolsForUserMock
  }
}))

vi.mock('../mcpSelectionResolver', () => ({
  resolveMCPSelections: resolveMCPSelectionsMock
}))

vi.mock('../cliToolRegistry', () => ({
  listCliTools: listCliToolsMock,
  resolveCliToolSelectionScope: resolveCliToolSelectionScopeMock
}))

import { buildCompositeKey, buildDynamicMcpIndex } from '../dynamicMcpIndex'

function makeSchema(requiredField: string, optionalField = 'limit') {
  return {
    type: 'object',
    properties: {
      [requiredField]: { type: 'string' },
      [optionalField]: { type: 'integer' }
    },
    required: [requiredField]
  }
}

function mockGatewayTools() {
  loadToolsForUserMock.mockResolvedValue({
    tools: {
      hf_model_info: { description: 'Get model info', inputSchema: makeSchema('model') },
      hf_search: { description: 'Search models', inputSchema: makeSchema('query') },
      hf_whoami: { description: 'Current account', inputSchema: makeSchema('token') }
    },
    metadata: new Map([
      [
        'hf_model_info',
        {
          gatewayId: 'gw_hf',
          gatewayName: 'HuggingFace MCP',
          mcpServerName: 'HuggingFace',
          originalToolName: 'hf_model_info'
        }
      ],
      [
        'hf_search',
        {
          gatewayId: 'gw_hf',
          gatewayName: 'HuggingFace MCP',
          mcpServerName: 'HuggingFace',
          originalToolName: 'hf_search'
        }
      ],
      [
        'hf_whoami',
        {
          gatewayId: 'gw_hf',
          gatewayName: 'HuggingFace MCP',
          mcpServerName: 'HuggingFace',
          originalToolName: 'hf_whoami'
        }
      ]
    ])
  })
}

describe('buildDynamicMcpIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisMock.getUserSettings.mockResolvedValue({
      admin_settings: {
        dcm_tool_name_threshold: 2
      }
    })
    redisMock.execute.mockImplementation(async (callback: (client: unknown) => unknown) =>
      callback({
        json: {
          get: vi.fn().mockResolvedValue({ gateways: [] })
        }
      })
    )
    resolveMCPSelectionsMock.mockResolvedValue({
      resolvedToolSelections: [],
      resolvedGateways: ['gw_hf']
    })
    listCliToolsMock.mockResolvedValue([])
    resolveCliToolSelectionScopeMock.mockImplementation(
      async ({ selectedToolIds }: { selectedToolIds?: string[] }) => ({
        toolIds: Array.isArray(selectedToolIds) ? selectedToolIds : []
      })
    )
  })

  it('collapses inherited MCP groups above the tool-name threshold', async () => {
    mockGatewayTools()

    const result = await buildDynamicMcpIndex({
      userId: 'josh',
      selectedGateways: ['gw_hf'],
      nativeDynamicMcpEnabled: true,
      toolNameThreshold: 2
    })

    expect(result.text).toContain('- HuggingFace (3 tools)')
    expect(result.text).not.toContain('hf_model_info')
    expect(result.text).not.toContain('required: model:string')
  })

  it('passes the active project path into MCP discovery for the DCM index', async () => {
    mockGatewayTools()

    await buildDynamicMcpIndex({
      userId: 'josh',
      selectedGateways: ['gw_hf'],
      projectPath: '/tmp/project-alpha',
      nativeDynamicMcpEnabled: true,
      toolNameThreshold: 2
    })

    expect(loadToolsForUserMock).toHaveBeenCalledWith(
      'josh',
      ['gw_hf'],
      undefined,
      { skipFiltering: true, projectPath: '/tmp/project-alpha' }
    )
  })

  it('shows tool names and hints above the threshold when the agent explicitly asks for them', async () => {
    mockGatewayTools()

    const result = await buildDynamicMcpIndex({
      userId: 'josh',
      selectedGateways: ['gw_hf'],
      nativeDynamicMcpEnabled: true,
      toolNameThreshold: 2,
      dcmDisplaySettings: {
        version: 1,
        groups: {
          [buildCompositeKey('gw_hf', 'HuggingFace')]: 'group+tools+hints'
        },
        tools: {}
      }
    })

    expect(result.text).toContain('- HuggingFace (3 tools):')
    expect(result.text).toContain('  - hf_model_info — required: model:string')
    expect(result.text).toContain('  - hf_search — required: query:string')
    expect(result.text).toContain('  - hf_whoami — required: token:string')
  })

  it('shows CLI tool names and hints above the threshold when the agent explicitly asks for them', async () => {
    resolveMCPSelectionsMock.mockResolvedValue({
      resolvedToolSelections: [],
      resolvedGateways: []
    })
    listCliToolsMock.mockResolvedValue([
      {
        toolId: 'crawl4ai',
        title: 'Crawl4AI',
        description: 'Crawl a URL',
        status: 'active',
        inputSchema: makeSchema('url', 'maxPages')
      },
      {
        toolId: 'local_screenshot',
        title: 'Local Screenshot',
        description: 'Capture a screenshot',
        status: 'active',
        inputSchema: makeSchema('outputPath')
      },
      {
        toolId: 'repo_snapshot',
        title: 'Repo Snapshot',
        description: 'Summarize a repo',
        status: 'active',
        inputSchema: makeSchema('path')
      }
    ])

    const result = await buildDynamicMcpIndex({
      userId: 'josh',
      nativeDynamicMcpEnabled: false,
      selectedCliToolIds: ['crawl4ai', 'local_screenshot', 'repo_snapshot'],
      cliToolsEnabled: true,
      toolNameThreshold: 2,
      dcmDisplaySettings: {
        version: 1,
        groups: {
          [buildCompositeKey(CLI_TOOL_GRID_ID, CLI_TOOL_GRID_GROUP_NAME)]: 'group+tools+hints'
        },
        tools: {}
      }
    })

    expect(result.text).toContain(`- ${CLI_TOOL_GRID_GROUP_NAME} (3 tools):`)
    expect(result.text).toContain('  - crawl4ai — Crawl4AI — Crawl a URL — url:string*, maxPages:integer')
    expect(result.text).toContain(
      '  - local_screenshot — Local Screenshot — Capture a screenshot — outputPath:string*'
    )
    expect(result.text).toContain('  - repo_snapshot — Repo Snapshot — Summarize a repo — path:string*')
  })
})
