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
import { sweepSessionApprovals } from '$lib/server/services/controlApprovals'
import { POST as dispatch } from './+server'
import { POST as useControl } from '../../controls/use/+server'

useRedisTestServer()
const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

describe('BL-933 runtime add-on consent on authenticated HTTP routes', () => {
  it('refuses retired headers while retaining validation, other lanes and Fabric approval', async () => {
    const suffix = randomUUID()
    const userId = `addon-consent-user-${suffix}`
    const agentId = `addon_consent_agent_${suffix.replaceAll('-', '')}`
    const sessionId = `addon-consent-session-${suffix}`
    const messageId = `addon-consent-message-${suffix}`
    const agentKey = `agent:${agentId}`
    const previousServiceToken = env.BATSHIT_TOKEN
    env.BATSHIT_TOKEN = `addon-consent-service-${suffix}`
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
        id: agentId, user_id: userId, agentType: 'api',
        provider_specific_settings: { nativeTools: { batshitToolsEnabled: true } }
      } as any)
      operator.controlRuntimeAddon.mockReset()
      operator.controlRuntimeAddon.mockImplementation(async (addonId: string, operation: string) => ({
        success: true, addonId, operation, alreadySatisfied: false
      }))
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

      for (const action of ['runtime_addon_start', 'runtime_addon_stop']) {
        const result = await post('/api/native-tools/dispatch', {
          ...actionBody(action), actorType: 'session', allowRisky: true,
          approval: { approved: true }
        }, { 'x-batshit-agent-token': 'arc_retired.bsac_secret', 'x-test-signed-in': 'yes' })
        expect(result.status).toBe(401)
        expect(operator.controlRuntimeAddon).not.toHaveBeenCalled()
      }
      // A session's invalid input is still refused before the operator.
      const invalid = await post('/api/native-tools/dispatch', actionBody('runtime_addon_start', { addon_id: 'not-an-addon' }),
        { 'x-test-signed-in': 'yes' })
      expect(invalid.status).toBe(400)
      expect(invalid.body.error.code).toBe('INVALID_INPUT')
      expect(operator.controlRuntimeAddon).not.toHaveBeenCalled()
      if (REAL_REDIS_LANE) {
        for (const operation of ['start', 'stop'] as const) {
          const fabric = await post('/api/controls/use', {
            controlId: `sys.runtime_addon.${operation}`, input: { addonId: 'fbx2vrma' },
            allowRisky: true, approval: { approved: true }
          }, { 'x-batshit-service-token': env.BATSHIT_TOKEN, 'x-batshit-user-id': userId })
          expect(fabric.status).toBe(403)
          expect(fabric.body).toMatchObject({ auth: 'service', success: false,
            error: { code: 'CONTROL_RISK_REQUIRES_APPROVAL' } })
          expect(operator.controlRuntimeAddon).not.toHaveBeenCalled()
        }
      }

      // Existing trusted lanes retain their direct operator action. The session fixture
      // supplies SvelteKit locals; service uses a real token and the same route.
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
      expect(operator.controlRuntimeAddon.mock.calls).toEqual([
        ['fbx2vrma', 'start'], ['fbx2vrma', 'stop']
      ])
    } finally {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      await redis.del(agentKey)
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
