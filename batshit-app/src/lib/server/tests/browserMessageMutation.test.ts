import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { POST } from '../../../routes/api/messages/+server'
import { PUT } from '../../../routes/api/messages/[sessionId]/[messageId]/+server'

/** BL-1302: default lane qualifies the twin and authenticated routes. Only REAL cases
 * qualify Lua, by inserting a server write after the browser/writer reads, before EVAL.
 * The real lane requires a separately allocated owned Redis 8+JSON instance, DB14.
 */
useRedisTestServer()
const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'browser-mutation-user'
const SESSION = 'browser-mutation-session'
const ID = 'browser-mutation-message'
const KEY = `message:${SESSION}:${ID}`
const DATE = '2026-10-11T08:00:00.000Z'
const MARKERS = { steerPromoted: { steerIds: ['server-steer'], disposition: 'unanswered', reason: 'stopped' },
  waitsForApproval: { messageId: 'server-card' }, approvalCardExpired: false }
const FORGED = { steerPromoted: { steerIds: ['browser-forgery'] }, waitsForApproval: null, approvalCardExpired: true }
// Snapshot clean methods before any per-case once queue is installed. Real-Lua
// execution still delegates to the actual instance, never a fake implementation.
const originalWriters = {
  saveMessage: vi.isMockFunction(redis.saveMessage) ? redis.saveMessage.getMockImplementation()! : redis.saveMessage,
  updateMessage: vi.isMockFunction(redis.updateMessage) ? redis.updateMessage.getMockImplementation()! : redis.updateMessage
}

async function seed(existing = true, metadata: unknown = {}) {
  await redis.json.set(`session:${SESSION}`, '$', { id: SESSION, user_id: USER, metadata: {}, created_at: DATE } as never)
  if (existing) {
    await redis.json.set(KEY, '$', { id: ID, session_id: SESSION, user_id: USER, role: 'user',
      content: 'Original', created_at: DATE, metadata } as never)
    await redis.rPush(`messages:${SESSION}`, ID)
  }
}

async function browserWrite(kind: 'POST' | 'PUT', metadata: unknown = FORGED) {
  const updates = { content: 'Edited', metadata }
  const request = new Request('http://localhost/api/messages', { method: kind,
    body: JSON.stringify(kind === 'POST' ? { ...updates, id: ID, session_id: SESSION, user_id: 'forged-user', role: 'user' } : updates) })
  return kind === 'POST' ? POST({ request, locals: { user: { id: USER } } } as any) :
    PUT({ request, params: { sessionId: SESSION, messageId: ID }, locals: { user: { id: USER } } } as any)
}

async function saved() { return await redis.json.get(KEY) as any }
afterEach(async () => {
  vi.restoreAllMocks()
  for (const key of [KEY, `session:${SESSION}`, `messages:${SESSION}`]) await redis.del(key)
})

