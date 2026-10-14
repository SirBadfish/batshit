import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  __resetCompactRunRegistryForTests,
  countCompactRuns,
  stopCompactRuns
} from '$lib/server/services/compactRunRegistry'
import { getContextCompactionState } from '$lib/utils/contextCompaction'

/**
 * BL-622 (rules C6 and C7 of `Plans/2026-09-27-bl622-a-compact-yields-to-a-turn.md`, BL-653): Stop
 * stops what runs. While a Compact runs, the chat's Stop ends it through
 * `POST /api/messages/compact/stop`; its summary call gets the stop signal, and the Compact writes
 * nothing. Before, the Stop button called the reply's Stop, and the Compact went on and wrote.
 *
 * Drives the REAL Compact route and the REAL Stop route on both lanes; only the model call and the
 * token estimate are stubbed. The stubbed model call is where the Stop lands.
 */

useRedisTestServer()

const model = vi.hoisted(() => ({
  hook: null as null | ((params: { abortSignal?: AbortSignal }) => Promise<void>),
  signals: [] as Array<AbortSignal | undefined>,
  fail: false
}))

vi.mock('$lib/server/services/summaryGeneration', () => ({
  generateModelSummary: vi.fn(async (params: { abortSignal?: AbortSignal }) => {
    model.signals.push(params.abortSignal)
    if (model.hook) await model.hook(params)
    if (model.fail) throw new Error('The model provider failed.')
    return { summary: 'Summary of the older stretch.', modelLabel: 'Stub', provider: 'stub', modelId: 'stub-model' }
  })
}))

const tokenPreview = vi.hoisted(() => ({
  hook: null as null | (() => Promise<void>)
}))

vi.mock('$lib/server/services/contextTokenPreview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/contextTokenPreview')>()),
  estimateCurrentContextTokens: vi.fn(async () => {
    if (tokenPreview.hook) await tokenPreview.hook()
    return { budget: { contextLimit: 128_000 }, tokens: 1_000 }
  })
}))

const { POST: compactPost } = await import('./+server')
const { POST: stopPost } = await import('./stop/+server')

const USER = 'zcyield_user'
const OTHER_USER = 'zcyield_other_user'
const SESSION = 'zcyield_stop_session'
const AGENT = 'zcyield_agent'

function messages() {
  const at = (minute: number) => `2026-09-27T10:0${minute}:00.000Z`
  return [
    { id: 'u1', session_id: SESSION, role: 'user', content: 'Plan the garage shelves.', timestamp: at(1) },
    { id: 'a1', session_id: SESSION, role: 'assistant', agent_id: AGENT, content: 'Metal, 6 m wide.', timestamp: at(2) },
    { id: 'u2', session_id: SESSION, role: 'user', content: 'Order them.', timestamp: at(3) },
    { id: 'a2', session_id: SESSION, role: 'assistant', agent_id: AGENT, content: 'Ordered.', timestamp: at(4) }
  ]
}

async function compact() {
  const request = new Request('http://localhost/api/messages/compact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, mode: 'manual', messages: messages() })
  })
  const response = await compactPost({ request, locals: { user: { id: USER } }, fetch: globalThis.fetch } as any)
  return { status: response.status, body: await response.json() }
}

