import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BL-704 — real routes, the REAL resolver, REAL Portable Skill Token records.
 *
 * `resolveNativeToolUser` is not mocked anywhere in this file: every request carries a token
 * minted by `createPortableSkillToken`, and every route answers from what the resolver really
 * admits. Only each route's EFFECT is replaced by a spy (the saved-CLI runner, the native
 * dispatcher, Bash, Agent Browser, Dynamic MCP's gateway load, the ComfyUI proxy's upstream
 * `fetch`, and on the control routes `findControls` / `useControl` / the approval-card lookup),
 * so a refusal is proven to land BEFORE anything happens.
 *
 * Every refusal row also carries a signed-in cookie user: a presented portable header that a
 * route does not admit must never be served as that session instead.
 */

const effects = vi.hoisted(() => ({
  executeCliTool: vi.fn(),
  dispatchNativeAutomationPackAction: vi.fn(),
  nativeBashExecute: vi.fn(),
  nativeAgentBrowserFind: vi.fn(),
  nativeAgentBrowserUse: vi.fn(),
  loadToolsForUser: vi.fn(),
  resolveDynamicMcpGatewayScope: vi.fn(),
  findControls: vi.fn(),
  useControl: vi.fn(),
  resolveApprovalCardTarget: vi.fn()
}))

vi.mock('$lib/server/services/cliToolRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/cliToolRegistry')>()),
  executeCliTool: effects.executeCliTool
}))

vi.mock('$lib/server/services/nativeTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/nativeTools')>()
  return {
    ...actual,
    nativeToolService: {
      dispatchNativeAutomationPackAction: effects.dispatchNativeAutomationPackAction,
      nativeBashExecute: effects.nativeBashExecute,
      nativeAgentBrowserFind: effects.nativeAgentBrowserFind,
      nativeAgentBrowserUse: effects.nativeAgentBrowserUse
    }
  }
})

vi.mock('$lib/server/services/mcpGatewayDiscovery', () => ({
  mcpGatewayDiscovery: { loadToolsForUser: effects.loadToolsForUser }
}))

vi.mock('$lib/server/services/mcpSelectionResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/mcpSelectionResolver')>()),
  resolveDynamicMcpGatewayScope: effects.resolveDynamicMcpGatewayScope
}))

vi.mock('$lib/server/services/fabricRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/fabricRegistry')>()),
  findControls: effects.findControls,
  useControl: effects.useControl
}))

vi.mock('$lib/server/services/controlApprovals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/controlApprovals')>()
  effects.resolveApprovalCardTarget.mockImplementation(actual.resolveApprovalCardTarget)
  return { ...actual, resolveApprovalCardTarget: effects.resolveApprovalCardTarget }
})

import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  PORTABLE_SKILL_TOKEN_HEADER,
  createPortableSkillToken,
  getPortableSkillAllowedControlIds,
  listPortableSkillTokens
} from '$lib/server/services/portableSkillTokens'
import type { PortableSkillFamilyId } from '$lib/types/portableSkills'
import { POST as cliExecute } from '../../../routes/api/cli-tools/execute/+server'
import { POST as nativeDispatch } from '../../../routes/api/native-tools/dispatch/+server'
import { POST as bashExecute } from '../../../routes/api/native-tools/bash/execute/+server'
import { POST as agentBrowser } from '../../../routes/api/native-tools/agent-browser/+server'
import { POST as mcpExecute } from '../../../routes/api/mcp/tools/execute/+server'
import { GET as comfyProxy } from '../../../routes/api/artifacts/comfyui/[...path]/+server'
import { POST as controlsFind } from '../../../routes/api/controls/find/+server'
import { POST as controlsUse } from '../../../routes/api/controls/use/+server'

useRedisTestServer()

const USER = 'user-zcbl704'
const AGENT = 'agent-zcbl704'
let fetchSpy: ReturnType<typeof vi.spyOn>

