import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'
import { __resetDmLocksForTests, getDm, listInbox } from '$lib/server/services/dm/dmStore'
import { createWakeHook } from '$lib/server/services/dm/wakeHookStore'
import { MAX_WAKE_WEBHOOK_CALLS_PER_HOUR } from '$lib/utils/dmControl'

/**
 * SA-113 P3 (DL-113-09) — `POST /api/wake/{hookId}`.
 *
 * This is Batshit's only inbound door for waking an agent from outside, and while a managed
 * Cloudflare tunnel runs it is internet-reachable. Most of what is pinned here is therefore
 * about refusing things: a wrong token, a paused hook, another hook's token, a `result`,
 * and a caller that will not stop.
 */

useRedisTestServer()

const USER = 'user-wake-route'
const COOPER = 'agent-cooper'

const fetchCalls: { url: string; init: any }[] = []

async function seedAgent(id: string, overrides: Record<string, any> = {}) {
  await redis.createAgent({
    id,
    user_id: USER,
    displayName: 'Cooper',
    agentType: 'api',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4-5',
    dms_enabled: true,
    ...overrides
  } as any)
}

const envRecord = env as Record<string, string | undefined>
let previousToken: string | undefined

beforeEach(async () => {
  fetchCalls.length = 0
  __resetDmLocksForTests()
  __resetWakeRunRegistryForTests()
  previousToken = envRecord.BATSHIT_TOKEN
  envRecord.BATSHIT_TOKEN = 'test-service-token'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: any) => {
      fetchCalls.push({ url: String(input), init })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    })
  )
  await seedAgent(COOPER)
})