async function stop(userId = USER, sessionId = SESSION) {
  const request = new Request('http://localhost/api/messages/compact/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  })
  const response = await stopPost({ request, locals: { user: { id: userId } } } as any)
  return { status: response.status, body: await response.json() }
}

async function storedEvents() {
  return getContextCompactionState(((await redis.getSession(SESSION)) as any)?.metadata).events
}

/** A model call that answers only when its stop signal aborts, as a real provider call ends. */
function hangUntilStopped(params: { abortSignal?: AbortSignal }) {
  return new Promise<void>((_, reject) => {
    const aborted = () => reject(new Error('This operation was aborted'))
    if (params.abortSignal?.aborted) return aborted()
    params.abortSignal?.addEventListener('abort', aborted, { once: true })
  })
}

async function seedChat() {
  await redis.json.set(`session:${SESSION}`, '$', { id: SESSION, user_id: USER, name: 'Garage', metadata: {} } as never)
}

const STOPPED = { error: 'Compact stopped. It wrote nothing.', code: 'ended_early', reason: 'stopped' }

beforeEach(async () => {
  model.hook = null
  model.signals = []
  model.fail = false
  tokenPreview.hook = null
  __resetCompactRunRegistryForTests()
  await seedChat()
  await redis.set(`agent:${AGENT}`, { id: AGENT, user_id: USER, displayName: 'Probe', agentType: 'api' })
})

afterEach(async () => {
  __resetCompactRunRegistryForTests()
  for (const key of [`session:${SESSION}`, `agent:${AGENT}`, `user:${USER}:settings`]) await redis.del(key)
})

describe('Stop stops a running Compact (BL-622 C6 and C7, BL-653)', () => {
  it('a Stop during the summary call ends the call, and the Compact writes nothing', async () => {
    let stopAnswer: { status: number; body: any } | null = null
    model.hook = async (params) => {
      expect(countCompactRuns(SESSION)).toBe(1)
      stopAnswer = await stop()
      await hangUntilStopped(params)
    }

    const { status, body } = await compact()

    expect(stopAnswer).toEqual({ status: 200, body: { success: true, stopped: 1 } })
    expect(status).toBe(409)
    expect(body).toEqual(STOPPED)
    expect(model.signals[0]?.aborted).toBe(true)
    expect(await storedEvents()).toEqual([])
    expect(countCompactRuns(SESSION)).toBe(0)
  })

  it('a Stop during setup (the token estimate, before the model call) leaves no event and answers stopped (BL-719)', async () => {
    let stopAnswer: { status: number; body: any } | null = null
    tokenPreview.hook = async () => {
      expect(countCompactRuns(SESSION)).toBe(1)
      stopAnswer = await stop()
    }

    const { status, body } = await compact()

    expect(stopAnswer).toEqual({ status: 200, body: { success: true, stopped: 1 } })
    expect(status).toBe(409)
    expect(body).toEqual(STOPPED)
    // The model was never called: the setup-time Stop is caught before the model call.
    expect(model.signals.length).toBe(0)
    expect(await storedEvents()).toEqual([])
    expect(countCompactRuns(SESSION)).toBe(0)
  })

  it('a Stop that lands as the model answers still stops the write', async () => {
    model.hook = async () => {
      await stop()
    }

    const { status, body } = await compact()

    expect(status).toBe(409)
    expect(body).toEqual(STOPPED)
    expect(await storedEvents()).toEqual([])
  })

  it('the Stop route checks the caller owns the chat, and stops only that chat', async () => {
    model.hook = async () => {
      expect(await stop(OTHER_USER)).toMatchObject({ status: 403 })
      expect(await stop(USER, 'zcyield_missing_chat')).toMatchObject({ status: 404 })
      expect(stopCompactRuns('zcyield_some_other_chat')).toBe(0)
    }

    const { status, body } = await compact()

    expect(status, JSON.stringify(body)).toBe(200)
    expect(model.signals[0]?.aborted).toBe(false)
    expect((await storedEvents()).map((event) => event.id)).toEqual([body.event.id])
  })

  it('a Stop with no Compact running answers stopped 0 (it leaves a pending stop, below)', async () => {
    expect(await stop()).toEqual({ status: 200, body: { success: true, stopped: 0 } })
  })

  it('a Stop pressed before the Compact registered its run still stops it, and it writes nothing (BL-653 review)', async () => {
    // The Stop reaches the server first (the Compact is still reading its body): nothing to stop.
    expect(await stop()).toEqual({ status: 200, body: { success: true, stopped: 0 } })
    expect(await compact()).toEqual({ status: 409, body: STOPPED })
    expect(model.signals).toHaveLength(0)
    expect(await storedEvents()).toEqual([])
    // The pending stop is used up: the next Compact runs and writes.
    expect((await compact()).status).toBe(200)
    expect(await storedEvents()).toHaveLength(1)
  })

  it('the registry entry leaves on every path', async () => {
    // Written.
    expect((await compact()).status).toBe(200)
    expect(countCompactRuns(SESSION)).toBe(0)

    // Refused at the write (another Compact wrote first).
    await seedChat()
    model.hook = async () => {
      const fresh = (await redis.getSession(SESSION)) as any
      const events = getContextCompactionState(fresh?.metadata).events
      await redis.updateSession(SESSION, {
        metadata: {
          ...(fresh?.metadata ?? {}),
          contextCompaction: {
            version: 1,
            events: [...events, { id: 'evt_other', createdAt: '2026-09-27T11:00:00.000Z', sourceMessageIds: ['u1'], summary: 'Other.' }]
          }
        }
      } as any)
    }
    expect((await compact()).status).toBe(409)
    expect(countCompactRuns(SESSION)).toBe(0)

    // The model failed.
    await seedChat()
    model.hook = null
    model.fail = true
    expect((await compact()).status).toBe(500)
    expect(countCompactRuns(SESSION)).toBe(0)

    // Stopped.
    await seedChat()
    model.fail = false
    model.hook = async (params) => {
      await stop()
      await hangUntilStopped(params)
    }
    expect((await compact()).status).toBe(409)
    expect(countCompactRuns(SESSION)).toBe(0)
  })
})
