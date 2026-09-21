import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Batshit Tool broker's plumbing is the server's, never the model's (bug sweep, 2026-09-18).
 *
 * `native_batshit_tool_use`'s input schema passes unknown keys through on purpose (a model may put
 * a tool's fields at the top level), and the API lane spread that input into the broker call
 * without setting `agentMetadata` after it. `resolveDynamicMcpGatewayScope` prefers
 * `agentMetadata.defaultMCPGateways` over the agent's own record when the send selected no
 * gateways, so a model that sent an `agentMetadata` of its own chose its own MCP gateway scope.
 * The managed CLI lanes set it after the spread, so the dispatch is pinned the same way.
 */

const scopeCalls = vi.hoisted(() => [] as Array<Record<string, any>>)

vi.mock('$lib/server/services/mcpSelectionResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/mcpSelectionResolver')>()
  return {
    ...actual,
    resolveDynamicMcpGatewayScope: vi.fn(async (options: Record<string, any>) => {
      scopeCalls.push(options)
      return { resolvedGateways: [], defaultGateways: [], source: 'agent' as const }
    })
  }
})

import { nativeToolService } from '$lib/server/services/nativeTools'
import { redis } from '$lib/server/redis'

const MCP_ONLY = {
  dynamicMcpEnabled: true,
  cliToolsEnabled: false,
  artifactRuntimeEnabled: false,
  batshitToolsEnabled: false,
  fetchZipEnabled: false,
  agentBrowserEnabled: false,
  webSearchEnabled: false,
  bashEnabled: false
}

/** What a model might add beside its call: a scope of its own, and the other server keys. */
const MODEL_PLUMBING = {
  agentMetadata: { defaultMCPGateways: ['gw-the-agent-was-not-given'] },
  agentId: 'someone-else',
  userId: 'someone-else',
  sessionId: 'someone-elses-chat',
  delegatedRun: false,
  actorType: 'service'
}

describe('the Batshit Tool broker: plumbing is the server', () => {
  beforeEach(() => {
    scopeCalls.length = 0
  })

  it('an API agent cannot name its own MCP gateway scope', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      agentId: 'agent-broker-scope',
      sessionId: 'session-broker-scope',
      providerSettings: { nativeTools: MCP_ONLY },
      selectedCliToolIds: []
    } as any)

    await (tools as any).native_batshit_tool_use.execute({
      ref: 'mcp:any_tool',
      input: {},
      ...MODEL_PLUMBING
    })

    expect(scopeCalls.length).toBeGreaterThan(0)
    for (const call of scopeCalls) {
      expect(call).toMatchObject({ userId: 'josh', agentId: 'agent-broker-scope', agentMetadata: null })
    }
  })

  it('an API agent cannot name its own MCP gateway scope for a search either', async () => {
    // The search tool's schema drops unknown keys before the SDK calls it; the broker does not
    // rely on that.
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      agentId: 'agent-broker-scope',
      sessionId: 'session-broker-scope',
      providerSettings: { nativeTools: MCP_ONLY },
      selectedCliToolIds: []
    } as any)

    await (tools as any).native_batshit_tool_search.execute({ family: 'mcp', query: 'anything', ...MODEL_PLUMBING })

    expect(scopeCalls.length).toBeGreaterThan(0)
    for (const call of scopeCalls) {
      expect(call).toMatchObject({ userId: 'josh', agentId: 'agent-broker-scope', agentMetadata: null })
    }
  })

  it('the dispatch (managed CLI helpers, n8n) keeps the scope the server resolved', async () => {
    await redis.set('agent:agent-broker-scope', {
      id: 'agent-broker-scope',
      user_id: 'josh',
      provider_specific_settings: { nativeTools: MCP_ONLY }
    } as any)

    await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'batshit_tool_use',
      payloadInput: { ref: 'mcp:any_tool', input: {}, ...MODEL_PLUMBING },
      context: { session_id: 'session-broker-scope', agent_id: 'agent-broker-scope', mode: 'mode2', actor_type: 'primary' }
    })

    expect(scopeCalls.length).toBeGreaterThan(0)
    for (const call of scopeCalls) {
      expect(call).toMatchObject({ userId: 'josh', agentMetadata: null })
      expect(call.agentId).not.toBe('someone-else')
    }
  })
})
