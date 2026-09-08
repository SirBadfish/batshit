import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  __resetWakeRunRegistryForTests,
  registerWakeRun
} from '$lib/server/services/wakeRunRegistry'
import { buildSessionOrigin } from '$lib/utils/sessionOrigin'
import { ZipDetectionService } from '$lib/server/services/zipDetection'
import { POST } from '../../../routes/api/sse/+server'

/**
 * SA-113 P1 / AMD-113-01 — the headless-turn buffering decision, against the real route.
 *
 * The P0 spike proved the defect: a tab opening 7 s into a headless turn received no
 * `start`, no `tool-call`, and none of the first chunks, because `/api/sse` POST drops an
 * event when a session has no listener. That drop is correct for an async n8n callback and
 * wrong for a wake-up, which opens a real user-facing chat.
 *
 * These pin the branch: an unwatched session with an active woken turn is PROCESSED (so
 * the replay buffer fills and send-routed's `forwardedTextChunkToActiveSse` flips, handing
 * zips to the stream path); an unwatched session with no woken turn is still dropped.
 *
 * Persisted parity between a watched and a headless turn is a live claim and is proved on
 * a live instance, not here.
 */

useRedisTestServer()

const USER = 'user-sse-wake'
const envRecord = env as Record<string, string | undefined>
let previousToken: string | undefined

function internalRequest(body: Record<string, unknown>) {
  return new Request('http://localhost:5621/api/sse', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-batshit-service-token': 'test-service-token',
      'x-internal-api-request': '1'
    },
    body: JSON.stringify(body)
  })
}

async function callPost(body: Record<string, unknown>) {
  const response = (await (POST as any)({
    request: internalRequest(body),
    locals: {}
  })) as Response
  return { status: response.status, json: await response.json() }
}

function startWakeRun(sessionId: string) {
  const timer = setTimeout(() => {}, 60_000)
  registerWakeRun({
    sessionId,
    agentId: 'agent-cooper',
    userId: USER,
    origin: buildSessionOrigin({ kind: 'dm', label: 'Faye', chainDepth: 1 }),
    startedAt: Date.now(),
    controller: new AbortController(),
    timer
  })
}

beforeEach(async () => {
  previousToken = envRecord.BATSHIT_TOKEN
  envRecord.BATSHIT_TOKEN = 'test-service-token'
  await redis.createSession({
    id: 'sess-wake',
    user_id: USER,
    name: 'Woken',
    agent_id: 'agent-cooper',
    created_at: '2026-09-07T09:00:00.000Z',
    last_modified_at: '2026-09-07T09:00:00.000Z'
  } as any)
})

afterEach(() => {
  __resetWakeRunRegistryForTests()
  if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
  else envRecord.BATSHIT_TOKEN = previousToken
  vi.restoreAllMocks()
})

describe('/api/sse POST with no listener', () => {
  it('still drops an event for an ordinary unwatched session', async () => {
    const result = await callPost({
      sessionId: 'sess-wake',
      type: 'chunk',
      messageId: 'msg-1',
      content: 'hello'
    })

    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ success: false, message: 'No active SSE connection' })
  })

  it('processes the event when a woken turn is running, so the replay buffer fills', async () => {
    startWakeRun('sess-wake')

    const result = await callPost({
      sessionId: 'sess-wake',
      type: 'chunk',
      messageId: 'msg-1',
      content: 'hello'
    })

    expect(result.status).toBe(200)
    // `success: true` is what makes send-routed treat this turn as streamed, so the stream
    // path owns its zips exactly as for a watched turn.
    expect(result.json).toEqual({ success: true })
  })

  it('goes back to dropping once the woken turn ends', async () => {
    startWakeRun('sess-wake')
    __resetWakeRunRegistryForTests()

    const result = await callPost({
      sessionId: 'sess-wake',
      type: 'chunk',
      messageId: 'msg-1',
      content: 'hello'
    })

    expect(result.json).toMatchObject({ success: false })
  })

  it('does not buffer for a DIFFERENT session that has no woken turn', async () => {
    startWakeRun('sess-wake')
    await redis.createSession({
      id: 'sess-other',
      user_id: USER,
      name: 'Other',
      agent_id: 'agent-cooper',
      created_at: '2026-09-07T09:00:00.000Z',
      last_modified_at: '2026-09-07T09:00:00.000Z'
    } as any)

    const result = await callPost({
      sessionId: 'sess-other',
      type: 'chunk',
      messageId: 'msg-1',
      content: 'hello'
    })

    expect(result.json).toMatchObject({ success: false })
  })
})

