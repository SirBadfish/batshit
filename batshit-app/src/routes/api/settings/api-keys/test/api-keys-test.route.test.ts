// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-120 (Josh, 2026-09-17): the TypeSafe key's Test button lives in Settings → API Keys with
 * every other key, and it is the one key test that really contacts the provider: one fixed
 * sample question to Jev. It lives in this ROUTE and not in `apiKeyService`, because that
 * service is reachable from the Fabric risk gate's modules, which must never reach the Jev
 * client (DL-120-12). Every other provider keeps the format-only check.
 */

const state = vi.hoisted(() => ({
  outcome: null as unknown,
  calls: [] as unknown[]
}))

vi.mock('$lib/server/services/typesafe/typesafeClient', () => ({
  getTypesafeClient: () => ({
    systemOne: vi.fn(async (request: unknown) => {
      state.calls.push(request)
      return state.outcome
    })
  })
}))

vi.mock('$lib/server/services/typesafe/typesafeConfig', () => ({
  getTypesafeConfig: vi.fn(async () => ({ enabled: false, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null }))
}))

vi.mock('$lib/services/apiKey.server', () => ({
  normalizeApiKeyServiceName: (service: string) => service.trim().toLowerCase(),
  apiKeyService: {
    validateWithRateLimit: vi.fn(async () => ({ valid: true })),
    testApiKey: vi.fn(async () => ({ success: true, formatValid: true, verified: false, message: 'format only' }))
  }
}))

const { POST } = await import('./+server')

const KEY = 'ts_test_key_1234567890abcdef' // gitleaks:allow (fake test key)

function event(body: unknown, user: { id: string } | null = { id: 'josh' }) {
  return { request: new Request('http://localhost/api/settings/api-keys/test', { method: 'POST', body: JSON.stringify(body) }), locals: { user } } as any
}

beforeEach(() => {
  state.outcome = null
  state.calls = []
})

describe('POST /api/settings/api-keys/test for TypeSafe', () => {
  it('asks Jev one fixed sample question with the given key, ignoring the master switch, and reports the answer time', async () => {
    state.outcome = {
      status: 'ok',
      latencyMs: 188,
      response: { model: 'jev-1.13.0', usage: null, answers: { good_news: { noul: 0.97 } } }
    }
    const response = await POST(event({ service: 'typesafe', apiKey: KEY }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, formatValid: true, verified: true, message: 'jev-1.13.0 answered in 188 ms.' })

    expect(state.calls).toHaveLength(1)
    const request = state.calls[0] as Record<string, unknown>
    expect(request.apiKey).toBe(KEY)
    expect(request.model).toBe('jev-1.13.0')
    // A constant state: never chat text.
    expect(request.state).toEqual({ message: 'The build passed and every test is green.' })
    expect(Object.keys(request.questions as object)).toEqual(['good_news'])
  })

  it('reports a rejected key as a failure the user can read, never as a thrown error', async () => {
    state.outcome = { status: 'error', reason: 'unauthorized', latencyMs: 120, detail: null }
    const response = await POST(event({ service: 'typesafe', apiKey: KEY }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ success: false, error: 'TypeSafe rejected the key.' })
  })

  it('carries the vendor detail when there is one', async () => {
    state.outcome = { status: 'error', reason: 'bad_request', latencyMs: 90, detail: 'model not found' }
    const response = await POST(event({ service: 'typesafe', apiKey: KEY }))
    expect((await response.json()).error).toBe('TypeSafe rejected the request. (model not found)')
  })

  it('refuses a signed-out caller and an empty key before contacting anyone', async () => {
    expect((await POST(event({ service: 'typesafe', apiKey: KEY }, null))).status).toBe(401)
    expect((await POST(event({ service: 'typesafe', apiKey: '' }))).status).toBe(400)
    expect(state.calls).toHaveLength(0)
  })

  it('leaves every other provider on the format-only check', async () => {
    const response = await POST(event({ service: 'openai', apiKey: 'sk-' + 'a'.repeat(40) }))
    expect(response.status).toBe(200)
    expect((await response.json()).verified).toBe(false)
    expect(state.calls).toHaveLength(0)
  })
})