afterEach(() => {
  __resetWakeRunRegistryForTests()
  if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
  else envRecord.BATSHIT_TOKEN = previousToken
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function call(
  hookId: string,
  token: string | null,
  body: Record<string, unknown> | string = { message: 'Say good morning.' },
  /** The absolute URL the request arrives on — under adapter-node this follows `Host`. */
  requestOrigin = 'http://localhost:5620',
  /** F-SEC-2 needs to set `Content-Length` itself; a `Request` does not always carry one. */
  extraHeaders: Record<string, string> = {}
) {
  const { POST } = await import('./[hookId]/+server')
  return POST({
    request: new Request(`${requestOrigin}/api/wake/${encodeURIComponent(hookId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extraHeaders
      },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    }),
    params: { hookId }
  } as any)
}

async function seedHook(overrides: Record<string, unknown> = {}) {
  return createWakeHook({ userId: USER, agentId: COOPER, name: 'Nightly build', ...overrides })
}

describe('authentication', () => {
  it('accepts the right bearer token and answers 202', async () => {
    const { token, record } = await seedHook({ deliverDefault: 'wait' })
    const response = await call(record.id, token)
    const payload = await response.json()

    expect(response.status).toBe(202)
    expect(payload).toMatchObject({
      delivered_as: 'wait',
      agent: { id: COOPER, name: 'Cooper' }
    })
    expect(payload.dm_id).toBeTruthy()
  })

  it('answers the SAME 403 for no token, a wrong token, and an unknown hook', async () => {
    const { token, record } = await seedHook()

    const responses = await Promise.all([
      call(record.id, null),
      call(record.id, 'bswh_wrong'),
      call('whk_does_not_exist', token)
    ])
    const bodies = await Promise.all(responses.map((response) => response.json()))

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403])
    // One message for all three: a caller must not be able to tell "no such hook" from
    // "wrong token", which is what makes a hook id safe to put in a URL.
    expect(new Set(bodies.map((body) => body.error)).size).toBe(1)
    expect(bodies[0].error).not.toMatch(/not found|unknown|exist/i)
  })

  it('refuses a paused hook', async () => {
    const { token, record } = await seedHook()
    const { updateWakeHook } = await import('$lib/server/services/dm/wakeHookStore')
    await updateWakeHook({ userId: USER, hookId: record.id, enabled: false })

    expect((await call(record.id, token)).status).toBe(403)
    expect(await listInbox(COOPER)).toHaveLength(0)
  })
})

describe('the body contract', () => {
  it('requires a message', async () => {
    const { token, record } = await seedHook()
    expect((await call(record.id, token, { message: '   ' })).status).toBe(400)
    expect((await call(record.id, token, 'not json')).status).toBe(400)
  })

  it('refuses a result, because a program has no assignment to answer', async () => {
    const { token, record } = await seedHook()
    const response = await call(record.id, token, { message: 'x', kind: 'result' })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/cannot send a result/i)
  })

  it('refuses an unknown delivery mode', async () => {
    const { token, record } = await seedHook()
    const response = await call(record.id, token, { message: 'x', deliver: 'steer' })
    expect(response.status).toBe(400)
  })

  it('uses the first line of the message as the subject when none is given', async () => {
    const { token, record } = await seedHook({ deliverDefault: 'wait' })
    const response = await call(record.id, token, {
      message: 'Build 412 is green\n\nAll 5,163 tests passed.'
    })
    const payload = await response.json()
    expect((await getDm(payload.dm_id))?.subject).toBe('Build 412 is green')
  })
})

describe('delivery', () => {
  it('writes an inbox item with a webhook sender and starts no turn on a wait hook', async () => {
    const { token, record } = await seedHook({ deliverDefault: 'wait' })
    const payload = await (await call(record.id, token)).json()

    const dm = await getDm(payload.dm_id)
    expect(dm).toMatchObject({
      to: COOPER,
      kind: 'info',
      from: { kind: 'webhook', hookId: record.id, name: 'Nightly build' }
    })
    expect(fetchCalls.filter((entry) => entry.url.includes('send-routed'))).toHaveLength(0)
  })

  it('starts a turn on a wake hook, always at chain depth 0', async () => {
    const { token, record } = await seedHook()
    const payload = await (await call(record.id, token)).json()

    expect(payload.delivered_as).toBe('wake')
    expect(payload.session_id).toBeTruthy()

    const sendRouted = fetchCalls.find((entry) => entry.url.includes('send-routed'))
    expect(sendRouted).toBeTruthy()
    const body = JSON.parse(sendRouted!.init.body)
    // A program starts a chain, it never continues one, so a webhook can never be used to
    // step past the depth-3 guard.
    expect(body.metadata.wake.chainDepth).toBe(1)
    expect(body.content).toContain('[Wake-up webhook "Nightly build" — not from the user]')
  })

  /**
   * F-P3-1. The route used to pass its own `request.url` down to the wake primitive, and
   * `request.url` follows the `Host` header on any lane without `ORIGIN` (always, under
   * `npm run dev`). A caller holding a valid hook token could therefore choose the host
   * that receives `x-batshit-service-token`. The primitive now owns the address.
   */
  it('self-calls the server-owned base even when the caller spoofs Host (F-P3-1)', async () => {
    const { token, record } = await seedHook()
    envRecord.BATSHIT_CLI_HELPER_BASE_URL = 'http://127.0.0.1:5620'
    try {
      const response = await call(record.id, token, { message: 'x' }, 'http://evil.example')
      expect(response.status).toBe(202)

      expect(fetchCalls.length).toBeGreaterThan(0)
      for (const entry of fetchCalls) {
        expect(new URL(entry.url).origin).toBe('http://127.0.0.1:5620')
      }
      const sendRouted = fetchCalls.find((entry) => entry.url.includes('send-routed'))
      expect(sendRouted).toBeTruthy()
      expect(sendRouted!.init.headers['x-batshit-service-token']).toBe('test-service-token')
    } finally {
      delete envRecord.BATSHIT_CLI_HELPER_BASE_URL
    }
  })

  it('lets one call override the hook default', async () => {
    const { token, record } = await seedHook({ deliverDefault: 'wake' })
    const payload = await (await call(record.id, token, { message: 'x', deliver: 'wait' })).json()
    expect(payload.delivered_as).toBe('wait')
    expect(fetchCalls.filter((entry) => entry.url.includes('send-routed'))).toHaveLength(0)
  })

  it('degrades to wait with a reason when the agent cannot be woken', async () => {
    await redis.updateAgent(COOPER, { wake_enabled: false } as any)
    const { token, record } = await seedHook()
    const payload = await (await call(record.id, token)).json()

    expect(payload.delivered_as).toBe('wait')
    expect(payload.reason).toMatch(/May be woken/i)
    // Nothing is dropped: the item is still in the inbox.
    expect(await listInbox(COOPER)).toHaveLength(1)
  })

  it('refuses when the recipient does not have Agent DMs on (AMD-113-05)', async () => {
    const { token, record } = await seedHook()
    await redis.updateAgent(COOPER, { dms_enabled: false } as any)

    const response = await call(record.id, token)
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/does not have Agent DMs turned on/i)
    expect(await listInbox(COOPER)).toHaveLength(0)
  })

  it('refuses when the agent the hook names has been deleted', async () => {
    const { token, record } = await seedHook()
    await redis.del(`agent:${COOPER}`)

    const response = await call(record.id, token)
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/no longer exists/i)
  })
})

describe('assignments and callbacks', () => {
  it('stores a callback url on an assignment', async () => {
    const { token, record } = await seedHook({ deliverDefault: 'wait' })
    const payload = await (
      await call(record.id, token, {
        message: 'Check the build',
        kind: 'assignment',
        callback_url: 'http://127.0.0.1:5678/webhook/result'
      })
    ).json()

    const dm = await getDm(payload.dm_id)
    expect(dm?.callbackUrl).toBe('http://127.0.0.1:5678/webhook/result')
    // A webhook assignment has NO report_back_to: a program has no inbox, so its report
    // back is the callback.
    expect(dm?.reportBackTo).toBeUndefined()
    expect(dm?.requestedOutcome).toBeTruthy()
    expect(dm?.scope).toBeTruthy()
  })

  it('refuses a callback on an info note and a non-http callback', async () => {
    const { token, record } = await seedHook({ deliverDefault: 'wait' })

    const onInfo = await call(record.id, token, {
      message: 'x',
      callback_url: 'https://example.test/hook'
    })
    expect(onInfo.status).toBe(400)
    expect((await onInfo.json()).error).toMatch(/only an assignment/i)

    const badScheme = await call(record.id, token, {
      message: 'x',
      kind: 'assignment',
      callback_url: 'file:///etc/passwd'
    })
    expect(badScheme.status).toBe(400)
    expect((await badScheme.json()).error).toMatch(/http or https/i)
  })
})

describe('the per-hook rate limit', () => {
  it(`answers 429 with Retry-After after ${MAX_WAKE_WEBHOOK_CALLS_PER_HOUR} calls`, async () => {
    const { token, record } = await seedHook({ deliverDefault: 'wait' })

    for (let index = 0; index < MAX_WAKE_WEBHOOK_CALLS_PER_HOUR; index += 1) {
      // Each body is different so the duplicate guard does not fire first.
      const response = await call(record.id, token, { message: `call ${index}` })
      expect(response.status).toBe(202)
    }

    const limited = await call(record.id, token, { message: 'one too many' })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBeTruthy()
    expect((await limited.json()).retry_after_seconds).toBeGreaterThan(0)
  })

  it('F-SEC-3: repairs a counter left with no TTL by a crash between INCR and EXPIRE', async () => {
    const { token, record } = await seedHook({ deliverDefault: 'wait' })
    const key = `ratelimit:wake-hook:${record.id}`

    // Exactly the state a process death between the two commands leaves behind: a live
    // counter that will never expire. Untouched, this hook answers 429 forever once it
    // passes the limit, and only a hand-deleted key brings it back.
    await redis.incr(key)
    expect(await redis.ttl(key)).toBe(-1)

    expect((await call(record.id, token, { message: 'after the crash' })).status).toBe(202)
    expect(await redis.ttl(key)).toBeGreaterThan(0)
  })

  it('counts per hook, not per instance', async () => {
    const first = await seedHook({ deliverDefault: 'wait', name: 'First' })
    const second = await seedHook({ deliverDefault: 'wait', name: 'Second' })

    for (let index = 0; index < MAX_WAKE_WEBHOOK_CALLS_PER_HOUR; index += 1) {
      await call(first.record.id, first.token, { message: `first ${index}` })
    }

    expect((await call(first.record.id, first.token, { message: 'over' })).status).toBe(429)
    // A runaway loop on one hook must not spend another hook's budget.
    expect((await call(second.record.id, second.token, { message: 'fine' })).status).toBe(202)
  })
})

describe('F-SEC-2 / F-SEC-4 — the body and the log line', () => {
  it('F-SEC-2: refuses an oversized body with 413 before reading it', async () => {
    const { token, record } = await seedHook({ deliverDefault: 'wait' })

    const response = await call(
      record.id,
      token,
      { message: 'small enough on the wire' },
      'http://localhost:5620',
      // Docker sets BODY_SIZE_LIMIT=1G for ordinary app requests, so without this guard a
      // token holder could push a gigabyte into memory thirty times an hour.
      { 'Content-Length': String(2 * 1024 * 1024) }
    )

    expect(response.status).toBe(413)
    expect((await response.json()).limit_bytes).toBe(256 * 1024)
    // The guard sits AFTER auth, so nothing was written and no DM exists.
    expect(await listInbox(COOPER)).toHaveLength(0)
  })

  it('F-SEC-2: an ordinary body is unaffected', async () => {
    const { token, record } = await seedHook({ deliverDefault: 'wait' })
    expect((await call(record.id, token, { message: 'normal' })).status).toBe(202)
  })

  it('F-SEC-4: sanitises the hook id before it reaches the log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // A hook id is a URL path segment, so it is attacker-controlled text. Printed raw, this
    // writes a second line into the server log that reads like a real one.
    const forged = 'whk_a\nWARN [Wake-up webhooks] Accepted a call to whk_attacker'
    const response = await call(forged, 'bswh_wrong')

    expect(response.status).toBe(403)
    const line = warn.mock.calls.map((call) => String(call[0])).find((text) => text.includes('Refused'))
    expect(line).toBeTruthy()
    expect(line).not.toContain('\n')
    expect(line).toContain('whk_a?WARN')
  })
})
