import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { mintRunCredential, revokeRunCredential } from '$lib/server/services/agentRunCredentials'

const bash = vi.hoisted(() => vi.fn(async () => ({ success: true })))
vi.mock('$lib/server/services/nativeTools', () => ({
  nativeToolService: { nativeBashExecute: (...args: any[]) => bash(...args) }
}))

useRedisTestServer()

describe('direct Bash route over disposable HTTP with real run-credential authentication', () => {
  beforeEach(() => bash.mockClear())
  afterEach(() => vi.unstubAllGlobals())

  it('refuses a minted delegated or primary run token before a caller-controlled approval reaches Bash', async () => {
    await redis.set('agent:primary_http', { user_id: 'user_http' })
    const delegated = await mintRunCredential({
      userId: 'user_http', agentId: 'subagent_cli_http', sessionId: 'session_http',
      runtime: 'codex', delegated: true, scopeAgentId: 'worker_http', allowedControlIds: []
    })
    const primary = await mintRunCredential({
      userId: 'user_http', agentId: 'primary_http', sessionId: 'session_http', runtime: 'codex'
    })
    const { POST } = await import('../../../routes/api/native-tools/bash/execute/+server')
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
    const url = `http://127.0.0.1:${address.port}/api/native-tools/bash/execute`
    const call = (token: string) => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-batshit-agent-token': token },
      body: JSON.stringify({
        command: 'touch /tmp/bl126-http', accessMode: 'dangerous', approved: true,
        requireApproval: false, backend: 'local'
      })
    })

    try {
      const delegatedReply = await call(delegated.token)
      expect(delegatedReply.status).toBe(403)
      expect((await delegatedReply.json()).code).toBe('CONTROL_NOT_ALLOWED')
      const primaryReply = await call(primary.token)
      expect(primaryReply.status).toBe(403)
      expect((await primaryReply.json()).code).toBe('DIRECT_BASH_NOT_ALLOWED')
      expect(bash).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      )
      await revokeRunCredential(delegated.credentialId)
      await revokeRunCredential(primary.credentialId)
    }
  })
})