async function mintPortable(families: PortableSkillFamilyId[]) {
  const { token, record } = await createPortableSkillToken({
    userId: USER,
    label: 'zcbl704 route test',
    families
  })
  return { token, record }
}

function jsonEvent(path: string, token: string, body: Record<string, unknown>) {
  const url = new URL(`http://localhost${path}`)
  return {
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PORTABLE_SKILL_TOKEN_HEADER]: token },
      body: JSON.stringify(body)
    }),
    // A signed-in browser user on the same request: it must not rescue a refused token.
    locals: { user: { id: USER } },
    url,
    params: {}
  } as any
}

beforeEach(async () => {
  vi.clearAllMocks()
  for (const spy of [
    effects.executeCliTool,
    effects.dispatchNativeAutomationPackAction,
    effects.nativeBashExecute,
    effects.nativeAgentBrowserFind,
    effects.nativeAgentBrowserUse,
    effects.loadToolsForUser
  ]) {
    spy.mockResolvedValue({ success: true, sentinel: 'zcbl704-effect-ran' })
  }
  effects.resolveDynamicMcpGatewayScope.mockResolvedValue({
    resolvedGateways: ['gw_zcbl704'],
    defaultGateways: ['gw_zcbl704'],
    source: 'agent'
  })
  effects.findControls.mockResolvedValue({ controls: [], total: 0 })
  effects.useControl.mockResolvedValue({
    success: true,
    controlId: 'sys.cli_tool.test',
    dryRun: false,
    riskLevel: 'safe',
    status: 'published',
    result: { ok: true }
  })
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{"sentinel":"zcbl704-upstream"}', { status: 200 }))
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: 'zcbl704',
    agentType: 'api',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4-5'
  } as any)
})

afterEach(() => {
  fetchSpy.mockRestore()
})

