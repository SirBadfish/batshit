import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getRuntimeEnv = vi.fn(async (name: string) => {
  if (name === 'KV_REST_API_READ_ONLY_TOKEN') return 'read-token'
  if (name === 'KV_REST_API_URL') return 'https://upstash.example'
  return undefined
})
const requireRuntimeEnv = vi.fn(async (name: string) => {
  if (name === 'KV_REST_API_URL') return 'https://upstash.example'
  throw new Error(`${name} not configured`)
})

vi.mock('$lib/server/services/runtimeEnv', () => ({ getRuntimeEnv, requireRuntimeEnv }))

const { upstashKvGet } = await import('./upstashKv')

describe('Upstash REST read envelope', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getRuntimeEnv.mockClear()
    requireRuntimeEnv.mockClear()
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => vi.unstubAllGlobals())

  function reply(payload: unknown) {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
  }

  it('returns null only for an explicit null result', async () => {
    reply({ result: null })
    await expect(upstashKvGet('catalog:v1')).resolves.toBeNull()
  })

  it('parses a valid saved value', async () => {
    reply({ result: JSON.stringify({ version: 2, models: [{ id: 'one' }] }) })
    await expect(upstashKvGet('catalog:v1')).resolves.toEqual({ version: 2, models: [{ id: 'one' }] })
  })

  it.each([[{}], [{ error: 'ERR request failed' }], [[]], [null]])(
    'rejects a successful HTTP response without a result field: %j',
    async (payload) => {
      reply(payload)
      await expect(upstashKvGet('catalog:v1')).rejects.toThrow('Upstash read failed')
    }
  )

  it('rejects an error even when a result field is present', async () => {
    reply({ result: null, error: 'ERR request failed' })
    await expect(upstashKvGet('catalog:v1')).rejects.toThrow('Upstash read failed')
  })

  it('does not mistake a stored JSON null string for an absent key', async () => {
    reply({ result: 'null' })
    await expect(upstashKvGet('catalog:v1')).rejects.toThrow('Upstash read failed')
  })

  it('preserves optional reads without configured credentials', async () => {
    getRuntimeEnv.mockImplementationOnce(async () => undefined)
    getRuntimeEnv.mockImplementationOnce(async () => undefined)
    getRuntimeEnv.mockImplementationOnce(async () => undefined)
    await expect(upstashKvGet('catalog:v1', { required: false })).resolves.toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
