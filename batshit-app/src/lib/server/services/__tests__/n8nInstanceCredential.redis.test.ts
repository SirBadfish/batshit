import { describe, expect, it, vi } from 'vitest'

// BL-1397: the real RedisService, even if other suites mocked the module earlier.
vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { DELETE_N8N_TOKEN_SCRIPT, MOVE_LEGACY_N8N_TOKEN_SCRIPT } from '$lib/server/n8nCredentialScripts'

/**
 * BL-1397 on Redis 8 + JSON: the n8n Instance token's two guarded scripts
 * (`MOVE_LEGACY_N8N_TOKEN_SCRIPT`, `DELETE_N8N_TOKEN_SCRIPT`) through the facade and, for inputs the
 * facade never sends, raw `EVAL`. What the default lane's twin (`test-utils/n8nCredentialScriptsTwin.ts`)
 * cannot show: RedisJSON's own raw texts in the compares, `JSON.SET … NX`, `JSON.TYPE` checks, and
 * that Lua keeps earlier writes when a later one fails (no rollback), so the scripts answer
 * `PARTIAL` with the true state. Every refused or malformed input must leave BOTH keys byte-identical.
 *
 * Real-Redis suite (G-0228): it runs only under `npm run test:redis` and reports as skipped in the
 * default lane. The default-lane owner is `n8nInstanceCredential.test.ts`.
 */

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'bl1397_real_user'
const KEY = `api_keys:${USER}:n8n_instance_mcp_token`
const REGISTRY = `mcp_gateways:${USER}`
const DOC = { encrypted: 'synthetic-e', iv: 'synthetic-iv', authTag: 'synthetic-tag', updatedAt: '2026-10-11T00:00:00.000Z' }

function n8n(id: string, metadata: Record<string, unknown>) {
  return { id, name: `n8n ${id}`, type: 'n8n-instance-mcp', url: 'http://localhost:5678/mcp-server/http', metadata }
}

async function seedRegistry(gateways: unknown[]) {
  await redis.json.set(REGISTRY, '$', { gateways })
}

async function raws() {
  return {
    key: await redis.execute((client) => client.sendCommand(['GET', KEY]).catch(() => null)),
    keyJson: await redis.json.getRaw(KEY, '$').catch(() => 'not-json'),
    registry: await redis.json.getRaw(REGISTRY, '$')
  }
}

function evalScript(script: string, keys: string[], args: string[]) {
  return redis.execute((client) => client.eval(script, { keys, arguments: args }))
}

