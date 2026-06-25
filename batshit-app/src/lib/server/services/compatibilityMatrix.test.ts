import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  expire: vi.fn()
}

const mockLoadN8nCompatibilitySnapshot = vi.fn()
const mockGetRuntimeEnv = vi.fn()
const mockRequireRuntimeEnv = vi.fn()

vi.mock('$lib/server/redis', () => ({ redis: mockRedis }))
vi.mock('$lib/server/services/n8nParameterCompatibility', () => ({
  loadN8nCompatibilitySnapshot: mockLoadN8nCompatibilitySnapshot
}))
vi.mock('$lib/server/services/runtimeEnv', () => ({
  getRuntimeEnv: mockGetRuntimeEnv,
  requireRuntimeEnv: mockRequireRuntimeEnv
}))
vi.mock('$lib/data/compatibility-matrix.seed', () => ({
  COMPATIBILITY_MATRIX_SEED: {
    version: 1,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    entries: []
  }
}))
vi.mock('$lib/data/compatibility-matrix.defaults', () => ({
  COMPATIBILITY_MATRIX_DEFAULT_ENTRIES: []
}))
vi.mock('$lib/utils/compatibilityMatrix', () => ({
  buildMatrixScope: vi.fn(),
  resolveMatrixFor: vi.fn()
}))

type JsonResponse = {
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}

function jsonResponse(payload: unknown, status = 200): JsonResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  }
}

describe('compatibility matrix loader precedence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    mockRedis.get.mockResolvedValue(null)
    mockRedis.set.mockResolvedValue('OK')
    mockRedis.expire.mockResolvedValue(1)
    mockLoadN8nCompatibilitySnapshot.mockResolvedValue(null)
    mockRequireRuntimeEnv.mockResolvedValue(null)
    global.fetch = vi.fn()
  })

  it('prefers Upstash over the public registry URL for force-refresh reads', async () => {
    mockGetRuntimeEnv.mockImplementation(async (key: string) => {
      const env: Record<string, string | null> = {
        BATSHIT_COMPATIBILITY_MATRIX_URL: 'https://api.batshit.ai/registry/compatibility-matrix.json',
        BATSHIT_MATRIX_URL: null,
        COMPATIBILITY_MATRIX_URL: null,
        KV_REST_API_URL: 'https://kv.example.com',
        KV_REST_API_READ_ONLY_TOKEN: 'readonly-token',
        KV_REST_API_TOKEN: 'write-token'
      }

      return env[key] ?? null
    })

    vi.mocked(global.fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)

      if (url === 'https://kv.example.com/get/compatibility-matrix:v1') {
        return jsonResponse({
          result: {
            version: 1,
            fetchedAt: '2026-04-26T16:49:09.653Z',
            entries: [{ scope: { connection: 'openai' }, allow: ['temperature'] }]
          }
        }) as Response
      }

      if (url === 'https://api.batshit.ai/registry/compatibility-matrix.json') {
        return jsonResponse({
          version: 1,
          fetchedAt: '2026-04-25T13:19:57.213Z',
          entries: [{ scope: { connection: 'openai' }, allow: ['temperature'] }]
        }) as Response
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const { fetchCompatibilityMatrix } = await import('./compatibilityMatrix')
    const snapshot = await fetchCompatibilityMatrix(true)

    expect(snapshot.fetchedAt).toBe('2026-04-26T16:49:09.653Z')
    expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toBe(
      'https://kv.example.com/get/compatibility-matrix:v1'
    )
  })

  it('uses the KV write token fallback when the read-only token is missing', async () => {
    mockGetRuntimeEnv.mockImplementation(async (key: string) => {
      const env: Record<string, string | null> = {
        BATSHIT_COMPATIBILITY_MATRIX_URL: 'https://api.batshit.ai/registry/compatibility-matrix.json',
        BATSHIT_MATRIX_URL: null,
        COMPATIBILITY_MATRIX_URL: null,
        KV_REST_API_URL: 'https://kv.example.com',
        KV_REST_API_READ_ONLY_TOKEN: null,
        KV_REST_API_TOKEN: 'write-token'
      }

      return env[key] ?? null
    })

    vi.mocked(global.fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)

      if (url === 'https://kv.example.com/get/compatibility-matrix:v1') {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer write-token'
        })

        return jsonResponse({
          result: {
            version: 1,
            fetchedAt: '2026-04-26T16:49:09.653Z',
            entries: [{ scope: { connection: 'openai' }, allow: ['temperature'] }]
          }
        }) as Response
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const { loadPublishedCompatibilityMatrix } = await import('./compatibilityMatrixAdmin')
    const snapshot = await loadPublishedCompatibilityMatrix()

    expect(snapshot.fetchedAt).toBe('2026-04-26T16:49:09.653Z')
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1)
  })
})
