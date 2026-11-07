import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getRuntimeEnv = vi.fn(async (name: string) => {
  if (name === 'KV_REST_API_READ_ONLY_TOKEN') return 'read-token'
  if (name === 'KV_REST_API_TOKEN') return 'write-token'
  if (name === 'KV_REST_API_URL') return 'https://upstash.example'
  return undefined
})
const requireRuntimeEnv = vi.fn(async (name: string) => {
  if (name === 'KV_REST_API_URL') return 'https://upstash.example'
  throw new Error(`${name} not configured`)
})

vi.mock('$lib/server/services/runtimeEnv', () => ({ getRuntimeEnv, requireRuntimeEnv }))

const { upstashKvGet, upstashKvGetRaw, upstashKvSetIfUnchanged } = await import('./upstashKv')

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

  it('retains actual raw whitespace and distinguishes absence from malformed raw replies', async () => {
    const raw = ' { "models" : [] }\n'
    reply({ result: raw })
    await expect(upstashKvGetRaw('catalog:v1')).resolves.toBe(raw)
    reply({ result: null })
    await expect(upstashKvGetRaw('catalog:v1')).resolves.toBeNull()
    reply({ result: {} })
    await expect(upstashKvGetRaw('catalog:v1')).rejects.toThrow('not text')
    reply({})
    await expect(upstashKvGetRaw('catalog:v1')).rejects.toThrow('Upstash read failed')
  })

  it('sends exact prior bytes for CAS, and never treats an unconfirmed write as success', async () => {
    const raw = ' { "models" : [] }\n'
    reply({ result: 'OK' })
    await expect(upstashKvSetIfUnchanged('catalog:v1', raw, { models: ['new'] })).resolves.toBe(true)
    const command = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(command.slice(2)).toEqual(['1', 'catalog:v1', 'present', raw, JSON.stringify({ models: ['new'] })])
    reply({ result: 'CHANGED' })
    await expect(upstashKvSetIfUnchanged('catalog:v1', null, {})).resolves.toBe(false)
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body).slice(-3)).toEqual(['absent', '', '{}'])
    for (const payload of [{ result: 'UNWRITTEN' }, {}, { error: 'ERR failure' }]) {
      reply(payload)
      await expect(upstashKvSetIfUnchanged('catalog:v1', raw, {})).rejects.toThrow()
    }
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
