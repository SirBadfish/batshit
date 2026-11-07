// @vitest-environment node
import { sendHandlerPhysicalFixture, useSendHandlerFixture } from './sendHandlerFixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from 'redis'
import * as physicalRedis from 'redis'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from './redis-memory'
import { readSendHandlerSessionForCompile, sendHandlerFixtureClient } from './sendHandlerFixtureReads'
import { failRedisJsonGets, stopFailingRedisJsonGets } from './failRedisJsonGets'
import { commitMemoryTurnState } from '$lib/server/services/memory/memoryRecall'
import { buildDynamicOnlySelectionResetKey } from '$lib/server/services/mcpRuntimePolicy'

const USER = 'fixture-user'
const SESSION = 'fixture-session'
if (process.env.VITEST_USE_REAL_REDIS !== 'true') useRedisTestServer()
useSendHandlerFixture({ sessionIds: () => [SESSION], strictCompiler: true, postStartupMcpUsers: () => [USER] })
afterEach(() => { stopFailingRedisJsonGets(); vi.restoreAllMocks() })
const raw = (command: unknown) => redis.execute((client: any) => client.sendCommand(command))

describe.runIf(process.env.VITEST_USE_REAL_REDIS !== 'true')('opt-in send-handler fixture', () => {
  it('starts only its explicitly listed user at the existing post-v1 marker on the same store, without EVAL', async () => {
    await redis.execute(async (client: any) => {
      expect(await client.get(buildDynamicOnlySelectionResetKey(USER))).toBe('2026-10-27T00:00:00.000Z')
      expect(await client.get(buildDynamicOnlySelectionResetKey('unlisted-user'))).toBeNull()
      expect(client.eval).toBeUndefined()
    })
    const { __testUtils } = await import('$lib/server/services/mcpSelectionResolver')
    await expect(__testUtils.runDynamicOnlySelectionReset(USER)).resolves.toBeUndefined()
  })
  it('does not infer post-startup users from session or actor data', async () => {
    await redis.json.set(`session:${SESSION}`, '$', { id: SESSION, user_id: 'unlisted-user' })
    expect(await raw(['JSON.GET', `session:${SESSION}`])).toBe(JSON.stringify({ id: SESSION, user_id: 'unlisted-user' }))
    expect(await redis.execute((client: any) => client.get(buildDynamicOnlySelectionResetKey('unlisted-user')))).toBeNull()
  })
  it.each([
    ['object', { id: SESSION, metadata: { sibling: 'kept' } }],
    ['list', [{ id: 'one' }]],
    ['null', null]
  ])('reads the same current %s root without a JSONPath wrapper', async (_name, document) => {
    await redis.json.set(`session:${SESSION}`, '$', document as any)
    expect(await raw(['JSON.GET', `session:${SESSION}`])).toBe(JSON.stringify(document))
    const next = { changed: true }
    await redis.json.set(`session:${SESSION}`, '$', next)
    expect(await raw(['JSON.GET', `session:${SESSION}`])).toBe(JSON.stringify(next))
  })
  it('distinguishes absence from stored null, and refuses a wrong storage type', async () => {
    expect(await raw(['JSON.GET', `session:${SESSION}`])).toBeNull()
    await redis.json.set(`session:${SESSION}`, '$', null)
    expect(await raw(['JSON.GET', `session:${SESSION}`])).toBe('null')
    await redis.set(`session:${SESSION}`, 'legacy string')
    await expect(raw(['JSON.GET', `session:${SESSION}`])).rejects.toThrow('WRONGTYPE')
  })
  it.each([
    ['JSON.GET', 'session:another'], ['JSON.GET', `session:${SESSION}`, '$'],
    ['JSON.SET', `session:${SESSION}`, '$', '{}'], ['EVAL', 'return 1', '0'],
    ['json.get', `session:${SESSION}`], ['JSON.GET'], null
  ].map(command => [command]))('refuses unsupported command, key, path or arity %j', async command => {
    await expect(raw(command)).rejects.toThrow('Unsupported raw command')
  })
  it('retains receiver, capability and spread behavior without inventing EVAL or raw fallback', async () => {
    const fallback = vi.fn()
    const client = { marker: 'original', sendCommand: fallback, ownMethod() { return this.marker },
      type: async () => 'none', json: { get: async () => null } }
    const wrapped = sendHandlerFixtureClient(client, () => [SESSION])
    expect(wrapped.ownMethod()).toBe('original')
    expect('ownMethod' in wrapped).toBe(true)
    expect('sendCommand' in wrapped).toBe(true)
    expect('eval' in wrapped).toBe(false)
    expect(wrapped.eval).toBeUndefined()
    expect({ ...wrapped }.ownMethod()).toBe('original')
    await expect(wrapped.sendCommand(['CONFIG', 'SET', 'x', 'y'])).rejects.toThrow('Unsupported')
    expect(fallback).not.toHaveBeenCalled()
  })
  it('preserves an injected read error through the actual memory owner before memory-OFF', async () => {
    await redis.json.set(`session:${SESSION}`, '$', { id: SESSION })
    await redis.set('agent:fixture-agent', { id: 'fixture-agent', user_id: 'fixture-user', memory_enabled: false })
    const execute = vi.mocked(redis.execute).getMockImplementation()!
    let failures = 0
    const spy = vi.spyOn(redis, 'execute').mockImplementation(operation => execute((client: any) => operation(new Proxy({}, {
      get(_target, property) {
        if (property === 'sendCommand') return async (command: string[]) => {
          expect(command).toEqual(['JSON.GET', `session:${SESSION}`])
          failures += 1
          throw new Error('exact-root-read-failed')
        }
        const value = Reflect.get(client, property, client)
        return typeof value === 'function' ? value.bind(client) : value
      }
    }))))
    try {
      await expect(commitMemoryTurnState({ userId: 'fixture-user', agentId: 'fixture-agent', sessionId: SESSION, currentUserMessage: 'Hello' }))
        .rejects.toThrow('exact-root-read-failed')
      expect(failures).toBe(1)
    } finally { spy.mockImplementation(execute) }
    expect(await commitMemoryTurnState({ userId: 'fixture-user', agentId: 'fixture-agent', sessionId: SESSION, currentUserMessage: 'Hello' }))
      .toMatchObject({ committed: false, insertedNewIds: [] })
  })
  it('keeps the strict compiler read distinct from the tolerant facade getter', async () => {
    expect(await (redis as any).getSessionForCompile(SESSION)).toBeNull()
    await redis.json.set(`session:${SESSION}`, '$', { id: SESSION, metadata: { fixedSession: { enabled: true } } })
    expect(await (redis as any).getSessionForCompile(SESSION)).toMatchObject({ metadata: { fixedSession: { enabled: true } } })
    const failure = failRedisJsonGets(key => key === `session:${SESSION}`, new Error('compiler-read-failed'))
    try { await expect((redis as any).getSessionForCompile(SESSION)).rejects.toThrow('SESSION_UNAVAILABLE: failed to read session:fixture-session: compiler-read-failed') }
    finally { failure.stop() }
    expect(await (redis as any).getSessionForCompile(SESSION)).toMatchObject({ id: SESSION })
  })
  it('gives actual metadata consumers the same existing client/store without Lua or a physical factory', async () => {
    const client = await (redis as any).getClient()
    expect(client.eval).toBeUndefined()
    await client.json.set(`session:${SESSION}`, '$', { id: SESSION })
    expect(await redis.json.get(`session:${SESSION}`)).toEqual({ id: SESSION })
    expect(await client.sendCommand(['JSON.GET', `session:${SESSION}`])).toBe(JSON.stringify({ id: SESSION }))
    await expect(client.sendCommand(['JSON.GET', 'artifact:unadmitted'])).rejects.toThrow('Unsupported')
    expect(createClient).not.toHaveBeenCalled()
  })
  it('propagates type and malformed-root failures rather than reporting absence', async () => {
    const typeError = new Error('type failed')
    const failType = sendHandlerFixtureClient({ type: async () => { throw typeError } }, () => [SESSION])
    await expect(failType.sendCommand(['JSON.GET', `session:${SESSION}`])).rejects.toBe(typeError)
    const malformed = sendHandlerFixtureClient({ type: async () => 'ReJSON-RL', json: { get: async () => [] } }, () => [SESSION])
    await expect(malformed.sendCommand(['JSON.GET', `session:${SESSION}`])).rejects.toThrow('one exact JSON root')
    await expect(readSendHandlerSessionForCompile(async () => { throw new Error('failed') }, SESSION)).rejects.toThrow('SESSION_UNAVAILABLE')
  })
  it('refuses both physical factory doors before construction, including a caught attempt', () => {
    try {
      expect(() => createClient({ url: 'redis://127.0.0.1:1/15', database: 15 })).toThrow('Physical Redis is not admitted')
      let expected = 1
      const defaultCreate = (physicalRedis as any).default?.createClient
      if (defaultCreate) {
        expect(defaultCreate).toBe(createClient)
        try { defaultCreate() } catch { /* The persistent counter still records the caught attempt. */ }
        expected += 1
      }
      expect(sendHandlerPhysicalFixture.physicalAttempts).toBe(expected)
      expect(createClient).toHaveBeenCalledTimes(expected)
    } finally {
      // Only these explicitly exercised negative calls are intentional.
      sendHandlerPhysicalFixture.physicalAttempts = 0
      vi.mocked(createClient).mockClear()
    }
  })
})