describe('F-P1-2: a headless woken turn uses the USER\'s zip settings', () => {
  /**
   * `/api/sse` GET loads `global_zip_settings` when a tab connects and drops them on the
   * last disconnect. A woken turn can stream with nobody watching, and AMD-113-01 hands
   * its zips to the stream path — so without this the user\'s own thresholds would be
   * ignored for exactly the turns they never see happen.
   *
   * The P1 parity proof used a TOOL zip, which is zip-first regardless of thresholds,
   * which is why it passed while the gap was still there.
   */
  const USER_ZIP_SETTINGS = {
    contentThreshold: 42,
    autoZipEnabled: true,
    marker: 'from-the-user-settings'
  }

  beforeEach(async () => {
    await redis.updateUserSettings(USER, {
      global_zip_settings: USER_ZIP_SETTINGS
    } as any)
  })

  it('loads them for the wake run\'s user and hands them to zip detection', async () => {
    startWakeRun('sess-wake')
    const setContext = vi.spyOn(ZipDetectionService.prototype, 'setContext')

    await callPost({
      sessionId: 'sess-wake',
      type: 'chunk',
      messageId: 'msg-1',
      content: 'hello'
    })

    expect(setContext).toHaveBeenCalled()
    const [, , context] = setContext.mock.calls.at(-1) as any[]
    expect(context.globalSettings).toEqual(USER_ZIP_SETTINGS)
  })

  it('does no zip work at all for an ordinary unwatched session', async () => {
    const setContext = vi.spyOn(ZipDetectionService.prototype, 'setContext')

    await callPost({
      sessionId: 'sess-wake',
      type: 'chunk',
      messageId: 'msg-1',
      content: 'hello'
    })

    // The event is dropped before `processNDJSONLine`, so the detector is never touched.
    expect(setContext).not.toHaveBeenCalled()
  })

  it('does not re-read them for every event in the same turn', async () => {
    startWakeRun('sess-wake')
    const setContext = vi.spyOn(ZipDetectionService.prototype, 'setContext')

    for (let index = 0; index < 3; index += 1) {
      await callPost({
        sessionId: 'sess-wake',
        type: 'chunk',
        messageId: 'msg-1',
        content: `chunk ${index}`
      })
    }

    // The entry is cached for the turn, so every event sees the same object identity.
    const seen = setContext.mock.calls.map(([, , context]: any[]) => context.globalSettings)
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(1)
  })

  it('gives the entry back when the turn ends, so the next turn sees a CHANGED setting', async () => {
    startWakeRun('sess-wake')
    await callPost({
      sessionId: 'sess-wake',
      type: 'chunk',
      messageId: 'msg-1',
      content: 'hello'
    })

    // The turn ends; the next event finds no wake run and releases the loaded entry.
    __resetWakeRunRegistryForTests()
    await callPost({
      sessionId: 'sess-wake',
      type: 'chunk',
      messageId: 'msg-1',
      content: 'after'
    })

    // The user edits their thresholds between turns. A stale cached entry would hide it.
    await redis.updateUserSettings(USER, {
      global_zip_settings: { ...USER_ZIP_SETTINGS, contentThreshold: 999 }
    } as any)

    startWakeRun('sess-wake')
    const setContext = vi.spyOn(ZipDetectionService.prototype, 'setContext')
    await callPost({
      sessionId: 'sess-wake',
      type: 'chunk',
      messageId: 'msg-2',
      content: 'second turn'
    })
    const [, , context] = setContext.mock.calls.at(-1) as any[]
    expect(context.globalSettings).toMatchObject({ contentThreshold: 999 })
  })
})
