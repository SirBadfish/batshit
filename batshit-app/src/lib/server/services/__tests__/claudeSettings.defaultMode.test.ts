import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildClaudeRuntimeSettings } from '../claudeSettings'

/**
 * BL-959: the Claude mode Ask before edits (`default`) runs as `default`. It used to be turned
 * into `acceptEdits` (Edit automatically), so with Tool Approval set to all a file edit ran with no
 * card. The older value `chat` is `default` (the chat bar reads it so), `agent` is `acceptEdits`,
 * `agent_full` is `bypassPermissions`. A missing or unknown mode keeps `acceptEdits`: Agent
 * Settings shows Edit Automatically for it, and a Subagent or Worker (which never gets a card)
 * would have its edits refused under `default`. A chat send of such a record carries `default`
 * when the chat bar shows Ask before edits, so it runs as `default`.
 */

const mockWaitForSseExternalSubscriber = vi.fn(async (_timeoutMs: number) => true)
vi.mock('$lib/server/sseExternalSubscriber', () => ({
  waitForSseExternalSubscriber: mockWaitForSseExternalSubscriber
}))
vi.mock('$lib/server/services/mcpGatewayService', () => ({
  mcpGatewayService: { list: vi.fn(async () => []) }
}))
vi.mock('$lib/server/services/claudeCliStatus', () => ({
  detectClaudeCliStatus: vi.fn(),
  resolveClaudeCliExecutable: vi.fn(() => '/fake/claude')
}))

beforeAll(async () => {
  await import('../claudeBridge')
}, 60_000)

describe('BL-959: the saved Claude mode as it runs', () => {
  it.each([
    ['default', 'default'],
    ['chat', 'default'],
    ['acceptEdits', 'acceptEdits'],
    ['agent', 'acceptEdits'],
    ['plan', 'plan'],
    ['bypassPermissions', 'bypassPermissions'],
    ['agent_full', 'bypassPermissions'],
    ['something else', 'acceptEdits']
  ])('a saved %s runs as %s', (saved, runs) => {
    expect(buildClaudeRuntimeSettings({ permissionMode: saved as any, addDirs: [], allowedTools: [], disallowedTools: [] }).permissionMode).toBe(runs)
  })

  it('a record with no mode keeps Edit automatically; the older record reads default and chat as default', () => {
    expect(buildClaudeRuntimeSettings(null).permissionMode).toBe('acceptEdits')
    expect(buildClaudeRuntimeSettings({}).permissionMode).toBe('acceptEdits')
    expect(buildClaudeRuntimeSettings({ claude_model: 'opus' }).permissionMode).toBe('acceptEdits')
    expect(buildClaudeRuntimeSettings({ claude_permission_mode: 'default' }).permissionMode).toBe('default')
    expect(buildClaudeRuntimeSettings({ claude_permission_mode: 'chat' }).permissionMode).toBe('default')
  })

  it('a chat send of a record with no mode runs as default: the chat bar sends it when it shows Ask before edits', () => {
    expect(buildClaudeRuntimeSettings(null, { permissionMode: 'default' }).permissionMode).toBe('default')
    expect(buildClaudeRuntimeSettings({ claude_model: 'opus' }, { permissionMode: 'default' }).permissionMode).toBe('default')
  })
})

describe('BL-959: the Claude run of a saved default', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function run(options: {
    permissionMode: string
    toolApprovalMode: 'all' | 'off'
    agentPermissions?: { allowNetwork: boolean | null; allowFileEdits: boolean | null }
  }) {
    const { ClaudeBridge } = await import('../claudeBridge')
    const bridge = new ClaudeBridge() as any
    bridge.buildStreamJsonInput = vi.fn(async () => 'test input')
    bridge.loadAgentRecord = vi.fn(async () => null)
    bridge.resolveAgentPermissions = vi.fn(() => options.agentPermissions ?? { allowNetwork: null, allowFileEdits: null })
    bridge.resolveCliModel = vi.fn(() => 'claude-test')
    bridge.resolveWorkingDirectory = vi.fn(async () => '/tmp')
    bridge.resolveManagedMcpToolDenyList = vi.fn(async () => [])
    bridge.resolveSubagentPlanAllowTools = vi.fn(() => [])
    bridge.resolveManagedMcpToolAllowList = vi.fn(async () => [])
    bridge.resolveMode4InternalControlAllowTools = vi.fn(async () => ({ allowTools: [], disallowTools: [] }))
    bridge.resolveManagedStdioEnv = vi.fn(async () => ({}))
    bridge.resolveContextGuardConfig = vi.fn(async () => ({ contextWindow: null, threshold: null }))
    let captured: any
    bridge.runViaCli = vi.fn(async (_input: string, runOptions: any) => {
      captured = runOptions
      return { transport: 'cli', events: (async function* () {})(), cleanup: async () => {} }
    })
    // The route hands the bridge the runtime settings it built from the agent's record.
    await bridge.streamNativeMode({
      messages: [{ role: 'user', content: 'hello' }],
      claudeSettings: buildClaudeRuntimeSettings({ permissionMode: options.permissionMode as any, addDirs: [], allowedTools: [], disallowedTools: [] }),
      toolApprovalMode: options.toolApprovalMode
    } as any)
    return captured
  }

  it('with Tool Approval set to all: the permission mode default and the approval mode default', async () => {
    const captured = await run({ permissionMode: 'default', toolApprovalMode: 'all' })
    expect(captured.permissionMode).toBe('default')
    expect(captured.approvalMode).toBe('default')
    expect(captured.permissionPromptTool).toBe('mcp__batshit_gateway_claude-approvals__batshit_permission_prompt')
  })

  it('with Tool Approval off: dontAsk, as before', async () => {
    const captured = await run({ permissionMode: 'default', toolApprovalMode: 'off' })
    expect(captured.permissionMode).toBe('default')
    expect(captured.approvalMode).toBe('dontAsk')
    expect(captured.permissionPromptTool).toBeUndefined()
  })

  it('the agent permission clamp still holds on top', async () => {
    // File edits off: the most a run gets is default.
    const clamped = await run({ permissionMode: 'bypassPermissions', toolApprovalMode: 'all', agentPermissions: { allowNetwork: null, allowFileEdits: false } })
    expect(clamped.permissionMode).toBe('default')
    expect(clamped.approvalMode).toBe('default')
    // A clamp that allows more never raises a saved default.
    const kept = await run({ permissionMode: 'default', toolApprovalMode: 'all', agentPermissions: { allowNetwork: true, allowFileEdits: true } })
    expect(kept.permissionMode).toBe('default')
    // Plan stays Plan under any clamp.
    const plan = await run({ permissionMode: 'plan', toolApprovalMode: 'all', agentPermissions: { allowNetwork: null, allowFileEdits: false } })
    expect(plan.permissionMode).toBe('plan')
  })
})