describe('browser message writes reserve server identity (BL-1302)', () => {
  it('a new POST ignores request markers and derives user ownership from the signed-in user', async () => {
    await seed(false)
    expect((await browserWrite('POST', { ...FORGED, tts: true, clipIds: ['clip-user'] })).status).toBe(200)
    expect(await saved()).toMatchObject({ user_id: USER, content: 'Edited', metadata: { tts: true, clipIds: ['clip-user'] } })
    for (const field of Object.keys(MARKERS)) expect((await saved()).metadata).not.toHaveProperty(field)
  })

  it.each(['POST', 'PUT'] as const)('%s retains exact current markers and legitimate text/metadata edits', async kind => {
    await seed(true, { ...MARKERS, oldSetting: 'preserved-by-POST' })
    expect((await browserWrite(kind, { ...FORGED, tts: false, clipIds: ['clip-user'] })).status).toBe(200)
    const record = await saved()
    expect(record.metadata).toEqual({ ...MARKERS, ...(kind === 'POST' ? { oldSetting: 'preserved-by-POST' } : {}), tts: false, clipIds: ['clip-user'] })
    expect(record.content).toBe('Edited')
    expect(record.created_at).toBe(DATE)
  })

  it.each(['POST', 'PUT'] as const)('%s preserves exact null, false and empty-object markers when metadata is cleared', async kind => {
    const markers = { steerPromoted: {}, waitsForApproval: null, approvalCardExpired: false }
    await seed(true, { ...markers, oldSetting: 'discarded' })
    expect((await browserWrite(kind, null)).status).toBe(200)
    expect((await saved()).metadata).toEqual({ ...markers, ...(kind === 'POST' ? { oldSetting: 'discarded' } : {}) })
  })

  it.each(['POST', 'PUT'] as const)('%s preserves a disposition written after the route read (fake twin or real writer)', async kind => {
    await seed()
    const method = kind === 'POST' ? 'saveMessage' : 'updateMessage'
    const write = originalWriters[method] as (...args: any[]) => Promise<unknown>
    const spy = vi.spyOn(redis, method).mockImplementation((async (...args: any[]) => {
      await redis.json.set(KEY, '$.metadata', MARKERS as never)
      return write.apply(redis, args)
    }) as any)
    try {
      expect((await browserWrite(kind, { ...FORGED, tts: true })).status).toBe(200)
      expect((await saved()).metadata).toEqual({ ...MARKERS, tts: true })
    } finally {
      spy.mockRestore()
    }
  })

  // These cases run on the actual Lua too when the separately owned real lane is allocated.
  it.each(['POST', 'PUT'] as const)('%s edits an ordinary user record with no protected markers', async kind => {
    await seed(true, { note: 'ordinary' })
    expect((await browserWrite(kind, { edited: true })).status).toBe(200)
    expect((await saved()).metadata).toEqual({ ...(kind === 'POST' ? { note: 'ordinary' } : {}), edited: true })
  })
  it.each(['POST', 'PUT'] as const)('%s preserves a partial protected set without requiring absent paths', async kind => {
    await seed(true, { waitsForApproval: null })
    expect((await browserWrite(kind, FORGED)).status).toBe(200)
    expect((await saved()).metadata).toEqual({ waitsForApproval: null })
  })
  it('an ordinary create with no markers succeeds with missing-safe marker deletion', async () => {
    await seed(false)
    expect((await browserWrite('POST', {})).status).toBe(200)
    expect((await saved()).metadata).toEqual({})
  })

  it('trusted internal writes can still create and change server markers without a browser policy', async () => {
    await seed()
    await redis.updateMessage(ID, SESSION, { metadata: MARKERS }, USER)
    expect((await saved()).metadata).toEqual(MARKERS)
    await redis.saveMessage({ id: ID, session_id: SESSION, user_id: USER, role: 'user', content: 'Trusted',
      metadata: { ...MARKERS, approvalCardExpired: true } } as any)
    expect((await saved()).metadata.approvalCardExpired).toBe(true)
    // Only the real facade proves its trusted failure-shaped merge. The shared fake
    // documents replace-on-save; the handler uses a local adapter for this invariant.
    if (REAL) {
      const cardText = 'Saved card ![Prior picture](https://example.invalid/card.png)'
      const metadata = { ...MARKERS, approvalCardExpired: true, answeredApprovalIds: ['server-approval'],
        imageOriginExpected: true, imageOriginExpectedVersion: 53 }
      await redis.saveMessage({ id: ID, session_id: SESSION, user_id: USER, role: 'assistant', status: 'complete',
        content: cardText, metadata } as any)
      await redis.saveMessage({ id: ID, session_id: SESSION, user_id: USER, role: 'assistant', status: 'error',
        content: cardText, metadata: { response_failed: true } } as any)
      expect(await saved()).toMatchObject({ role: 'assistant', status: 'error', content: cardText,
        created_at: DATE, metadata: { ...metadata, response_failed: true } })
      expect((await saved()).metadata).toEqual({ ...metadata, response_failed: true })
    }
  })
})

/** Existing client-wrapper seam used by the path-write regression suites. Inject once
 * immediately before the actual message EVAL, never by reimplementing its Lua in a mock.
 */
