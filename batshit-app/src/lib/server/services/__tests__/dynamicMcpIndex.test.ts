import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { CLI_TOOL_GRID_GROUP_NAME, CLI_TOOL_GRID_ID } from '$lib/utils/toolGridCli'
import { isControlIdAllowedByList } from '$lib/utils/brokerAvailability'
import {
  ARTIFACT_TOOL_GRID_GROUP_NAME,
  ARTIFACT_TOOL_GRID_ID,
  FABRIC_TOOL_GRID_GROUP_NAME,
  FABRIC_TOOL_GRID_DISPLAY_NAME,
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

import { UNKNOWN_GATEWAY, buildCompositeKey, buildDynamicMcpIndex, ToolHintBudgetError } from '../dynamicMcpIndex'
import { createAgentSetupCache } from '../agentSetupCache'
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

  it('labels unprepared API projections unknown and distinguishes an actual sealed known-empty registration set', async () => {
    const options = { userId: 'josh', runtime: 'api' as const, nativeDynamicMcpEnabled: false, cliToolsEnabled: false,
      brokerToggles: { dynamicMcpEnabled: false, cliToolsEnabled: false, fetchZipEnabled: false,
        batshitToolsEnabled: false, artifactRuntimeEnabled: false, agentBrowserEnabled: false } }
    const preview = await buildDynamicMcpIndex(options)
    expect(preview.apiUtilityProjection).toBe('unprepared')
    expect(preview.sources).toContainEqual({ id: 'api-utilities', label: 'Batshit Utilities', available: false, unavailableReason: 'unprepared' })
    const { captureApiUtilities } = await import('../apiUtilityRuntime')
    const scope = captureApiUtilities({ identity: { userId: options.userId }, approvals: {} }).scope
    const actual = await buildDynamicMcpIndex({ ...options, apiUtilityScope: scope })
    expect(actual.apiUtilityProjection).toBe('registered')
    expect(actual.sources).toContainEqual({ id: 'api-utilities', label: 'Batshit Utilities', available: true })
    expect(actual.setupBlocks).toEqual([])
    expect(loadToolsForUserMock).not.toHaveBeenCalled()
  })

  it('carries the captured API utility conditional fields into Setup and reports cap omissions', async () => {
    const { captureApiUtilities, markApiUtilityCandidate } = await import('../apiUtilityRuntime')
    const identity = { userId: 'josh' }
    const apiUtilityScope = captureApiUtilities({ identity, approvals: {}, tools: {
      native_spawn_workers: markApiUtilityCandidate({ inputSchema: z.object({ workers: z.array(z.object({
        task: z.string(), role: z.string().optional(), base: z.string().optional()
      })) }), execute: async () => ({}) }, 'workers', identity)
    } }).scope
    const options = { userId: 'josh', runtime: 'api' as const, apiUtilityScope, nativeDynamicMcpEnabled: false,
      brokerToggles: { dynamicMcpEnabled: false, cliToolsEnabled: false, fetchZipEnabled: false,
        batshitToolsEnabled: false, artifactRuntimeEnabled: false, agentBrowserEnabled: false } }
    redisMock.getUserSettings.mockResolvedValue({ admin_settings: { dcm_schema_hint_max_chars: 1000 } })
    const complete = await buildDynamicMcpIndex(options)
    const fullHint = complete.discoverable.find(row => row.ref === 'batshit:sys.workers.spawn')!.hint!
    expect(fullHint).toContain('required `task` and optional `role`, `base`')
    expect(complete.setupBlocks.map(block => block.text).join('\n')).toContain(fullHint)
    redisMock.getUserSettings.mockResolvedValue({ admin_settings: { dcm_schema_hint_max_chars: 80 } })
    const capped = await buildDynamicMcpIndex(options)
    const shortHint = capped.discoverable.find(row => row.ref === 'batshit:sys.workers.spawn')!.hint!
    expect(shortHint.length).toBeLessThanOrEqual(80)
    expect(shortHint).toContain('full schema')
  })

  it('applies saved required and optional field caps to scalable API utility and CLI hints (BL-2267)', async () => {
    const { captureApiUtilities, markApiUtilityCandidate } = await import('../apiUtilityRuntime')
    const identity = { userId: 'josh' }
    const apiUtilityScope = captureApiUtilities({ identity, approvals: {}, tools: {
      search: markApiUtilityCandidate({ inputSchema: z.object({ query: z.string(), region: z.string().optional() }), execute: async () => ({}) }, 'webSearch', identity),
      child: markApiUtilityCandidate({ inputSchema: z.object({ chatInput: z.string(), thread: z.enum(['fresh', 'resume']).optional() }), execute: async () => ({}) }, 'subagent', identity,
        { slug: 'helper', isSubagent: true, subagentId: 'helper-id', subagentName: 'Helper', subagentType: 'api' })
    } }).scope
    redisMock.getUserSettings.mockResolvedValue({ admin_settings: {
      dcm_schema_hint_required_limit: 1, dcm_schema_hint_optional_limit: 0, dcm_schema_hint_max_chars: 1000
    } })
    listCliToolsMock.mockResolvedValue([{ toolId: 'limited', title: 'Limited', status: 'active', inputSchema: {
      properties: { first: { type: 'string', required: true }, second: { type: 'string' }, extra: { type: 'boolean' } }, required: ['second']
    } }])
    const result = await buildDynamicMcpIndex({ userId: 'josh', runtime: 'api', apiUtilityScope,
      nativeDynamicMcpEnabled: false, selectedCliToolIds: ['limited'], cliToolsEnabled: true,
      brokerToggles: { dynamicMcpEnabled: false, cliToolsEnabled: true, fetchZipEnabled: false,
        batshitToolsEnabled: false, artifactRuntimeEnabled: false, agentBrowserEnabled: false } })
    const web = result.discoverable.find(row => row.ref === 'batshit:sys.web_search.search')!.hint!
    expect(web).toContain('required: `query`')
    expect(web).toContain('optional: 4 fields (full schema)')
    expect(web).not.toContain('`maxResults`')
    const subagent = result.discoverable.find(row => row.ref === 'batshit:sys.subagent.call')!.hint!
    expect(subagent).toContain('(+1 more; full schema)')
    expect(subagent).not.toContain('`chatInput`')
    expect(subagent).not.toContain('`thread`')
    const cli = result.discoverable.find(row => row.ref === 'cli:limited')!.hint!
    expect(cli).toBe('required: first:string (+1 more; full schema) · optional: 1 fields (full schema)')
  })

  it('reads a delegated API registration by its audit parent while retaining a separate child control target', async () => {
    const { captureApiUtilities } = await import('../apiUtilityRuntime')
    const scope = captureApiUtilities({ identity: { userId: 'josh', agentId: 'parent', scopeAgentId: 'child' }, approvals: {} }).scope
    const options = { userId: 'josh', agentId: 'parent', controlAgentId: 'child', runtime: 'api' as const,
      apiUtilityScope: scope, nativeDynamicMcpEnabled: false, cliToolsEnabled: false,
      brokerToggles: { dynamicMcpEnabled: false, cliToolsEnabled: false, fetchZipEnabled: false,
        batshitToolsEnabled: false, artifactRuntimeEnabled: false, agentBrowserEnabled: false } }
    expect((await buildDynamicMcpIndex(options)).apiUtilityProjection).toBe('registered')
    await expect(buildDynamicMcpIndex({ ...options, agentId: 'foreign-parent' })).rejects.toThrow('API utility discovery owner changed')
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

  it('joins Fabric capabilities by stable policy identity and carries warm hint edits and ref replacements', async () => {
    const groupKey = buildCompositeKey(FABRIC_TOOL_GRID_ID, FABRIC_TOOL_GRID_GROUP_NAME)
    const options = { userId: 'josh', runtime: 'api' as const, nativeDynamicMcpEnabled: false,
      brokerToggles: { dynamicMcpEnabled: false, cliToolsEnabled: false, fetchZipEnabled: false,
        batshitToolsEnabled: true, artifactRuntimeEnabled: false, agentBrowserEnabled: false },
      dcmDisplaySettings: { version: 1 as const, groups: { [groupKey]: 'group+tools+hints' as const }, tools: {} } }
    const row = (controlId: string, schemaHint: string) => ({ controlId, sourceType: 'core', title: 'Saved CLI tool', schemaHint })
    listVisibleControlsMock.mockResolvedValue([row('sys.cli_tool.search', 'query required')])
    const first = await buildDynamicMcpIndex(options)
    expect(first.groups[0]).toMatchObject({ id: groupKey, name: FABRIC_TOOL_GRID_DISPLAY_NAME })
    expect(first.setupBlocks[0].items.some(item => item.key === 'fabric:sys.cli_tool.search')).toBe(true)
    const cache = createAgentSetupCache()
    const identity = { userId: 'josh', sessionId: 'stable-fabric-join', agentId: 'owned-primary' }
    const prepare = (index: typeof first) => cache.prepare({ identity,
      live: { blocks: index.setupBlocks, sources: index.sources }, precedingBytes: 'same', toolFingerprint: 'same' })
    const seed = prepare(first)
    cache.modelCalled(seed)
    listVisibleControlsMock.mockResolvedValue([row('sys.cli_tool.search', 'query required, maxResults optional')])
    const editedIndex = await buildDynamicMcpIndex(options)
    expect(editedIndex.allowedSkillToolHints?.find(tool => tool.controlId === 'sys.cli_tool.search')?.schemaHint).toContain('maxResults optional')
    const edited = prepare(editedIndex)
    expect(edited.refresh).toBeNull()
    expect(edited.text).toBe(seed.text)
    expect(edited.changes).not.toContain('changed: fabric:sys.cli_tool.search')
    listVisibleControlsMock.mockResolvedValue([row('sys.cli_tool.get', 'toolId required')])
    const replaced = prepare(await buildDynamicMcpIndex(options))
    expect(replaced.refresh).toBeNull()
    expect(replaced.text).toBe(seed.text)
    expect(replaced.changes).toContain('added: fabric:sys.cli_tool.get')
    expect(replaced.changes).toContain('removed: fabric:sys.cli_tool.search')
  })

  it.each(['group-only', 'group+tools+names'] as const)('ignores retired warm Fabric display choice %s while retaining opened-skill hints', async priorMode => {
    const groupKey = buildCompositeKey(FABRIC_TOOL_GRID_ID, FABRIC_TOOL_GRID_GROUP_NAME)
    listVisibleControlsMock.mockResolvedValue([{ controlId: 'sys.cli_tool.search', sourceType: 'core', title: 'Saved CLI tool',
      schemaHint: 'query required, maxResults optional' }])
    const options = { userId: 'josh', runtime: 'api' as const, nativeDynamicMcpEnabled: false,
      brokerToggles: { dynamicMcpEnabled: false, cliToolsEnabled: false, fetchZipEnabled: false,
        batshitToolsEnabled: true, artifactRuntimeEnabled: false, agentBrowserEnabled: false } }
    const index = async (mode: typeof priorMode | 'group+tools+hints') => buildDynamicMcpIndex({ ...options,
      dcmDisplaySettings: { version: 1, groups: { [groupKey]: mode }, tools: {} } })
    const cache = createAgentSetupCache()
    const identity = { userId: 'josh', sessionId: `visible-detail-${priorMode}`, agentId: 'owned-primary' }
    const prepare = (result: Awaited<ReturnType<typeof index>>) => cache.prepare({ identity,
      live: { blocks: result.setupBlocks, sources: result.sources }, precedingBytes: 'same', toolFingerprint: 'same' })
    const first = prepare(await index(priorMode))
    cache.modelCalled(first)
    expect(first.text).not.toContain('query required')
    const changed = prepare(await index('group+tools+hints'))
    expect(changed.refresh).toBeNull()
    expect(changed.text).toBe(first.text)
    expect(changed.changes).not.toContain('changed: fabric:sys.cli_tool.search')
    expect((await index('group+tools+hints')).allowedSkillToolHints?.find(tool => tool.controlId === 'sys.cli_tool.search')?.schemaHint).toContain('maxResults optional')
  })

  it('reports an Artifact group note removed by the live total budget instead of retaining stale note metadata', async () => {
    let budget = 3000
    redisMock.getUserSettings.mockImplementation(async () => ({ admin_settings: { dcm_schema_hint_total_tokens: budget } }))
    const tools = Object.fromEntries([0, 1, 2, 3].map(i => [`tool${i}`, { inputSchema: makeSchema('query') }]))
    const names = [0, 1, 2, 3].map(i => `group${i}_${'x'.repeat(430)}`)
    loadToolsForUserMock.mockResolvedValue({ tools, metadata: new Map(names.map((mcpServerName, i) => [`tool${i}`,
      { gatewayId: 'gw_hf', gatewayName: 'Gateway', mcpServerName }])) })
    listVisibleControlsMock.mockResolvedValue([{ controlId: 'use.artifact.poster', sourceType: 'artifact', title: 'Poster', schemaHint: 'prompt' }])
    const options = { userId: 'josh', runtime: 'api' as const, nativeDynamicMcpEnabled: true,
      brokerToggles: { dynamicMcpEnabled: true, cliToolsEnabled: false, fetchZipEnabled: false,
        batshitToolsEnabled: false, artifactRuntimeEnabled: true, agentBrowserEnabled: false },
      dcmDisplaySettings: { version: 1 as const, groups: Object.fromEntries([
        ...names.map(name => [buildCompositeKey('gw_hf', name), 'group-only']),
        [buildCompositeKey(ARTIFACT_TOOL_GRID_ID, ARTIFACT_TOOL_GRID_GROUP_NAME), 'group-only']
      ]) as Record<string, 'group-only'>, tools: {} } }
    const first = await buildDynamicMcpIndex(options)
    expect(first.setupBlocks.some(block => block.items.some(item => item.key.startsWith('group-note:')))).toBe(true)
    const cache = createAgentSetupCache()
    const prepare = (index: typeof first) => cache.prepare({ identity: { userId: 'josh', sessionId: 'artifact-note', agentId: 'owned-primary' },
      live: { blocks: index.setupBlocks, sources: index.sources }, precedingBytes: 'same', toolFingerprint: 'same' })
    const seed = prepare(first)
    cache.modelCalled(seed)
    budget = 500
    const current = await buildDynamicMcpIndex(options)
    expect(current.hintBudget.budgetedTokens).toBeLessThanOrEqual(500)
    expect(current.setupBlocks.some(block => block.items.some(item => item.key.startsWith('group-note:')))).toBe(false)
    const changed = prepare(current)
    expect(changed.refresh).toBeNull()
    expect(changed.text).toBe(seed.text)
    expect(changed.changes).toContain(`removed: ${ARTIFACT_TOOL_GRID_GROUP_NAME} note`)
  })
  it('adds only the vouched Primary Settings pair to existing index counts and repeats identical bytes', async () => {
    listVisibleControlsMock.mockImplementation(async ({ actorType, allowedControlIds }: any) =>
      actorType === 'in-process' && allowedControlIds?.includes('sys.app_settings.native.report')
        ? ['report', 'change'].map(leaf => ({ controlId: `sys.app_settings.native.${leaf}`, sourceType: 'core', title: `Settings ${leaf}`,
          description: '', schemaHint: 'fixed schema', riskLevel: 'safe', artifactId: null })) : [])
    const options = { userId: 'josh', agentId: 'owned-primary', runtime: 'api' as const,
      brokerToggles: { fetchZipEnabled: false, dynamicMcpEnabled: false, cliToolsEnabled: false,
        artifactRuntimeEnabled: false, agentBrowserEnabled: false, batshitToolsEnabled: true }, primarySettingsActor: true }
    const first = await buildDynamicMcpIndex(options)
    expect(first.text).toContain('App Actions')
    expect(first.discoverable.filter(item => item.ref.startsWith('fabric:sys.app_settings.'))).toHaveLength(2)
    expect(await buildDynamicMcpIndex(options)).toEqual(first)
    const unvouched = await buildDynamicMcpIndex({ ...options, primarySettingsActor: false })
    expect(unvouched.text).not.toContain('App Actions')
    expect(unvouched.discoverable.some(item => item.ref.includes('sys.app_settings.'))).toBe(false)
  })

  it('forwards the genuine preassociation API preparation into the same Fabric DCM hint owner with stable counts and base bytes', async () => {
    const owner = await import('../appActions/mcp/originalTask'), turns = await import('../streamAbortRegistry')
    const userId = 'josh', agentId = 'owned-primary', sessionId = 'metadata-dcm-original', replyId = 'metadata-dcm-reply', stop = new AbortController()
    const turn = turns.registerSessionTurn(sessionId, 'single', replyId)
    if (!turn.ok) throw new Error('The existing DCM fixture could not register its original turn.')
    const lookup = owner.captureP5OriginalLookup({ userId, agentId, sessionId, signal: stop.signal })
    const session = { id: sessionId, user_id: userId, agent_id: agentId }, agent = { id: agentId, user_id: userId, agentType: 'api' }
    const preparation = owner.prepareP5OriginalTask(lookup, { sessionId, session, agent, turn: turn.entry })
    if (!preparation) throw new Error('The actual DCM API preparation is unavailable.')
    owner.recordP5ResolvedApiScope(preparation, { gateways: [], tools: [], authority: { humanSelection: true } })
    owner.bindP5ApiReplyPart(preparation, { replyId, version: 0 })
    listVisibleControlsMock.mockImplementation(async ({ p5McpOwner, actorType }: any) => actorType !== 'in-process' ? [] : ['report','change'].map(leaf => ({
      controlId: `sys.app_settings.native.${leaf}`, sourceType: 'core', title: `Settings ${leaf}`, description: '',
      schemaHint: p5McpOwner === preparation ? 'API MCP: complete HTTP prerequisite schema' : 'fixed schema', riskLevel: 'safe', artifactId: null
    })))
    const options = { userId, agentId, selectedGateways: [], runtime: 'api' as const, primarySettingsActor: true,
      brokerToggles: { fetchZipEnabled: false, dynamicMcpEnabled: false, cliToolsEnabled: false, artifactRuntimeEnabled: false, agentBrowserEnabled: false, batshitToolsEnabled: true },
      dcmDisplaySettings: { version: 1 as const, groups: { [buildCompositeKey(FABRIC_TOOL_GRID_ID, FABRIC_TOOL_GRID_GROUP_NAME)]: 'group+tools+hints' as const }, tools: {} } }
    try {
      const base = await buildDynamicMcpIndex(options), before = JSON.stringify(base)
      const api = await buildDynamicMcpIndex({ ...options, p5McpOwner: preparation })
      expect(listVisibleControlsMock.mock.calls.at(-1)?.[0].p5McpOwner).toBe(preparation)
      expect(owner.p5ApiHasVerifiedMcpSource(preparation)).toBe(false)
      expect(api.allowedSkillToolHints?.find(tool => tool.controlId === 'sys.app_settings.native.report')?.schemaHint).toContain('API MCP: complete HTTP prerequisite schema')
      expect(api.discoverable.map(row => row.ref)).toEqual(base.discoverable.map(row => row.ref))
      expect(api.counts).toEqual(base.counts)
      expect(await buildDynamicMcpIndex({ ...options, p5McpOwner: preparation })).toEqual(api)
      expect(JSON.stringify(await buildDynamicMcpIndex(options))).toBe(before)
      expect((await buildDynamicMcpIndex({ ...options, primarySettingsActor: false })).discoverable.some(row => row.ref.includes('sys.app_settings.'))).toBe(false)
    } finally { owner.retireP5OriginalPreparation(preparation); turns.releaseSessionTurn(sessionId, turn.entry.turnId) }
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
    expect(result.text).toContain('  - crawl4ai — Crawl4AI — Crawl a URL — required: url:string · optional: maxPages:integer')
    expect(result.text).toContain(
      '  - local_screenshot — Local Screenshot — Capture a screenshot — required: outputPath:string'
    )
    expect(result.text).toContain('  - repo_snapshot — Repo Snapshot — Summarize a repo — required: path:string')
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
          `- ${FABRIC_TOOL_GRID_DISPLAY_NAME} (4 tools: ComfyUI, voice engines, zips; the Batshit skills explain them)`
        )
      expect(result.text).not.toContain('sys.voice.engine.enable')
      expect(result.text).toContain('tool_discovery')
    })

    it('keeps one Fabric line despite a retired per-agent hint-display override', async () => {
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

      expect(result.text).toContain(`- ${FABRIC_TOOL_GRID_DISPLAY_NAME} (1 tool: zips; the Batshit skills explain them)`)
      expect(result.text).not.toContain('  - sys.zip.fetch —')
      expect(result.allowedSkillToolHints?.find(tool => tool.controlId === 'sys.zip.fetch')?.schemaHint).toContain('zipId')
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

      // fetch-zip off + broad control plane closed: without memory the family is
      // gone; with the agent's memory_enabled it opens carrying only sys.memory.*.
      const withoutMemory = await buildDynamicMcpIndex({
        userId: 'josh',
        runtime: 'api',
        brokerToggles: { ...ALL_BROKER_OFF, batshitToolsEnabled: true },
        allowFabricControlTools: false,
        memoryControlsEnabled: false
      })
      expect(withoutMemory.text).not.toContain(FABRIC_TOOL_GRID_DISPLAY_NAME)

      const withMemory = await buildDynamicMcpIndex({
        userId: 'josh',
        agentId: 'agent_mem',
        runtime: 'api',
        brokerToggles: { ...ALL_BROKER_OFF, batshitToolsEnabled: true },
        allowFabricControlTools: false
      })
      expect(withMemory.text).toContain(`- ${FABRIC_TOOL_GRID_DISPLAY_NAME} (3 tools: memory; the Batshit skills explain them)`)

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
      expect(result.text).toContain(FABRIC_TOOL_GRID_DISPLAY_NAME)
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
          `- ${FABRIC_TOOL_GRID_DISPLAY_NAME} (9 tools: artifacts, CLI tools, ComfyUI, memory, Pinokio, runtime add-ons; the Batshit skills explain them)`
        )
        expect(result.groups.find((group) => group.name === FABRIC_TOOL_GRID_DISPLAY_NAME)?.families)
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
          `- ${FABRIC_TOOL_GRID_DISPLAY_NAME} (1 tool: zips; the Batshit skills explain them)`
        )
        expect(result.text).not.toContain('Pinokio')
        expect(result.allowedSkillToolHints?.some(tool => tool.controlId.startsWith('sys.pinokio.'))).toBe(false)
      })

      it('ignores retired Fabric hiding choices and retains the counted allowed families and complete opened-skill guidance', async () => {
        const fullHint = 'required: `appId` · optional: ' + 'complete supported calling fields '.repeat(100)
        redisMock.getUserSettings.mockResolvedValue({ admin_settings: { dcm_schema_hint_max_chars: 80 } })
        listVisibleControlsMock.mockImplementation(async ({ allowedControlIds }: any) =>
          allowedControlIds?.includes('use.artifact.*') ? [] : REGISTRY.filter(control =>
            isControlIdAllowedByList(control.controlId, allowedControlIds)).map(control =>
            control.controlId === 'sys.pinokio.run' ? { ...control, schemaHint: fullHint } : control))
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
          `- ${FABRIC_TOOL_GRID_DISPLAY_NAME} (8 tools: artifacts, CLI tools, ComfyUI, Pinokio, runtime add-ons; the Batshit skills explain them)`
        )
        expect(result.text).toContain('Pinokio')
        expect(result.allowedSkillToolHints).toContainEqual({ controlId: 'sys.pinokio.run', ref: 'fabric:sys.pinokio.run', schemaHint: fullHint.trim() })
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
          `- ${FABRIC_TOOL_GRID_DISPLAY_NAME} (3 tools: ComfyUI, zz_future_family; the Batshit skills explain them)`
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

    it.each(['group-only', 'group+tools+names', 'group+tools+hints'] as const)('preserves retained Artifact detail %s while retiring its hidden switch', async mode => {
      listVisibleControlsMock.mockImplementation(async ({ allowedControlIds }: any) => allowedControlIds?.includes('use.artifact.*') ? [artifactAlias('poster-maker', 'art_1', 'prompt (string)')] : [])
      const groupKey = buildCompositeKey(ARTIFACT_TOOL_GRID_ID, ARTIFACT_TOOL_GRID_GROUP_NAME)
      const result = await buildDynamicMcpIndex({ userId: 'josh', runtime: 'api', brokerToggles: { ...ALL_BROKER_OFF, artifactRuntimeEnabled: true },
        dcmDisplaySettings: { version: 1, groups: { [groupKey]: 'hidden' }, tools: {}, groupDisplayPreferences: { [groupKey]: mode } } })
      expect(result.text).toContain('Artifact Tools (1 tool)')
      expect(result.text.includes('use.artifact.poster-maker')).toBe(mode !== 'group-only')
      expect(result.text.includes('fields: prompt (string)')).toBe(mode === 'group+tools+hints')
    })
    it.each(['group+tools+names', 'group+tools+hints'] as const)('preserves explicit retained Artifact %s above the ordinary collapse threshold', async mode => {
      listVisibleControlsMock.mockImplementation(async ({ allowedControlIds }: any) => allowedControlIds?.includes('use.artifact.*')
        ? [1, 2, 3].map(id => artifactAlias(`poster-${id}`, `art_${id}`, 'prompt (string)')) : [])
      const groupKey = buildCompositeKey(ARTIFACT_TOOL_GRID_ID, ARTIFACT_TOOL_GRID_GROUP_NAME)
      const result = await buildDynamicMcpIndex({ userId: 'josh', runtime: 'api', toolNameThreshold: 1,
        brokerToggles: { ...ALL_BROKER_OFF, artifactRuntimeEnabled: true },
        dcmDisplaySettings: { version: 1, groups: { [groupKey]: 'hidden' }, tools: {}, groupDisplayPreferences: { [groupKey]: mode } } })
      expect(result.text).toContain('use.artifact.poster-3')
      expect(result.text.includes('fields: prompt (string)')).toBe(mode === 'group+tools+hints')
    })

    it('retains global Artifact group-only detail when an old hidden agent follows the global choice', async () => {
      redisMock.getUserSettings.mockResolvedValue({ global_tool_grid_settings: { artifact: { dcmDisplayDefaults: { version: 1, groups: { [ARTIFACT_TOOL_GRID_GROUP_NAME]: 'group-only' }, tools: {} } } } })
      listVisibleControlsMock.mockImplementation(async ({ allowedControlIds }: any) => allowedControlIds?.includes('use.artifact.*') ? [artifactAlias('poster-maker', 'art_1', 'prompt (string)')] : [])
      const groupKey = buildCompositeKey(ARTIFACT_TOOL_GRID_ID, ARTIFACT_TOOL_GRID_GROUP_NAME)
      const result = await buildDynamicMcpIndex({ userId: 'josh', runtime: 'api', brokerToggles: { ...ALL_BROKER_OFF, artifactRuntimeEnabled: true },
        dcmDisplaySettings: { version: 1, groups: { [groupKey]: 'hidden' }, tools: {}, groupDisplayPreferences: { [groupKey]: 'use-global' } } })
      expect(result.text).toContain('Artifact Tools (1 tool)')
      expect(result.text).not.toContain('use.artifact.poster-maker')
      expect(result.text).not.toContain('fields: prompt (string)')
    })

    it('keeps an enabled Artifact family visible despite retired discovery hiding', async () => {
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

      expect(result.text).toContain('Artifact Tools (1 tool)')
      expect(result.text).toContain('use.artifact.poster-maker')
    })
  })

  it('budgets the largest complete scalable group first in a three-gateway/45-tool fixture', async () => {
    redisMock.getUserSettings.mockResolvedValue({ admin_settings: {
      dcm_tool_name_threshold: 30, dcm_schema_hint_required_limit: 6,
      dcm_schema_hint_optional_limit: 6, dcm_schema_hint_max_chars: 240,
      dcm_schema_hint_total_tokens: 500
    } })
    const tools: Record<string, any> = {}, metadata = new Map()
    for (const [gateway, count] of [18, 15, 12].entries()) {
      for (let index = 0; index < count; index++) {
        const name = `tool_${gateway}_${String(index).padStart(2, '0')}`
        tools[name] = { inputSchema: makeSchema('query') }
        metadata.set(name, { gatewayId: `gateway_${gateway}`, gatewayName: `Gateway ${gateway}`,
          mcpServerName: `Gateway ${gateway}`, originalToolName: name })
      }
    }
    resolveMCPSelectionsMock.mockResolvedValue({ resolvedToolSelections: [], resolvedGateways: ['gateway_0', 'gateway_1', 'gateway_2'] })
    loadToolsForUserMock.mockResolvedValue({ tools, metadata })
    const result = await buildDynamicMcpIndex({ userId: 'josh', nativeDynamicMcpEnabled: true,
      brokerToggles: { dynamicMcpEnabled: true, cliToolsEnabled: false, fetchZipEnabled: false,
        batshitToolsEnabled: false, artifactRuntimeEnabled: false, agentBrowserEnabled: false } })
    expect(result.counts.dcmTools).toBe(45)
    expect(result.groups).toHaveLength(3)
    expect(result.groups.find(group => group.name === 'Gateway 0')?.tools).toBeUndefined()
    expect(result.groups.find(group => group.name === 'Gateway 1')?.tools).toHaveLength(15)
    expect(result.groups.find(group => group.name === 'Gateway 2')?.tools).toHaveLength(12)
    expect(result.hintBudget.budgetedTokens).toBeLessThanOrEqual(500)
    expect(result.schemaHintCaps).toEqual({ requiredLimit: 6, optionalLimit: 6, maxChars: 240 })
  })

  it('refuses an irreducible name/count floor without dropping groups or changing the saved budget', async () => {
    const saved = { admin_settings: { dcm_tool_name_threshold: 30, dcm_schema_hint_total_tokens: 500 } }
    redisMock.getUserSettings.mockResolvedValue(saved)
    const tools: Record<string, any> = {}, metadata = new Map(), names: string[] = []
    for (let index = 0; index < 45; index++) {
      const name = `tool_${index}`, group = `${'G'.repeat(120)}_${index}`
      names.push(group)
      tools[name] = { inputSchema: makeSchema('query') }
      metadata.set(name, { gatewayId: `gateway_${index % 3}`, gatewayName: `Gateway ${index % 3}`,
        mcpServerName: group, originalToolName: name })
    }
    resolveMCPSelectionsMock.mockResolvedValue({ resolvedToolSelections: [], resolvedGateways: ['gateway_0', 'gateway_1', 'gateway_2'] })
    loadToolsForUserMock.mockResolvedValue({ tools, metadata })
    const error = await buildDynamicMcpIndex({ userId: 'josh', nativeDynamicMcpEnabled: true,
      brokerToggles: { dynamicMcpEnabled: true, cliToolsEnabled: false, fetchZipEnabled: false,
        batshitToolsEnabled: false, artifactRuntimeEnabled: false, agentBrowserEnabled: false } }).catch(error => error)
    const minimum = Math.ceil(names.map(name => `- ${name} (1 tool)`).join('\n').length / 4)
    expect(error).toBeInstanceOf(ToolHintBudgetError)
    expect(error).toMatchObject({ code: 'TOOL_HINT_BUDGET_TOO_SMALL', status: 400,
      budgetTokens: 500, minimumRequiredTokens: minimum })
    expect(minimum).toBeGreaterThan(1500)
    expect(error.message).toContain('reduce/shorten enabled group metadata')
    expect(saved.admin_settings.dcm_schema_hint_total_tokens).toBe(500)
  })

  it('counts only remaining Fabric tools when complete fixed feature hints already have their own Setup lines', async () => {
    listVisibleControlsMock.mockResolvedValue([
      { controlId: 'sys.memory.search', sourceType: 'core', title: 'Search Memory', schemaHint: 'required: `query`' },
      { controlId: 'sys.dm.send', sourceType: 'core', title: 'Send DM', schemaHint: 'required: `to`, `body`' },
      { controlId: 'sys.artifact.create', sourceType: 'core', title: 'Create Artifact', schemaHint: 'optional: `name`' }
    ])
    const result = await buildDynamicMcpIndex({ userId: 'josh', runtime: 'api', nativeDynamicMcpEnabled: false,
      memoryControlsEnabled: true, dmControlsEnabled: true, featureHintGates: { memory: true, dm: true },
      brokerToggles: { dynamicMcpEnabled: false, cliToolsEnabled: false, fetchZipEnabled: false,
        batshitToolsEnabled: true, artifactRuntimeEnabled: false, agentBrowserEnabled: false } })
    const fabric = result.groups.find(group => group.name === FABRIC_TOOL_GRID_DISPLAY_NAME)!
    expect(fabric.toolCount).toBe(3) // Artifact + two already-allowed ComfyUI helpers.
    expect(fabric.families).toEqual(['artifacts', 'ComfyUI'])
    expect(result.text).toContain('3 tools: artifacts, ComfyUI; the Batshit skills explain them')
    expect(result.setupBlocks.filter(block => block.hintClass === 'fixed-feature').map(block => block.key)).toEqual(['feature:memory', 'feature:dm'])
    expect(result.discoverable.filter(tool => tool.ref === 'fabric:sys.memory.search')).toHaveLength(1)
    expect(result.discoverable.filter(tool => tool.ref === 'fabric:sys.dm.send')).toHaveLength(1)
  })

  it.each([240, 400])('keeps approved fixed conditional fields in full at cap %s while custom hints stay capped', async (maxChars) => {
    redisMock.getUserSettings.mockResolvedValue({ admin_settings: { dcm_schema_hint_max_chars: maxChars,
      dcm_tool_name_threshold: 30, dcm_schema_hint_total_tokens: 3000 } })
    const dmHint = 'required: to, kind, subject, body, deliver; an assignment also needs requested_outcome, scope, report_back_to; a result also needs related_dm_id; ' + 'canonical field detail '.repeat(25)
    listVisibleControlsMock.mockResolvedValue([
      { controlId: 'sys.dm.send', sourceType: 'core', title: 'DM Send', schemaHint: dmHint },
      { controlId: 'sys.memory.search', sourceType: 'core', title: 'Search Memory', schemaHint: 'query required, include_expired optional false' },
      { controlId: 'sys.memory.custom_hint', sourceType: 'core', title: 'Untrusted custom prefix', schemaHint: 'custom '.repeat(200), fixedFeature: true }
    ])
    const result = await buildDynamicMcpIndex({ userId: 'josh', runtime: 'api', nativeDynamicMcpEnabled: false,
      allowFabricControlTools: false, memoryControlsEnabled: true, dmControlsEnabled: true,
      scheduleControlsEnabled: true, featureHintGates: { memory: true, dm: true },
      brokerToggles: { dynamicMcpEnabled: false, cliToolsEnabled: false, fetchZipEnabled: false,
        batshitToolsEnabled: true, artifactRuntimeEnabled: false, agentBrowserEnabled: false },
      dcmDisplaySettings: { version: 1, groups: { [buildCompositeKey(FABRIC_TOOL_GRID_ID, FABRIC_TOOL_GRID_GROUP_NAME)]: 'group+tools+hints' }, tools: {} } })
    const fixed = result.setupBlocks.filter(block => block.hintClass === 'fixed-feature')
    expect(fixed.map(block => block.key)).toEqual(['feature:memory', 'feature:dm'])
    expect(fixed.find(block => block.key === 'feature:dm')?.text).toContain(dmHint)
    expect(fixed.flatMap(block => block.items).map(item => item.key)).not.toContain('fabric:sys.memory.custom_hint')
    expect(result.groups.flatMap(group => group.tools ?? []).some(tool => tool.name === 'sys.memory.custom_hint')).toBe(false)
    expect(result.discoverable.find(tool => tool.name === 'sys.memory.custom_hint')?.hint!.length).toBeLessThanOrEqual(maxChars)
    expect(result.hintBudget.featureTokens).toBeGreaterThan(150)
    expect(result.discoverable.filter(row => row.ref === 'fabric:sys.dm.send')).toHaveLength(1)
    expect(result.discoverable.find(row => row.ref === 'fabric:sys.dm.send')?.hint).toBe(dmHint)
    expect(loadToolsForUserMock).not.toHaveBeenCalled()
  })

})
