import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CLI_TOOL_GRID_GROUP_NAME, CLI_TOOL_GRID_ID } from '$lib/utils/toolGridCli'
import { isControlIdAllowedByList } from '$lib/utils/brokerAvailability'
import {
  ARTIFACT_TOOL_GRID_GROUP_NAME,
  ARTIFACT_TOOL_GRID_ID,
  FABRIC_TOOL_GRID_GROUP_NAME,
  FABRIC_TOOL_GRID_ID
} from '$lib/utils/toolGridBrokerFamilies'

const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  getUserSettings: vi.fn(),
  execute: vi.fn()
}))

const loadToolsForUserMock = vi.hoisted(() => vi.fn())
const resolveMCPSelectionsMock = vi.hoisted(() => vi.fn())
const listCliToolsMock = vi.hoisted(() => vi.fn())
const resolveCliToolSelectionScopeMock = vi.hoisted(() => vi.fn())
const listVisibleControlsMock = vi.hoisted(() => vi.fn())

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

vi.mock('../fabricRegistry', () => ({
  listVisibleControls: listVisibleControlsMock
}))

import { UNKNOWN_GATEWAY, buildCompositeKey, buildDynamicMcpIndex } from '../dynamicMcpIndex'
import {
  RESERVED_TOOL_GRID_IDS,
  extractGatewayIdFromCompositeKey
} from '../mcpGatewayReferenceCleanup'

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

