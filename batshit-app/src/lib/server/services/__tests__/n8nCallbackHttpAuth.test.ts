import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { createN8nSseCallbackToken } from '../n8nCallbackTokens'

const dispatch = vi.hoisted(() => vi.fn(async () => ({ success: true, data: { ok: true } })))
vi.mock('../nativeTools', () => ({
  nativeToolService: { dispatchNativeAutomationPackAction: (...args: any[]) => dispatch(...args) }
}))

useRedisTestServer()

describe('Workflow Subagent callback over disposable HTTP', () => {
  it('accepts its bound identity and refuses a forged or absent one before dispatch', async () => {
    dispatch.mockClear()
    const callback = await createN8nSseCallbackToken({
      sessionId: 'session_http', messageId: 'message_http', userId: 'user_http',
      agentId: 'parent_http', subagentId: 'workflow_http'
    })
    const { POST } = await import('../../../../routes/api/native-tools/dispatch/+server')
    const server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
        const request = new Request(`http://127.0.0.1${incoming.url}`, {
          method: incoming.method,
          headers: incoming.headers as HeadersInit,
          body: Buffer.concat(chunks)
        })
        const result = await POST({ request, locals: { user: null } } as any)
        outgoing.writeHead(result.status, Object.fromEntries(result.headers))
        outgoing.end(Buffer.from(await result.arrayBuffer()))
      } catch (error) {
        outgoing.writeHead(500)
        outgoing.end(String(error))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP fixture has no port')
    const endpoint = `http://127.0.0.1:${address.port}/api/native-tools/dispatch`
    const call = (agentId: string | undefined, topLevelAgentId?: string) => fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-batshit-native-tool-token': callback.token
      },
      body: JSON.stringify({
        userId: 'user_http', agentId: topLevelAgentId,
        action: 'runtime_addon_list', input: {},
        context: {
          session_id: 'session_http', message_id: 'message_http',
          agent_id: agentId, parent_agent_id: 'parent_http',
          primary_agent_type: 'n8n', actor_type: 'subagent'
        }
      })
    })

    try {
      const valid = await call('workflow_http')
      expect(valid.status).toBe(200)
      expect(dispatch).toHaveBeenCalledOnce()
      const forged = await call('other_workflow', 'workflow_http')
      expect(forged.status).toBe(401)
      const missing = await call(undefined, 'workflow_http')
      expect(missing.status).toBe(401)
      expect(dispatch).toHaveBeenCalledOnce()
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      )
    }
  })
})
