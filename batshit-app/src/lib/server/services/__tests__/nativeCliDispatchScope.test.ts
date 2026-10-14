import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BL-686 — the dispatch doors for saved CLI tools (`cli_tool_find`, `cli_tool_use`, and the
 * `batshit_tool_use` broker's `cli:` refs).
 *
 * The payload's `selectedToolIds` used to reach `findCliTools` / `executeCliTool` as the whole
 * scope for a Primary actor, so a caller could name a tool the governing agent never saved.
 * Each door now resolves the scope once (`resolveDispatchCliToolScope`): the credential's list
 * on the `agent` lane, the Subagent's own list, or the governing agent's saved list, with the
 * payload's list only as a filter, and hands the answer on as a bound `cliToolScope`.
 * `cliToolRegistry` is mocked; its scope rule has `cliToolSelectionScope.test.ts`.
 */

const cliMocks = vi.hoisted(() => ({
  executeCliTool: vi.fn(),
  findCliTools: vi.fn(),
  getCliTool: vi.fn(),
  resolveCliToolSelectionScope: vi.fn()
}))

const redisMocks = vi.hoisted(() => ({
  get: vi.fn(),
  getSession: vi.fn(),
  jsonGet: vi.fn()
}))

vi.mock('$env/dynamic/private', () => ({ env: {} }))
vi.mock('$env/dynamic/public', () => ({ env: {} }))
vi.mock('$lib/server/redis', () => ({
  redis: {
    get: redisMocks.get,
    getSession: redisMocks.getSession,
    json: { get: redisMocks.jsonGet, set: vi.fn() }
  }
}))
vi.mock('../cliToolRegistry', () => cliMocks)

import { nativeToolService } from '../nativeTools'

const nativeSettings = {
  dynamicMcpEnabled: false,
  cliToolsEnabled: true,
  artifactRuntimeEnabled: false,
  batshitToolsEnabled: false,
  fetchZipEnabled: false,
  agentBrowserEnabled: false,
  webSearchEnabled: false,
  bashEnabled: false
}

const primaryContext = {
  session_id: 'session-1',
  agent_id: 'agent-1',
  mode: 'mode4',
  actor_type: 'primary'
}

describe('dispatch doors resolve the saved CLI tool scope (BL-686)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cliMocks.executeCliTool.mockResolvedValue({ success: true, toolId: 'a_tool' })
    cliMocks.findCliTools.mockResolvedValue({ results: [], totalMatches: 0, query: '' })
    cliMocks.resolveCliToolSelectionScope.mockResolvedValue({ toolIds: ['a_tool'], source: 'agent' })
    redisMocks.getSession.mockResolvedValue(null)
    redisMocks.get.mockResolvedValue({
      id: 'agent-1',
      user_id: 'user-1',
      defaultTools: ['a_tool'],
      provider_specific_settings: { nativeTools: nativeSettings }
    })
    redisMocks.jsonGet.mockResolvedValue(null)
  })

  it("cli_tool_use: a payload list naming another agent's tool only narrows the governing agent's list", async () => {
    await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'user-1',
      action: 'cli_tool_use',
      payloadInput: { toolId: 'b_tool', input: {}, selectedToolIds: ['b_tool'] },
      context: primaryContext,
      projectPath: '/tmp',
      actorType: 'session'
    })

    expect(cliMocks.resolveCliToolSelectionScope).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'agent-1',
      selectedToolIds: ['b_tool']
    })
    const params = cliMocks.executeCliTool.mock.calls[0][0]
    expect(params.toolId).toBe('b_tool')
    expect(params.cliToolScope).toEqual(['a_tool'])
    expect(params.selectedToolIds).toBeUndefined()
  })

  it('cli_tool_use on the agent lane is bounded by the credential list, [] when it has none', async () => {
    await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'user-1',
      action: 'cli_tool_use',
      payloadInput: { toolId: 'b_tool', input: {}, selectedToolIds: ['b_tool'] },
      context: primaryContext,
      projectPath: '/tmp',
      actorType: 'agent',
      cliToolScope: ['a_tool']
    })
    expect(cliMocks.resolveCliToolSelectionScope).toHaveBeenLastCalledWith(
      expect.objectContaining({ cliToolScope: ['a_tool'], selectedToolIds: ['b_tool'] })
    )

    await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'user-1',
      action: 'cli_tool_use',
      payloadInput: { toolId: 'a_tool', input: {} },
      context: primaryContext,
      projectPath: '/tmp',
      actorType: 'agent'
    })
    expect(cliMocks.resolveCliToolSelectionScope).toHaveBeenLastCalledWith(
      expect.objectContaining({ cliToolScope: [] })
    )
  })

  it('cli_tool_find hands findCliTools the resolved list, never the payload list', async () => {
    await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'user-1',
      action: 'cli_tool_find',
      payloadInput: { query: 'tool', selectedToolIds: ['b_tool'] },
      context: primaryContext,
      actorType: 'session'
    })

    expect(cliMocks.resolveCliToolSelectionScope).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'agent-1',
      selectedToolIds: ['b_tool']
    })
    const params = cliMocks.findCliTools.mock.calls[0][0]
    expect(params.cliToolScope).toEqual(['a_tool'])
    expect(params.selectedToolIds).toBeUndefined()
  })

  it("batshit_tool_use: a cli: ref runs inside the resolved list, not the payload's", async () => {
    await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'user-1',
      action: 'batshit_tool_use',
      payloadInput: { ref: 'cli:b_tool', input: {}, selectedToolIds: ['b_tool'] },
      context: primaryContext,
      projectPath: '/tmp',
      actorType: 'session'
    })

    expect(cliMocks.resolveCliToolSelectionScope).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'agent-1',
      selectedToolIds: ['b_tool']
    })
    const params = cliMocks.executeCliTool.mock.calls[0]?.[0]
    expect(params).toBeDefined()
    expect(params.toolId).toBe('b_tool')
    expect(params.cliToolScope).toEqual(['a_tool'])
    expect(params.selectedToolIds).toBeUndefined()
  })
})
