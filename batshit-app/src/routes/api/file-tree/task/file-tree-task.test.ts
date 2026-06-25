import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/redis', () => ({ redis: {} }))

import { POST } from './+server'

function makeEvent(body: unknown, user: { id: string } | null = { id: 'user-1' }) {
  return {
    request: new Request('http://localhost/api/file-tree/task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user }
  } as never
}

const ENV_KEYS = ['BATSHIT_TOKEN', 'MCP_GATEWAY_AUTH_TOKEN', 'BATSHIT_SERVER_URL', 'BATSHIT_SERVER_API_URL', 'PUBLIC_BATSHIT_SERVER_URL'] as const
const savedEnv: Record<string, string | undefined> = {}

describe('/api/file-tree/task proxy', () => {
  const fetchSpy = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env.BATSHIT_TOKEN = 'proxy-test-token'
    process.env.BATSHIT_SERVER_URL = 'http://batshit-server.test:5600'
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  it('rejects unauthenticated requests', async () => {
    const response = await POST(makeEvent({ toolName: 'list_files' }, null))
    expect(response.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects tools outside the read-only allow-list', async () => {
    for (const toolName of ['execute_command', 'write_file', 'delete_file', 'constructor', '']) {
      const response = await POST(makeEvent({ toolName, input: {}, params: {} }))
      expect(response.status).toBe(403)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('forwards allow-listed tools with the service token', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ success: true, files: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )

    const response = await POST(
      makeEvent({
        toolName: 'list_files',
        input: { dirPath: '', maxDepth: 1 },
        params: { projectPath: '/tmp/project' }
      })
    )

    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe('http://batshit-server.test:5600/api/v1/task/s')
    expect((init.headers as Record<string, string>)['x-batshit-service-token']).toBe(
      'proxy-test-token'
    )
    const forwarded = JSON.parse(init.body as string)
    expect(forwarded.serviceName).toBe('built-in')
    expect(forwarded.toolName).toBe('list_files')
  })

  it('fails loudly when the service token is missing', async () => {
    delete process.env.BATSHIT_TOKEN
    await expect(POST(makeEvent({ toolName: 'read_file', input: {}, params: {} }))).rejects.toThrow(
      /BATSHIT_TOKEN/
    )
  })
})
