import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

// Exercise the real auth resolver, routes, dispatch, and Fabric gate with the default
// in-memory Redis fake and the RedisJSON lane. Only the host/operator effect is replaced.
const operator = vi.hoisted(() => ({ controlRuntimeAddon: vi.fn() }))
vi.mock('$lib/server/services/runtimeAddons', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/runtimeAddons')>()),
  controlRuntimeAddon: operator.controlRuntimeAddon
}))

import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  AGENT_RUN_CREDENTIAL_HEADER,
  mintRunCredential,
  revokeRunCredential
} from '$lib/server/services/agentRunCredentials'
import {
  createN8nSseCallbackToken,
  N8N_NATIVE_TOOL_CALLBACK_TOKEN_HEADER
} from '$lib/server/services/n8nCallbackTokens'
import { sweepSessionApprovals } from '$lib/server/services/controlApprovals'
import { POST as dispatch } from './+server'
import { POST as useControl } from '../../controls/use/+server'

useRedisTestServer()
const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

describe('BL-933 runtime add-on consent on authenticated HTTP routes', () => {
  it('refuses direct Codex/Claude and delegated calls while retaining other lanes and Fabric approval', async () => {
    const suffix = randomUUID()
    const userId = `addon-consent-user-${suffix}`
    const agentId = `addon_consent_agent_${suffix.replaceAll('-', '')}`
    const runtimeId = `subagent_cli_${suffix.replaceAll('-', '')}`
    const workerScopeId = `worker_${suffix.replaceAll('-', '')}`
    const sessionId = `addon-consent-session-${suffix}`
    const messageId = `addon-consent-message-${suffix}`
    const agentKey = `agent:${agentId}`
    const previousServiceToken = env.BATSHIT_TOKEN
    env.BATSHIT_TOKEN = `addon-consent-service-${suffix}`
    const credentials: { credentialId: string; agentId: string }[] = []
    const server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
        const pathname = new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname
        const route = pathname === '/api/controls/use' ? useControl : dispatch
        const reply = await route({
          // SvelteKit supplies locals after sign-in; the test's session URL selects that lane.
          locals: { user: incoming.headers['x-test-signed-in'] === 'yes' ? { id: userId } : null },
          request: new Request(`http://127.0.0.1${incoming.url}`, {
            method: incoming.method,
            headers: incoming.headers as HeadersInit,
            body: Buffer.concat(chunks)
          })
        } as any)
        outgoing.writeHead(reply.status, Object.fromEntries(reply.headers))
        outgoing.end(Buffer.from(await reply.arrayBuffer()))
      } catch (error) {
        outgoing.writeHead(500, { 'content-type': 'application/json' })
        outgoing.end(JSON.stringify({ error: String(error) }))
      }
    })

    try {
      await redis.set(agentKey, {
        id: agentId, user_id: userId, agentType: 'cli',
        provider_specific_settings: { nativeTools: { batshitToolsEnabled: true } }
      } as any)
      operator.controlRuntimeAddon.mockReset()
      operator.controlRuntimeAddon.mockImplementation(async (addonId: string, operation: string) => ({
        success: true, addonId, operation, alreadySatisfied: false
      }))
      const codex = await mintRunCredential({ userId, agentId, sessionId, runtime: 'codex' })
      const claude = await mintRunCredential({ userId, agentId, sessionId, runtime: 'claude' })
      credentials.push({ credentialId: codex.credentialId, agentId },
        { credentialId: claude.credentialId, agentId })
      const delegated = await mintRunCredential({
        userId, agentId: runtimeId, sessionId, runtime: 'codex', delegated: true,
        scopeAgentId: workerScopeId, allowedControlIds: [],
        processOwner: { userId, kind: 'agent', id: agentId }, commandParentAgentId: agentId
      })
      credentials.push({ credentialId: delegated.credentialId, agentId: runtimeId })
      const workflowId = `subagent_workflow_${suffix.replaceAll('-', '')}`
      const callback = await createN8nSseCallbackToken({ userId, agentId, subagentId: workflowId, sessionId, messageId })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('HTTP fixture has no port')
      const base = `http://127.0.0.1:${address.port}`
      const context = { session_id: sessionId, agent_id: agentId, mode: 'mode2', actor_type: 'primary' }
      const post = async (route: string, body: Record<string, unknown>, headers: Record<string, string>) => {
        const response = await fetch(`${base}${route}`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body)
        })
        return { status: response.status, body: await response.json() as any }
      }
      const actionBody = (action: string, input: Record<string, unknown> = { addon_id: 'fbx2vrma' }) => ({
        userId, action, input, context
      })

      for (const [runtime, token] of [['codex', codex.token], ['claude', claude.token]] as const) {
        for (const [action, controlRef] of [
          ['runtime_addon_start', 'fabric:sys.runtime_addon.start'],
          ['runtime_addon_stop', 'fabric:sys.runtime_addon.stop']
        ] as const) {
          const result = await post('/api/native-tools/dispatch', {
            ...actionBody(action), actorType: 'session', allowRisky: true,
            approval: { approved: true },
            input: { addon_id: 'fbx2vrma', allowRisky: true, approval: { approved: true } }
          }, { [AGENT_RUN_CREDENTIAL_HEADER]: token })
          expect.soft(result.status, `${runtime} ${action}`).toBe(403)
          expect.soft(result.body).toMatchObject({ auth: 'agent', success: false,
            error: { code: 'ACTION_DISABLED', details: { controlRef } } })
          expect.soft(result.body.error?.message).toContain(controlRef)
          expect.soft(operator.controlRuntimeAddon).not.toHaveBeenCalled()
        }
      }

      // Toggle and schema refusals still precede the new lane gate.
      await redis.set(agentKey, { id: agentId, user_id: userId,
        provider_specific_settings: { nativeTools: { batshitToolsEnabled: false } } } as any)
      const off = await post('/api/native-tools/dispatch', actionBody('runtime_addon_start'),
        { [AGENT_RUN_CREDENTIAL_HEADER]: codex.token })
      expect(off.status).toBe(403)
      expect(off.body.error).toMatchObject({ code: 'ACTION_DISABLED' })
      expect(off.body.error.details?.controlRef).toBeUndefined()
      await redis.set(agentKey, { id: agentId, user_id: userId,
        provider_specific_settings: { nativeTools: { batshitToolsEnabled: true } } } as any)
      const invalid = await post('/api/native-tools/dispatch',
        actionBody('runtime_addon_start', { addon_id: 'not-an-addon' }),
        { [AGENT_RUN_CREDENTIAL_HEADER]: codex.token })
      expect(invalid.status).toBe(400)
      expect(invalid.body.error.code).toBe('INVALID_INPUT')
      expect(operator.controlRuntimeAddon).not.toHaveBeenCalled()

      // The delegated virtual ID is credential-bound. This action has no Bash-style owner
      // remap, so it is refused as INVALID_CONTEXT before the new agent-lane guard.
      const delegatedCall = await post('/api/native-tools/dispatch', {
        ...actionBody('runtime_addon_start'),
        context: { ...context, agent_id: runtimeId, parent_agent_id: agentId }
      }, { [AGENT_RUN_CREDENTIAL_HEADER]: delegated.token })
      expect(delegatedCall.status).toBe(400)
      expect(delegatedCall.body.error.code).toBe('INVALID_CONTEXT')
      expect(operator.controlRuntimeAddon).not.toHaveBeenCalled()

      // Fabric's dynamic registry uses the real Redis client API, absent from the default
      // fake. Prove that existing approval path only in the isolated real-Redis lane.
      if (REAL_REDIS_LANE) {
        // The consent-bearing Fabric control still pauses, even with caller-supplied bypass
        // flags; its confirm-risk handler cannot reach the operator before a user approval.
        for (const operation of ['start', 'stop'] as const) {
          const fabric = await post('/api/controls/use', {
            controlId: `sys.runtime_addon.${operation}`, input: { addonId: 'fbx2vrma' },
            allowRisky: true, approval: { approved: true }
          }, { [AGENT_RUN_CREDENTIAL_HEADER]: codex.token })
          expect(fabric.status).toBe(403)
          expect(fabric.body).toMatchObject({ auth: 'agent', actingAgentId: agentId,
            success: false, error: { code: 'CONTROL_RISK_REQUIRES_APPROVAL' } })
          expect(operator.controlRuntimeAddon).not.toHaveBeenCalled()
        }
        const delegatedFabric = await post('/api/controls/use', {
          controlId: 'sys.runtime_addon.start', input: { addonId: 'fbx2vrma' },
          allowRisky: true
        }, { [AGENT_RUN_CREDENTIAL_HEADER]: delegated.token })
        expect(delegatedFabric.status).toBe(403)
        expect(delegatedFabric.body.error.code).toBe('CONTROL_NOT_ALLOWED')
        expect(operator.controlRuntimeAddon).not.toHaveBeenCalled()
      }

      // Existing trusted lanes retain their direct operator action. The session fixture
      // supplies SvelteKit locals; service and n8n use real tokens and the same route.
      const signedIn = await post('/api/native-tools/dispatch', actionBody('runtime_addon_start'),
        { 'x-test-signed-in': 'yes' })
      expect(signedIn.status).toBe(200)
      expect(signedIn.body).toMatchObject({ auth: 'session', success: true })
      const service = await post('/api/native-tools/dispatch', actionBody('runtime_addon_stop'), {
        'x-batshit-service-token': env.BATSHIT_TOKEN,
        'x-batshit-user-id': userId
      })
      expect(service.status).toBe(200)
      expect(service.body).toMatchObject({ auth: 'service', success: true })
      const n8n = await post('/api/native-tools/dispatch', {
        ...actionBody('runtime_addon_start'),
        context: { ...context, message_id: messageId, actor_type: 'subagent',
          agent_id: workflowId, parent_agent_id: agentId }
      }, { [N8N_NATIVE_TOOL_CALLBACK_TOKEN_HEADER]: callback.token })
      expect(n8n.status).toBe(200)
      expect(n8n.body).toMatchObject({ auth: 'n8n-callback', success: true })
      expect(operator.controlRuntimeAddon.mock.calls).toEqual([
        ['fbx2vrma', 'start'], ['fbx2vrma', 'stop'], ['fbx2vrma', 'start']
      ])
    } finally {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      for (const credential of credentials) {
        await revokeRunCredential(credential.credentialId, { agentId: credential.agentId })
      }
      await redis.del(agentKey)
      await redis.del(`n8n:sse-callback:${sessionId}:${messageId}`)
      await sweepSessionApprovals(sessionId)
      await redis.execute(async (client) => {
        const recentKey = `recent_control_executions:${userId}`
        const auditKeys = await client.lRange(recentKey, 0, -1)
        for (const key of [...auditKeys, recentKey, `control_registry:${userId}`]) {
          await client.del(key)
        }
      })
      env.BATSHIT_TOKEN = previousServiceToken
      operator.controlRuntimeAddon.mockReset()
    }
  }, 20000)
})