// SA-096 P6: `mcpGatewayReferenceCleanup` restates the composite-key separator
// and the unknown-gateway placeholder because importing this module would create
// a cycle. These pin the two copies together from the side that can see both.
describe('composite key contract shared with mcpGatewayReferenceCleanup', () => {
  it('extracts the gateway ID from a key this module built', () => {
    expect(extractGatewayIdFromCompositeKey(buildCompositeKey('gw_hf', 'HuggingFace'))).toBe(
      'gw_hf'
    )
  })

  it('reserves the unknown-gateway placeholder this module assigns', () => {
    expect(RESERVED_TOOL_GRID_IDS.has(UNKNOWN_GATEWAY)).toBe(true)
  })
})

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
    listVisibleControlsMock.mockResolvedValue([])
    // BL-686: the index hands its caller's server-resolved list over as `cliToolScope`.
    resolveCliToolSelectionScopeMock.mockImplementation(
      async ({ cliToolScope }: { cliToolScope?: string[] }) => ({
        toolIds: Array.isArray(cliToolScope) ? cliToolScope : []
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

  /**
   * SA-096 P4 — the Fabric and Artifact families in the capability index.
   *
   * The defect that opened this story was a `tool_discovery` header with nothing under it
   * while the broker had a live ~41-control Fabric surface. These cover the four index
   * states the packet names: fabric-only, artifact-only, mixed, and fully empty.
   */
  describe('broker families', () => {
    const ALL_BROKER_OFF = {
      fetchZipEnabled: false,
      dynamicMcpEnabled: false,
      cliToolsEnabled: false,
      artifactRuntimeEnabled: false,
      batshitToolsEnabled: false,
      agentBrowserEnabled: false
    }

    function fabricControl(controlId: string, title: string) {
      return {
        controlId,
        sourceType: 'core' as const,
        title,
        description: '',
        schemaHint: 'no input',
        riskLevel: 'safe' as const,
        artifactId: null
      }
    }

    function artifactAlias(slug: string, artifactId: string, schemaHint: string) {
      return {
        controlId: `use.artifact.${slug}`,
        sourceType: 'artifact' as const,
        title: slug,
        description: '',
        schemaHint,
        riskLevel: 'safe' as const,
        artifactId
      }
    }

    it('renders Fabric as a group-only count by default, with no bare tool list', async () => {
      listVisibleControlsMock.mockImplementation(async ({ allowedControlIds }: any) =>
        allowedControlIds?.includes('use.artifact.*')
          ? []
          : [fabricControl('sys.voice.engine.enable', 'Enable voice engine')]
      )

      const result = await buildDynamicMcpIndex({
        userId: 'josh',
        runtime: 'api',
        brokerToggles: { ...ALL_BROKER_OFF, fetchZipEnabled: true, batshitToolsEnabled: true }
      })

      // Two native helper controls are allowed by `sys.comfyui.*` plus fetch-zip, and one
      // registry control, so the truthful count is four. SA-072 P2 step 0: the line also
      // names the families those four belong to.
      expect(result.text.split('\n')).toContain(
          `- ${FABRIC_TOOL_GRID_GROUP_NAME} (4 tools: ComfyUI, voice engines, zips)`
        )
      expect(result.text).not.toContain('sys.voice.engine.enable')
      expect(result.text).toContain('tool_discovery')
    })

    it('lists Fabric controls with hints when the agent overrides the row', async () => {
      listVisibleControlsMock.mockImplementation(async ({ allowedControlIds }: any) =>
        allowedControlIds?.includes('use.artifact.*') ? [] : []
      )

      const result = await buildDynamicMcpIndex({
        userId: 'josh',
        runtime: 'api',
        toolNameThreshold: 10,
        brokerToggles: { ...ALL_BROKER_OFF, fetchZipEnabled: true },
        dcmDisplaySettings: {
          version: 1,
          groups: {
            [buildCompositeKey(FABRIC_TOOL_GRID_ID, FABRIC_TOOL_GRID_GROUP_NAME)]:
              'group+tools+hints'
          },
          tools: {}
        }
      })

      expect(result.text).toContain(`- ${FABRIC_TOOL_GRID_GROUP_NAME} (1 tool: zips):`)
      expect(result.text).toContain('  - sys.zip.fetch — Fetch Zip — zipId (required)')
    })

    it('opens a memory-only Fabric row for a memory-enabled n8n agent, resolved from the agent record (SA-104 P3)', async () => {
      redisMock.get.mockImplementation(async (key: string) =>
        key === 'agent:agent_mem'
          ? { id: 'agent_mem', user_id: 'josh', memory_enabled: true }
          : null
      )
      listVisibleControlsMock.mockImplementation(async ({ allowedControlIds }: any) => {
        if (allowedControlIds?.includes('use.artifact.*')) return []
        if (allowedControlIds?.includes('sys.memory.*')) {
          return [
            fabricControl('sys.memory.save', 'Memory Save'),
            fabricControl('sys.memory.search', 'Memory Search'),
            fabricControl('sys.memory.recall', 'Memory Recall')
          ]
        }
        return []
      })

      // fetch-zip off + broad control plane closed on n8n: without memory the family is
      // gone; with the agent's memory_enabled it opens carrying only sys.memory.*.
      const withoutMemory = await buildDynamicMcpIndex({
        userId: 'josh',
        runtime: 'n8n',
        brokerToggles: { ...ALL_BROKER_OFF, batshitToolsEnabled: true },
        allowFabricControlTools: false,
        memoryControlsEnabled: false
      })
      expect(withoutMemory.text).not.toContain(FABRIC_TOOL_GRID_GROUP_NAME)

      const withMemory = await buildDynamicMcpIndex({
        userId: 'josh',
        agentId: 'agent_mem',
        runtime: 'n8n',
        brokerToggles: { ...ALL_BROKER_OFF, batshitToolsEnabled: true },
        allowFabricControlTools: false
      })
      expect(withMemory.text).toContain(`- ${FABRIC_TOOL_GRID_GROUP_NAME} (3 tools: memory)`)

      const memoryCall = listVisibleControlsMock.mock.calls.find((call: any[]) =>
        call[0]?.allowedControlIds?.includes('sys.memory.*')
      )
      expect(memoryCall?.[0].allowedControlIds).toEqual(['sys.memory.*'])
    })

    it('lists artifact refs with field hints and a config-control count', async () => {
      listVisibleControlsMock.mockImplementation(async ({ allowedControlIds }: any) => {
        if (allowedControlIds?.includes('use.artifact.*')) {
          return [artifactAlias('poster-maker', 'art_1', 'prompt (string), size (string)')]
        }
        return [
          { ...fabricControl('artifact.art_1.field.model.set', 'Poster: model'), artifactId: 'art_1' },
          { ...fabricControl('artifact.art_1.action.run.run', 'Poster: run'), artifactId: 'art_1' },
          { ...fabricControl('artifact.art_1.typed.invoke', 'Poster'), artifactId: 'art_1' }
        ]
      })

      const result = await buildDynamicMcpIndex({
        userId: 'josh',
        runtime: 'api',
        brokerToggles: { ...ALL_BROKER_OFF, artifactRuntimeEnabled: true, batshitToolsEnabled: true }
      })

      expect(result.text).toContain(`- ${ARTIFACT_TOOL_GRID_GROUP_NAME} (1 tool):`)
      expect(result.text).toContain(
        '  - use.artifact.poster-maker — fields: prompt (string), size (string) | 2 config controls'
      )
      expect(result.text).toContain('artifact_hint:')
    })

    it('renders Fabric and Artifact together with MCP groups', async () => {
      mockGatewayTools()
      listVisibleControlsMock.mockImplementation(async ({ allowedControlIds }: any) =>
        allowedControlIds?.includes('use.artifact.*')
          ? [artifactAlias('poster-maker', 'art_1', 'prompt (string)')]
          : [fabricControl('sys.voice.engine.enable', 'Enable voice engine')]
      )

      const result = await buildDynamicMcpIndex({
        userId: 'josh',
        runtime: 'api',
        selectedGateways: ['gw_hf'],
        nativeDynamicMcpEnabled: true,
        toolNameThreshold: 2
      })

      expect(result.text).toContain('- HuggingFace (3 tools)')
      expect(result.text).toContain(FABRIC_TOOL_GRID_GROUP_NAME)
      expect(result.text).toContain(`- ${ARTIFACT_TOOL_GRID_GROUP_NAME} (1 tool):`)
    })

    describe('SA-072 P2 step 0: the Fabric line names the families the agent can reach', () => {
      // The registry is mocked, so the mock applies the allowlist the index hands it with the
      // real matcher: what the index names must follow what the agent is allowed to reach.
      const REGISTRY = [
        fabricControl('sys.artifact.create', 'Create artifact'),
        { ...fabricControl('artifact.art_1.field.model.set', 'Poster: model'), artifactId: 'art_1' },
        fabricControl('sys.cli_tool.search', 'CLI tool search'),
        fabricControl('sys.dm.send', 'Send DM'),
        fabricControl('sys.memory.save', 'Memory Save'),
        fabricControl('sys.pinokio.run', 'Pinokio Run'),
        fabricControl('sys.pinokio.status', 'Pinokio Status'),
        fabricControl('sys.runtime_addon.start', 'Start runtime add-on')
      ]

      beforeEach(() => {
        listVisibleControlsMock.mockImplementation(async ({ allowedControlIds }: any) =>
          allowedControlIds?.includes('use.artifact.*')
            ? []
            : REGISTRY.filter((control) =>
                isControlIdAllowedByList(control.controlId, allowedControlIds)
              )
        )
      })

      it('names each reachable family once, in a fixed order, with Pinokio among them', async () => {
        const result = await buildDynamicMcpIndex({
          userId: 'josh',
          runtime: 'api',
          brokerToggles: { ...ALL_BROKER_OFF, batshitToolsEnabled: true },
          memoryControlsEnabled: true,
          dmControlsEnabled: false,
          judgeControlsEnabled: false
        })

        // Two ComfyUI helpers + seven registry controls (the DM one is not allowed). The two
        // artifact ids share one word, and so do the two Pinokio ids.
        expect(result.text.split('\n')).toContain(
          `- ${FABRIC_TOOL_GRID_GROUP_NAME} (9 tools: artifacts, CLI tools, ComfyUI, memory, Pinokio, runtime add-ons)`
        )
        expect(result.groups.find((group) => group.name === FABRIC_TOOL_GRID_GROUP_NAME)?.families)
          .toEqual(['artifacts', 'CLI tools', 'ComfyUI', 'memory', 'Pinokio', 'runtime add-ons'])
        expect(result.text).not.toContain('agent DMs')
      })

      it('gives a Subagent-shaped scope no Pinokio, because it cannot reach a Pinokio control', async () => {
        const result = await buildDynamicMcpIndex({
          userId: 'josh',
          runtime: 'api',
          brokerToggles: { ...ALL_BROKER_OFF, fetchZipEnabled: true, batshitToolsEnabled: true },
          allowFabricControlTools: false,
          memoryControlsEnabled: false,
          dmControlsEnabled: false,
          scheduleControlsEnabled: false,
          judgeControlsEnabled: false
        })

        expect(result.text.split('\n')).toContain(
          `- ${FABRIC_TOOL_GRID_GROUP_NAME} (1 tool: zips)`
        )
        expect(result.text).not.toContain('Pinokio')
      })

      it('drops a family whose only controls the agent hid, and keeps the count in step', async () => {
        const result = await buildDynamicMcpIndex({
          userId: 'josh',
          runtime: 'api',
          brokerToggles: { ...ALL_BROKER_OFF, batshitToolsEnabled: true },
          memoryControlsEnabled: false,
          dmControlsEnabled: false,
          judgeControlsEnabled: false,
          dcmDisplaySettings: {
            version: 1,
            groups: {},
            tools: {
              [buildCompositeKey(FABRIC_TOOL_GRID_ID, 'sys.pinokio.run')]: 'hidden',
              [buildCompositeKey(FABRIC_TOOL_GRID_ID, 'sys.pinokio.status')]: 'hidden'
            }
          }
        })

        expect(result.text.split('\n')).toContain(
          `- ${FABRIC_TOOL_GRID_GROUP_NAME} (6 tools: artifacts, CLI tools, ComfyUI, runtime add-ons)`
        )
        expect(result.text).not.toContain('Pinokio')
      })

      it('prints an unmapped family as its raw id segment rather than hiding it', async () => {
        listVisibleControlsMock.mockImplementation(async ({ allowedControlIds }: any) =>
          allowedControlIds?.includes('use.artifact.*')
            ? []
            : [fabricControl('sys.zz_future_family.do', 'A family added later')]
        )

        const result = await buildDynamicMcpIndex({
          userId: 'josh',
          runtime: 'api',
          brokerToggles: { ...ALL_BROKER_OFF, batshitToolsEnabled: true }
        })

        expect(result.text.split('\n')).toContain(
          `- ${FABRIC_TOOL_GRID_GROUP_NAME} (3 tools: ComfyUI, zz_future_family)`
        )
      })

      it('prints the same bytes whatever order the registry returns its controls in', async () => {
        const build = () =>
          buildDynamicMcpIndex({
            userId: 'josh',
            runtime: 'api',
            brokerToggles: { ...ALL_BROKER_OFF, batshitToolsEnabled: true },
            memoryControlsEnabled: true
          })
        const forward = await build()
        listVisibleControlsMock.mockImplementation(async ({ allowedControlIds }: any) =>
          allowedControlIds?.includes('use.artifact.*')
            ? []
            : [...REGISTRY]
                .reverse()
                .filter((control) => isControlIdAllowedByList(control.controlId, allowedControlIds))
        )
        const reversed = await build()

        expect(reversed.text).toBe(forward.text)
      })
    })

    it('emits no text at all when every family is empty', async () => {
      resolveMCPSelectionsMock.mockResolvedValue({
        resolvedToolSelections: [],
        resolvedGateways: []
      })

      const result = await buildDynamicMcpIndex({
        userId: 'josh',
        runtime: 'api',
        brokerToggles: ALL_BROKER_OFF
      })

      // The original defect: a `tool_discovery` header with nothing under it.
      expect(result.text).toBe('')
      expect(result.groups).toEqual([])
    })

    it('emits no text when the broker is live but every family returns nothing', async () => {
      resolveMCPSelectionsMock.mockResolvedValue({
        resolvedToolSelections: [],
        resolvedGateways: []
      })
      loadToolsForUserMock.mockResolvedValue({ tools: {}, metadata: new Map() })
      listVisibleControlsMock.mockResolvedValue([])

      const result = await buildDynamicMcpIndex({
        userId: 'josh',
        runtime: 'api',
        brokerToggles: { ...ALL_BROKER_OFF, artifactRuntimeEnabled: true }
      })

      expect(result.text).toBe('')
    })

    it('omits Fabric on the managed CLI lane when only fetch-zip is on', async () => {
      // On mode 4 fetch-zip ships as its own helper tool, not through the broker, so a
      // Fabric row here would advertise a family the broker would refuse.
      listVisibleControlsMock.mockResolvedValue([])

      const result = await buildDynamicMcpIndex({
        userId: 'josh',
        runtime: 'cli',
        brokerToggles: { ...ALL_BROKER_OFF, fetchZipEnabled: true }
      })

      expect(result.text).toBe('')
    })

    it('hides a family entirely when the Tool Grid row is switched off', async () => {
      listVisibleControlsMock.mockImplementation(async ({ allowedControlIds }: any) =>
        allowedControlIds?.includes('use.artifact.*')
          ? [artifactAlias('poster-maker', 'art_1', 'prompt (string)')]
          : []
      )

      const result = await buildDynamicMcpIndex({
        userId: 'josh',
        runtime: 'api',
        brokerToggles: { ...ALL_BROKER_OFF, artifactRuntimeEnabled: true },
        dcmDisplaySettings: {
          version: 1,
          groups: {
            [buildCompositeKey(ARTIFACT_TOOL_GRID_ID, ARTIFACT_TOOL_GRID_GROUP_NAME)]: 'hidden'
          },
          tools: {}
        }
      })

      expect(result.text).toBe('')
    })
  })
})