describe('BL-704: a Portable Skill Token is refused on helper routes before any effect', () => {
  it('saved CLI execute (the reported hole: an Artifacts token ran a saved CLI tool)', async () => {
    const { token } = await mintPortable(['artifacts'])
    const response = await cliExecute(
      jsonEvent('/api/cli-tools/execute', token, { toolId: 'cli_zcbl704', args: {} })
    )
    expect(response.status).toBe(401)
    expect(effects.executeCliTool).not.toHaveBeenCalled()
  })

  it('saved CLI execute refuses even a CLI Tools token: that family grants controls, not this route', async () => {
    const { token } = await mintPortable(['cli-tools'])
    const response = await cliExecute(
      jsonEvent('/api/cli-tools/execute', token, { toolId: 'cli_zcbl704', args: {} })
    )
    expect(response.status).toBe(401)
    expect(effects.executeCliTool).not.toHaveBeenCalled()
  })

  it('native dispatch', async () => {
    const { token } = await mintPortable(['voice-engines', 'artifacts', 'cli-tools', 'skills', 'goon-scenes'])
    const response = await nativeDispatch(
      jsonEvent('/api/native-tools/dispatch', token, {
        action: 'bash.execute',
        input: { command: 'echo zcbl704' },
        context: {}
      })
    )
    expect(response.status).toBe(401)
    expect(effects.dispatchNativeAutomationPackAction).not.toHaveBeenCalled()
  })

  it('direct Bash', async () => {
    const { token } = await mintPortable(['cli-tools'])
    const response = await bashExecute(
      jsonEvent('/api/native-tools/bash/execute', token, { command: 'echo zcbl704' })
    )
    expect(response.status).toBe(401)
    expect(effects.nativeBashExecute).not.toHaveBeenCalled()
  })

  it('Agent Browser', async () => {
    const { token } = await mintPortable(['artifacts'])
    const response = await agentBrowser(
      jsonEvent('/api/native-tools/agent-browser', token, { agentId: AGENT, action: 'find' })
    )
    expect(response.status).toBe(401)
    expect(effects.nativeAgentBrowserFind).not.toHaveBeenCalled()
    expect(effects.nativeAgentBrowserUse).not.toHaveBeenCalled()
  })

  it('Dynamic MCP execute', async () => {
    const { token } = await mintPortable(['voice-engines', 'artifacts', 'cli-tools', 'skills', 'goon-scenes'])
    const response = await mcpExecute(
      jsonEvent('/api/mcp/tools/execute', token, { toolName: 'zcbl704_tool', arguments: {} })
    )
    expect(response.status).toBe(401)
    expect(effects.resolveDynamicMcpGatewayScope).not.toHaveBeenCalled()
    expect(effects.loadToolsForUser).not.toHaveBeenCalled()
  })

  it('artifact forwarding (the ComfyUI proxy) never reaches its upstream', async () => {
    const { token } = await mintPortable(['artifacts'])
    const url = new URL('http://localhost/api/artifacts/comfyui/system_stats?baseUrl=comfyui_api_desktop')
    const response = await comfyProxy({
      request: new Request(url, { method: 'GET', headers: { [PORTABLE_SKILL_TOKEN_HEADER]: token } }),
      locals: { user: { id: USER } },
      url,
      params: { path: 'system_stats' }
    } as any)
    expect(response.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('BL-704: the two control routes still admit the token, scoped to its families', () => {
  it('control find shows only the token-derived list; a caller allowlist cannot widen it', async () => {
    const { token } = await mintPortable(['voice-engines'])
    const response = await controlsFind(
      jsonEvent('/api/controls/find', token, {
        query: 'cli',
        userId: 'somebody-else',
        allowedControlIds: ['sys.cli_tool.test', 'sys.artifact.create', 'sys.mcp.dynamic.use']
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, auth: 'portable-skill', userId: USER })
    expect(effects.findControls).toHaveBeenCalledTimes(1)
    expect(effects.findControls.mock.calls[0][0]).toMatchObject({
      userId: USER,
      allowedControlIds: getPortableSkillAllowedControlIds(['voice-engines'])
    })
  })

  it('control use runs an in-family control with scope-as-consent, the token list, and the audit', async () => {
    const { token, record } = await mintPortable(['cli-tools'])
    const response = await controlsUse(
      jsonEvent('/api/controls/use', token, {
        controlId: 'sys.cli_tool.test',
        input: { toolId: 'cli_zcbl704' },
        allowRisky: false,
        allowedControlIds: ['sys.artifact.create']
      })
    )
    expect(response.status).toBe(200)
    expect(effects.useControl).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        controlId: 'sys.cli_tool.test',
        allowRisky: true,
        actorType: 'portable-skill',
        allowedControlIds: getPortableSkillAllowedControlIds(['cli-tools'])
      })
    )
    const [saved] = (await listPortableSkillTokens(USER)).filter((entry) => entry.id === record.id)
    expect(saved?.lastUsedAt).toBeTruthy()
  })

  it('control use refuses a wrong-family control before the handler and before any approval', async () => {
    const { token, record } = await mintPortable(['artifacts'])
    const response = await controlsUse(
      jsonEvent('/api/controls/use', token, { controlId: 'sys.cli_tool.test', input: {} })
    )
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('CONTROL_NOT_ALLOWED')
    expect(effects.useControl).not.toHaveBeenCalled()
    expect(effects.resolveApprovalCardTarget).not.toHaveBeenCalled()
    // The refused attempt is still on the token's audit trail.
    const [saved] = (await listPortableSkillTokens(USER)).filter((entry) => entry.id === record.id)
    expect(saved?.lastUsedAt).toBeTruthy()
  })

  it('a revoked or unknown token on a control route is refused, not served as the signed-in user', async () => {
    const response = await controlsUse(
      jsonEvent('/api/controls/use', 'bspt_not_a_real_token_zcbl704', { controlId: 'sys.cli_tool.list', input: {} })
    )
    expect(response.status).toBe(401)
    expect(effects.useControl).not.toHaveBeenCalled()
  })
})