function interleaveBeforeEval(change: (client: any) => Promise<void>) {
  const execute = redis.execute.bind(redis)
  let injected = false
  vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) => execute(async (client: any) => {
    const wrapped = new Proxy({}, { get(_empty, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (options.keys?.[0] === KEY && !injected) { injected = true; await change(client) }
        return client.eval(script, options)
      }
      const value = Reflect.get(client, property)
      return typeof value === 'function' ? value.bind(client) : value
    } })
    return operation(wrapped)
  })) as any)
  return () => injected
}

describe.skipIf(!REAL)('browser mutation atomic boundary (actual Redis Lua only)', () => {
  it.each(['POST', 'PUT'] as const)('%s retains a server disposition inserted after every stale read', async kind => {
    await seed()
    const injected = interleaveBeforeEval(client => client.json.set(KEY, '$.metadata', MARKERS))
    expect((await browserWrite(kind, { ...FORGED, tts: true })).status).toBe(200)
    expect(injected()).toBe(true)
    expect((await saved()).metadata).toEqual({ ...MARKERS, tts: true })
  })

  it('POST merges CURRENT unprovided siblings inserted after the route and writer reads, retaining explicit null', async () => {
    await seed(true, { oldSetting: 'old', odd: { a: 1 } })
    const injected = interleaveBeforeEval(client => client.json.set(KEY, '$.metadata', {
      groupReplySkipped: { groupTurnId: 'server-current' }, approvalResume: { approvalIds: ['approved-current'] },
      'quoted.key': {}, oldSetting: 'changed-after-read', odd: { a: 2 } }))
    expect((await browserWrite('POST', { oldSetting: null })).status).toBe(200)
    expect(injected()).toBe(true)
    expect((await saved()).metadata).toEqual({ groupReplySkipped: { groupTurnId: 'server-current' },
      approvalResume: { approvalIds: ['approved-current'] }, 'quoted.key': {}, oldSetting: null, odd: { a: 2 } })
  })

  it('POST retains legal slash, control, quote and backslash metadata keys using RedisJSON quoting', async () => {
    const metadata = { 'slash/key': {}, 'line\nkey': false, 'tab\tkey': null, 'quote"key': ['kept'], 'back\\key': { kept: true } }
    await seed(true, metadata)
    expect((await browserWrite('POST', { edited: true })).status).toBe(200)
    expect((await saved()).metadata).toEqual({ ...metadata, edited: true })
  })

  it.each(['POST', 'PUT'] as const)('%s does not resurrect a message deleted after the read', async kind => {
    await seed(true, MARKERS)
    const injected = interleaveBeforeEval(async client => { await client.del(KEY); await client.lRem(`messages:${SESSION}`, 0, ID) })
    expect((await browserWrite(kind)).status).toBe(404)
    expect(injected()).toBe(true)
    expect(await saved()).toBeNull()
    expect(await redis.lRange(`messages:${SESSION}`, 0, -1)).not.toContain(ID)
  })

  it('new POST refuses a record that appeared after the route read, leaving its server relation intact', async () => {
    await seed(false)
    interleaveBeforeEval(async client => { await client.json.set(KEY, '$', { id: ID, session_id: SESSION, user_id: USER,
      role: 'user', content: 'Appeared meanwhile', created_at: DATE, metadata: MARKERS }) })
    expect((await browserWrite('POST')).status).toBe(409)
    expect(await saved()).toMatchObject({ content: 'Appeared meanwhile', metadata: MARKERS })
  })

  it.each(['POST', 'PUT'] as const)('%s refuses current message ownership/role that changed after the route read', async kind => {
    await seed(true, MARKERS)
    interleaveBeforeEval(client => client.json.set(KEY, '$.role', 'assistant'))
    expect((await browserWrite(kind)).status).toBe(403)
    expect(await saved()).toMatchObject({ role: 'assistant', content: 'Original', metadata: MARKERS })
  })

  it('current session ownership is checked inside the write, before any message changes', async () => {
    await seed(true, MARKERS)
    interleaveBeforeEval(client => client.json.set(`session:${SESSION}`, '$.user_id', 'another-user'))
    expect((await browserWrite('PUT')).status).toBe(403)
    expect(await saved()).toMatchObject({ content: 'Original', metadata: MARKERS })
  })
})