describe.runIf(REAL_REDIS_LANE)('BL-1397: n8n Instance token scripts (real Redis)', () => {
  useRedisTestServer()

  async function reset() {
    await redis.execute((client) => client.del([KEY, REGISTRY]))
  }

  // --- move ---

  it('moves into an absent key with NX, then removes only the copy', async () => {
    await reset()
    await seedRegistry([n8n('gw-a', { authToken: 'synthetic-L', base: 'x' }), n8n('gw-b', { authToken: 'other' })])
    const elementRaw = (await redis.json.getRaw(REGISTRY, '$.gateways[0]'))!

    const answer = await redis.json.moveLegacyN8nToken(KEY, REGISTRY, '', '$.gateways[0]', elementRaw, DOC)

    expect(answer).toEqual({ kind: 'ok' })
    expect(await redis.json.get(KEY)).toEqual(DOC)
    const registry = (await redis.json.get(REGISTRY)) as any
    expect(registry.gateways[0].metadata).toEqual({ base: 'x' })
    expect(registry.gateways[1].metadata).toEqual({ authToken: 'other' })
  })

  it('retire only: the key is compared and left byte-identical; the copy goes', async () => {
    await reset()
    await redis.json.set(KEY, '$', DOC)
    await seedRegistry([n8n('gw-a', { authToken: 'synthetic-L' })])
    const before = await raws()
    const elementRaw = (await redis.json.getRaw(REGISTRY, '$.gateways[0]'))!

    const answer = await redis.json.moveLegacyN8nToken(KEY, REGISTRY, before.keyJson!, '$.gateways[0]', elementRaw, null)

    expect(answer).toEqual({ kind: 'ok' })
    expect(await redis.json.getRaw(KEY, '$')).toBe(before.keyJson)
    expect(((await redis.json.get(REGISTRY)) as any).gateways[0].metadata).toEqual({})
  })

  it.each([
    ['a key saved after the read', async () => redis.json.set(KEY, '$', DOC), 'changed'],
    ['an element changed after the read', async () => redis.json.set(REGISTRY, '$.gateways[0].metadata.base', 'y'), 'changed']
  ])('refuses %s and writes nothing', async (_kind, change, kind) => {
    await reset()
    await seedRegistry([n8n('gw-a', { authToken: 'synthetic-L', base: 'x' })])
    const elementRaw = (await redis.json.getRaw(REGISTRY, '$.gateways[0]'))!
    await change()
    const before = await raws()

    const answer = await redis.json.moveLegacyN8nToken(KEY, REGISTRY, '', '$.gateways[0]', elementRaw, DOC)

    expect(answer.kind).toBe(kind)
    expect(await raws()).toEqual(before)
  })

  it('refuses a move into a key that exists even when its text matches, and writes nothing', async () => {
    await reset()
    await redis.json.set(KEY, '$', DOC)
    await seedRegistry([n8n('gw-a', { authToken: 'synthetic-L' })])
    const before = await raws()
    const elementRaw = (await redis.json.getRaw(REGISTRY, '$.gateways[0]'))!

    const answer = await redis.json.moveLegacyN8nToken(KEY, REGISTRY, before.keyJson!, '$.gateways[0]', elementRaw, { other: 1 })

    expect(answer).toEqual({ kind: 'invalid', reason: 'key exists' })
    expect(await raws()).toEqual(before)
  })

  it('refuses an element with no string copy before any write', async () => {
    await reset()
    await seedRegistry([n8n('gw-a', { authToken: 7 })])
    const before = await raws()
    const elementRaw = (await redis.json.getRaw(REGISTRY, '$.gateways[0]'))!

    const answer = await redis.json.moveLegacyN8nToken(KEY, REGISTRY, '', '$.gateways[0]', elementRaw, DOC)

    expect(answer).toEqual({ kind: 'invalid', reason: 'copy' })
    expect(await raws()).toEqual(before)
  })

  it('a key document that is not JSON fails at the first write: nothing written', async () => {
    await reset()
    await seedRegistry([n8n('gw-a', { authToken: 'synthetic-L' })])
    const before = await raws()
    const elementRaw = (await redis.json.getRaw(REGISTRY, '$.gateways[0]'))!

    const answer = await evalScript(MOVE_LEGACY_N8N_TOKEN_SCRIPT, [KEY, REGISTRY], ['', '$.gateways[0]', elementRaw, '{not json'])

    expect(answer).toEqual(['FAILED', 'key'])
    expect(await raws()).toEqual(before)
  })

  it('a key of the wrong type stops the script before any write', async () => {
    await reset()
    await redis.execute((client) => client.set(KEY, 'plain-string'))
    await seedRegistry([n8n('gw-a', { authToken: 'synthetic-L' })])
    const registryBefore = await redis.json.getRaw(REGISTRY, '$')
    const elementRaw = (await redis.json.getRaw(REGISTRY, '$.gateways[0]'))!

    await expect(redis.json.moveLegacyN8nToken(KEY, REGISTRY, '', '$.gateways[0]', elementRaw, DOC)).rejects.toThrow()

    expect(await redis.execute((client) => client.get(KEY))).toBe('plain-string')
    expect(await redis.json.getRaw(REGISTRY, '$')).toBe(registryBefore)
  })

  // --- delete ---

  it.each([
    [true, 'empty'],
    [true, 'missing'],
    [false, 'empty'],
    [false, 'missing']
  ] as const)('deletes with no copy paths (key present=%s, registry=%s)', async (keyPresent, registryState) => {
    await reset()
    if (keyPresent) await redis.json.set(KEY, '$', DOC)
    if (registryState === 'empty') await seedRegistry([])
    const keyRaw = (await redis.json.getRaw(KEY, '$')) ?? ''
    const registryRaw = (await redis.json.getRaw(REGISTRY, '$')) ?? ''

    const answer = await redis.json.deleteN8nToken(KEY, REGISTRY, keyRaw, registryRaw, [])

    expect(answer).toEqual({ kind: 'ok', copiesCleared: 0 })
    expect(await redis.json.getRaw(KEY, '$')).toBeNull()
    expect((await redis.json.getRaw(REGISTRY, '$')) ?? '').toBe(registryRaw)
  })

  it('deletes every planned copy first and the key last; other gateways keep theirs', async () => {
    await reset()
    await redis.json.set(KEY, '$', DOC)
    await seedRegistry([
      n8n('gw-a', { authToken: 'synthetic-L', base: 'a' }),
      { id: 'gw-c', type: 'custom', metadata: { authToken: 'other' } },
      n8n('gw-b', { authToken: 'synthetic-K' })
    ])
    const keyRaw = (await redis.json.getRaw(KEY, '$'))!
    const registryRaw = (await redis.json.getRaw(REGISTRY, '$'))!

    const answer = await redis.json.deleteN8nToken(KEY, REGISTRY, keyRaw, registryRaw, [
      '$.gateways[0].metadata.authToken',
      '$.gateways[2].metadata.authToken'
    ])

    expect(answer).toEqual({ kind: 'ok', copiesCleared: 2 })
    expect(await redis.json.getRaw(KEY, '$')).toBeNull()
    const registry = (await redis.json.get(REGISTRY)) as any
    expect(registry.gateways.map((gateway: any) => gateway.metadata)).toEqual([{ base: 'a' }, { authToken: 'other' }, {}])
  })

  it.each([
    ['the key changed', async () => redis.json.set(KEY, '$.updatedAt', 'later'), 'key_changed'],
    ['the registry changed', async () => redis.json.set(REGISTRY, '$.gateways[0].metadata.base', 'z'), 'changed']
  ])('refuses when %s and deletes nothing', async (_kind, change, kind) => {
    await reset()
    await redis.json.set(KEY, '$', DOC)
    await seedRegistry([n8n('gw-a', { authToken: 'synthetic-L', base: 'a' })])
    const keyRaw = (await redis.json.getRaw(KEY, '$'))!
    const registryRaw = (await redis.json.getRaw(REGISTRY, '$'))!
    await change()
    const before = await raws()

    const answer = await redis.json.deleteN8nToken(KEY, REGISTRY, keyRaw, registryRaw, ['$.gateways[0].metadata.authToken'])

    expect(answer.kind).toBe(kind)
    expect(await raws()).toEqual(before)
  })

  it('refuses a planned path that holds no copy before any write', async () => {
    await reset()
    await redis.json.set(KEY, '$', DOC)
    await seedRegistry([n8n('gw-a', { authToken: 'synthetic-L' }), n8n('gw-b', { base: 'b' })])
    const before = await raws()

    const answer = await redis.json.deleteN8nToken(KEY, REGISTRY, before.keyJson!, before.registry!, [
      '$.gateways[0].metadata.authToken',
      '$.gateways[1].metadata.authToken'
    ])

    expect(answer).toEqual({ kind: 'invalid', path: '$.gateways[1].metadata.authToken' })
    expect(await raws()).toEqual(before)
  })

  it('a path list that is not JSON stops the script before any write', async () => {
    await reset()
    await redis.json.set(KEY, '$', DOC)
    await seedRegistry([n8n('gw-a', { authToken: 'synthetic-L' })])
    const before = await raws()

    await expect(
      evalScript(DELETE_N8N_TOKEN_SCRIPT, [KEY, REGISTRY], [before.keyJson!, before.registry!, '[not json'])
    ).rejects.toThrow()

    expect(await raws()).toEqual(before)
  })

  it('a write that fails part way keeps the earlier writes and answers PARTIAL; the key is kept', async () => {
    await reset()
    await redis.json.set(KEY, '$', DOC)
    await seedRegistry([n8n('gw-a', { authToken: 'synthetic-L', base: 'a' })])
    const keyRaw = (await redis.json.getRaw(KEY, '$'))!
    const registryRaw = (await redis.json.getRaw(REGISTRY, '$'))!

    // The same copy twice: both pass the check before the first write; the second JSON.DEL finds nothing.
    const answer = await redis.json.deleteN8nToken(KEY, REGISTRY, keyRaw, registryRaw, [
      '$.gateways[0].metadata.authToken',
      '$.gateways[0].metadata.authToken'
    ])

    expect(answer).toEqual({ kind: 'partial', copiesCleared: 1 })
    expect(((await redis.json.get(REGISTRY)) as any).gateways[0].metadata).toEqual({ base: 'a' })
    expect(await redis.json.getRaw(KEY, '$')).toBe(keyRaw)
  })
})
