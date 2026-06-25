// @vitest-environment node
// These proxies are server-only request handlers; node's native Request/
// FormData/File implementations parse multipart correctly (jsdom's do not).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/redis', () => ({ redis: {} }))

const ENV_KEYS = [
  'BATSHIT_TOKEN',
  'MCP_GATEWAY_AUTH_TOKEN',
  'BATSHIT_SERVER_URL',
  'PUBLIC_BATSHIT_SERVER_URL'
] as const
const savedEnv: Record<string, string | undefined> = {}

import { POST as clipsPOST } from './clips/+server'
import { POST as avatarPOST } from './avatar/+server'

function makeFormEvent(form: FormData, user: { id: string } | null = { id: 'user-1' }) {
  return {
    request: new Request('http://localhost/api/uploads/x', { method: 'POST', body: form }),
    locals: { user }
  } as never
}

describe('upload proxies', () => {
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
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  describe('/api/uploads/clips', () => {
    it('rejects unauthenticated requests', async () => {
      const response = await clipsPOST(makeFormEvent(new FormData(), null))
      expect(response.status).toBe(401)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('forwards with the service token and session-derived userId', async () => {
      const form = new FormData()
      form.append('files', new File(['fake-image'], 'photo.png', { type: 'image/png' }))
      form.append('compressionSettings', '{}')
      form.append('userId', 'spoofed-user') // must be ignored

      const response = await clipsPOST(makeFormEvent(form, { id: 'session-user' }))
      expect(response.status).toBe(200)

      const [url, init] = fetchSpy.mock.calls[0]
      expect(String(url)).toBe('http://batshit-server.test:5600/api/upload')
      expect((init.headers as Record<string, string>)['x-batshit-service-token']).toBe(
        'proxy-test-token'
      )
      const forwarded = init.body as FormData
      expect(forwarded.getAll('userId')).toEqual(['session-user'])
      expect(forwarded.getAll('files')).toHaveLength(1)
    })
  })

  describe('/api/uploads/avatar', () => {
    it('rejects unauthenticated requests', async () => {
      const response = await avatarPOST(makeFormEvent(new FormData(), null))
      expect(response.status).toBe(401)
    })

    it('rejects unknown entity types', async () => {
      const form = new FormData()
      form.append('file', new File(['x'], 'a.png', { type: 'image/png' }))
      form.append('entityType', 'mystery')
      const response = await avatarPOST(makeFormEvent(form))
      expect(response.status).toBe(400)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('forwards known entity types with the service token', async () => {
      const form = new FormData()
      form.append('file', new File(['x'], 'a.png', { type: 'image/png' }))
      form.append('entityType', 'agent')
      form.append('entityId', 'agent-1')

      const response = await avatarPOST(makeFormEvent(form))
      expect(response.status).toBe(200)

      const [url, init] = fetchSpy.mock.calls[0]
      expect(String(url)).toBe('http://batshit-server.test:5600/api/upload/avatar')
      expect((init.headers as Record<string, string>)['x-batshit-service-token']).toBe(
        'proxy-test-token'
      )
    })
  })
})
