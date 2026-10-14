import { beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { mintRunCredential } from '$lib/server/services/agentRunCredentials'

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }))
vi.mock('$lib/server/services/nativeTools', () => ({
  nativeToolService: { dispatchNativeAutomationPackAction: mocks.dispatch }
}))

import { POST } from './+server'

useRedisTestServer()

const userId = 'dispatch-owner-user'
const parentId = 'dispatch-owner-parent'

function helperRequest(token: string, body: Record<string, unknown>) {
  return new Request('http://localhost/api/native-tools/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-batshit-agent-token': token },
    body: JSON.stringify(body)
  })
}

beforeEach(async () => {
  mocks.dispatch.mockReset().mockResolvedValue({ success: true, data: {} })
  await redis.createAgent({ id: parentId, user_id: userId, displayName: 'Parent',
    agentType: 'api', primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4-5' } as any)
})

describe('delegated Native Bash owner from a real run credential', () => {
  it('maps a named Subagent helper context to its stored owner and parent', async () => {
    const subagentId = 'dispatch-owner-subagent'
    await redis.json.set(`subagent:${subagentId}`, '$', { id: subagentId, user_id: userId } as never)
    const minted = await mintRunCredential({ userId, agentId: 'subagent_cli_dispatch_named',
      sessionId: 'session-bound', runtime: 'codex', delegated: true,
      scopeAgentId: subagentId, allowedControlIds: [],
      processOwner: { userId, kind: 'subagent', id: subagentId },
      commandParentAgentId: parentId })

    const response = await POST({ request: helperRequest(minted.token, {
      action: 'bash_execute', input: { command: 'pwd' },
      processOwner: { userId, kind: 'agent', id: 'forged-owner' },
      commandParentAgentId: 'forged-parent',
      context: { session_id: 'forged-session', mode: 'mode4', actor_type: 'primary',
        parent_agent_id: 'forged-parent' }
    }), locals: {} } as any)

    expect(response.status).toBe(200)
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      delegatedRun: true,
      processOwner: { userId, kind: 'subagent', id: subagentId },
      context: expect.objectContaining({ session_id: 'session-bound', actor_type: 'subagent',
        agent_id: subagentId, parent_agent_id: parentId })
    }))
  })

  it('maps a Worker to its parent primary and refuses its token after parent deletion', async () => {
    const minted = await mintRunCredential({ userId, agentId: 'subagent_cli_dispatch_worker',
      sessionId: 'session-bound', runtime: 'claude', delegated: true,
      scopeAgentId: 'worker_dispatch_owner', allowedControlIds: [],
      processOwner: { userId, kind: 'agent', id: parentId },
      commandParentAgentId: parentId })
    const body = { action: 'bash_execute', input: { command: 'pwd' },
      context: { session_id: 'session-bound', mode: 'mode4', actor_type: 'primary',
        parent_agent_id: 'forged-parent' } }

    const accepted = await POST({ request: helperRequest(minted.token, body), locals: {} } as any)
    expect(accepted.status).toBe(200)
    const dispatched = mocks.dispatch.mock.calls[0][0]
    expect(dispatched.context).toMatchObject({ actor_type: 'primary', agent_id: parentId })
    expect(dispatched.context).not.toHaveProperty('parent_agent_id')

    mocks.dispatch.mockClear()
    await redis.del(`agent:${parentId}`)
    const refused = await POST({ request: helperRequest(minted.token, body), locals: {} } as any)
    expect(refused.status).toBe(401)
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
})
