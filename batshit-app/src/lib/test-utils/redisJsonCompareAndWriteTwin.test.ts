import { describe, expect, it } from 'vitest'
import { createJsonCompareAndWriteTwinsForMap } from './redisJsonCompareAndWriteTwin'

/**
 * BL-1371: the default lane's compare-and-set twins answer with RedisJSON's shapes and read only
 * their two bounded paths. The same checks run against real Redis 8 + JSON in
 * `mcpGatewayService.registryWrites.redis.test.ts` (the facade itself).
 */

const KEY = 'twin:registry'

function setup(document?: unknown) {
  const documents = new Map<string, unknown>()
  if (document !== undefined) documents.set(KEY, JSON.parse(JSON.stringify(document)))
  return { documents, twins: createJsonCompareAndWriteTwinsForMap(documents) }
}

const REGISTRY = { gateways: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c', n: 3 }] }

describe('BL-1371 compare-and-write twins', () => {
  it('reads RedisJSON shapes: null for no key, [doc] at $, [element], [] past the end or off a list', async () => {
    expect(await setup().twins.getRaw(KEY, '$')).toBeNull()
    expect(await setup().twins.getRaw(KEY, '$.gateways[0]')).toBeNull()
    const { twins } = setup(REGISTRY)
    expect(await twins.getRaw(KEY, '$')).toBe(JSON.stringify([REGISTRY]))
    expect(await twins.getRaw(KEY, '$.gateways[1]')).toBe('[{"id":"b","n":2}]')
    expect(await twins.getRaw(KEY, '$.gateways[3]')).toBe('[]')
    expect(await twins.getRaw(KEY, '$.missing[0]')).toBe('[]')
  })

  it('refuses every path but $ and $.<field>[<n>]', async () => {
    const { twins } = setup(REGISTRY)
    for (const path of ['$.gateways', '$.gateways[*].id', '$.gateways[0].id', '$.a.b[0]', '.gateways[0]', '$..id']) {
      await expect(twins.getRaw(KEY, path)).rejects.toThrow('reads only')
      await expect(twins.setIfUnchanged(KEY, path, '', {})).rejects.toThrow('reads only')
    }
  })

  it('writes one element only while its text is unchanged, and leaves its siblings alone', async () => {
    const { documents, twins } = setup(REGISTRY)
    const raw = (await twins.getRaw(KEY, '$.gateways[1]'))!
    expect(await twins.setIfUnchanged(KEY, '$.gateways[1]', raw, { id: 'b', n: 20 })).toBe(true)
    expect(documents.get(KEY)).toEqual({ gateways: [{ id: 'a', n: 1 }, { id: 'b', n: 20 }, { id: 'c', n: 3 }] })

    expect(await twins.setIfUnchanged(KEY, '$.gateways[1]', raw, { id: 'b', n: 99 })).toBe(false)
    expect((documents.get(KEY) as any).gateways[1]).toEqual({ id: 'b', n: 20 })
  })

  it('creates a key only from the absent text, and replaces the root only from its own text', async () => {
    const { documents, twins } = setup()
    expect(await twins.setIfUnchanged(KEY, '$', '', { gateways: [] })).toBe(true)
    expect(documents.get(KEY)).toEqual({ gateways: [] })
    expect(await twins.setIfUnchanged(KEY, '$', '', { gateways: [{ id: 'x' }] })).toBe(false)
    const raw = (await twins.getRaw(KEY, '$'))!
    expect(await twins.setIfUnchanged(KEY, '$', raw, { gateways: [{ id: 'y' }] })).toBe(true)
    expect(documents.get(KEY)).toEqual({ gateways: [{ id: 'y' }] })
  })

  it('refuses an element whose index now holds another element (a delete shifted the list)', async () => {
    const { documents, twins } = setup(REGISTRY)
    const rawB = (await twins.getRaw(KEY, '$.gateways[1]'))!
    const rawA = (await twins.getRaw(KEY, '$.gateways[0]'))!
    expect(await twins.delIfUnchanged(KEY, '$.gateways[0]', rawA)).toBe(true)
    expect(await twins.setIfUnchanged(KEY, '$.gateways[1]', rawB, { id: 'b', n: 20 })).toBe(false)
    expect(documents.get(KEY)).toEqual({ gateways: [{ id: 'b', n: 2 }, { id: 'c', n: 3 }] })
  })

  it('deletes one element only while unchanged, keeping its siblings; the root delete removes the key', async () => {
    const { documents, twins } = setup(REGISTRY)
    const raw = (await twins.getRaw(KEY, '$.gateways[1]'))!
    expect(await twins.delIfUnchanged(KEY, '$.gateways[1]', '[{"id":"b","n":0}]')).toBe(false)
    expect(await twins.delIfUnchanged(KEY, '$.gateways[1]', raw)).toBe(true)
    expect(documents.get(KEY)).toEqual({ gateways: [{ id: 'a', n: 1 }, { id: 'c', n: 3 }] })
    expect(await twins.delIfUnchanged(KEY, '$', (await twins.getRaw(KEY, '$'))!)).toBe(true)
    expect(documents.has(KEY)).toBe(false)
  })

  it('throws, never answers true, when a passed compare cannot write', async () => {
    const { twins } = setup(REGISTRY)
    await expect(twins.setIfUnchanged(KEY, '$.gateways[5]', '[]', { id: 'z' })).rejects.toThrow('answered UNWRITTEN')
    await expect(twins.delIfUnchanged(KEY, '$.gateways[5]', '[]')).rejects.toThrow('answered UNWRITTEN')
    await expect(setup().twins.setIfUnchanged(KEY, '$.gateways[0]', '', { id: 'z' })).rejects.toThrow(
      'new objects must be created at the root'
    )
    await expect(setup().twins.delIfUnchanged(KEY, '$', '')).rejects.toThrow('answered UNWRITTEN')
  })
})
