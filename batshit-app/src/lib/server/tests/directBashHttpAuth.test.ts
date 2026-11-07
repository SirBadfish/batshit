import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'

const bash = vi.hoisted(() => vi.fn(async () => ({ success: true })))
vi.mock('$lib/server/services/nativeTools', () => ({
  nativeToolService: { nativeBashExecute: (...args: any[]) => bash(...args) }
}))

useRedisTestServer()

describe('direct Bash route over disposable HTTP with retired credential refusal', () => {
  beforeEach(() => bash.mockClear())
  afterEach(() => vi.unstubAllGlobals())

  it('refuses retired run tokens before a caller-controlled approval reaches Bash', async () => {
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
      expect((await call('arc_retired_subagent.bsac_secret')).status).toBe(401)
      expect((await call('arc_retired_primary.bsac_secret')).status).toBe(401)
      expect(bash).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      )
    }
  })
})
