// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import {
  SettingsLifecycleRefusal,
  withSettingsRecordReplacement
} from '../../appActions/settings/lifecycle'
import { READ_MEMORY_OBSERVATION } from '../memoryOwnership'
import { recallMemoriesOp } from '../memoryTools'
import type { MemoryRecord } from '../memoryTypes'

/**
 * Direct-id recall must publish the final bounded ownership observation, not rows
 * captured before statistics or queue work yielded. This default-owner fixture
 * uses the real operation/decoder/lifecycle; only stats/queue and the opaque Redis
 * observation transport are substituted. It does not interpret Lua or contact Redis.
 */
const seams = vi.hoisted(() => ({
  touchMemoryRecall: vi.fn(),
  touchMemorySegmentRecall: vi.fn(),
  queuePendingMemoryRecalls: vi.fn()
}))

vi.mock('../memoryStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../memoryStore')>(),
  touchMemoryRecall: seams.touchMemoryRecall,
  touchMemorySegmentRecall: seams.touchMemorySegmentRecall
}))

vi.mock('../memoryLinger', async (importOriginal) => ({
  ...await importOriginal<typeof import('../memoryLinger')>(),
  queuePendingMemoryRecalls: seams.queuePendingMemoryRecalls
}))

const USER = 'recall_freshness_user'
const AGENT = 'recall_freshness_agent'
const SESSION = 'recall_freshness_chat'
const FIRST = 'mem_recall_freshness_first'
const SECOND = 'mem_recall_freshness_second'
const AGENT_CREATED = '2026-10-01T12:00:00.000Z'
const SESSION_CREATED = '2026-10-02T12:00:00.000Z'
const FIRST_CONTENT = 'First recalled fact, removed before publication.'
const SECOND_CONTENT = 'Second recalled fact, before the deferred work.'
const FRESH_CONTENT = 'Second recalled fact, changed before publication.'
const CONTEXT = { userId: USER, agentId: AGENT, sessionId: SESSION }
const agentKey = `agent:${AGENT}`
const sessionKey = `session:${SESSION}`
const memoryKey = (id: string) => `memory:${AGENT}:${id}`
const agentRecord = {
  id: AGENT, user_id: USER, agentType: 'api', name: 'Recall freshness',
  memory_enabled: true, created_at: AGENT_CREATED
}
const sessionRecord = {
  id: SESSION, user_id: USER, created_at: SESSION_CREATED,
  // Ordinary multi-agent chats need not name the recalling agent here.
  agent_id: 'another_agent_in_this_chat', metadata: {}
}

function record(id: string, content: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, agent_id: AGENT, user_id: USER, lane: 'ltm', content, importance: 5,
    event_at: null, event_ts: null, saved_at: AGENT_CREATED,
    saved_ts: Date.parse(AGENT_CREATED), is_superseded: 'n',
    provenance: [{ session_id: SESSION, source: 'agent' }], visibility: 'normal',
    embedding: [1, 0], embedding_model: 'fixture-no-embedder', schema_version: 1,
    ...extra
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

// Fail immediately on an unrelated setup/refusal instead of waiting for a seam
// the operation never reaches. No clock, sleep or polling controls this race.
async function reached(entered: Promise<void>, pending: Promise<unknown>) {
  await Promise.race([
    entered,
    pending.then(() => { throw new Error('Recall completed before the deferred seam.') })
  ])
}

let observationKeys: string[][] = []
let restoreExecute: (() => void) | undefined

beforeEach(async () => {
  seams.touchMemoryRecall.mockReset().mockResolvedValue(undefined)
  seams.touchMemorySegmentRecall.mockReset().mockResolvedValue(undefined)
  seams.queuePendingMemoryRecalls.mockReset().mockResolvedValue(undefined)
  observationKeys = []

  // Capture the implementation, not a bound vi.fn that would recurse after the
  // spy is installed. All non-observation Lua remains unsupported in this file.
  const original = vi.mocked(redis.execute).getMockImplementation()
  if (!original) throw new Error('Recall freshness requires the existing default Redis fake.')
  const spy = vi.spyOn(redis, 'execute').mockImplementation(operation => original(async client => operation(new Proxy(client, {
    get(target, key) {
      if (key !== 'eval') return Reflect.get(target, key)
      return async (script: string, options: { keys: string[]; arguments: string[] }) => {
        if (script !== READ_MEMORY_OBSERVATION) throw new Error('Only the opaque bounded memory observation is admitted by this fixture.')
        observationKeys.push([...options.keys])
        const readOwner = async (ownerKey: string) => {
          if (!ownerKey) return ['none', '']
          const kind = await client.type(ownerKey)
          if (kind === 'none') return ['none', '']
          return kind === 'string'
            ? ['string', await client.get(ownerKey)]
            : ['ReJSON-RL', JSON.stringify(await client.json.get(ownerKey))]
        }
        const clock = Date.now()
        const [agent, session, ...keys] = options.keys
        const rows = await Promise.all(keys.map(async recordKey => {
          const value = await client.json.get(recordKey)
          return [recordKey, value == null ? '' : JSON.stringify(value)]
        }))
        return [String(Math.floor(clock / 1000)), String(clock % 1000 * 1000),
          ...await readOwner(agent), ...await readOwner(session), rows]
      }
    }
  }))))
  restoreExecute = () => spy.mockRestore()

  await redis.json.set(agentKey, '$', agentRecord as never)
  await redis.json.set(sessionKey, '$', sessionRecord as never)
  await redis.json.set(memoryKey(FIRST), '$', record(FIRST, FIRST_CONTENT) as never)
  await redis.json.set(memoryKey(SECOND), '$', record(SECOND, SECOND_CONTENT) as never)
})

afterEach(() => { restoreExecute?.(); restoreExecute = undefined })

function expectOriginalQueueOwner() {
  expect(seams.queuePendingMemoryRecalls).toHaveBeenCalledTimes(1)
  expect(seams.queuePendingMemoryRecalls).toHaveBeenCalledWith(SESSION, AGENT, [
    { id: FIRST, kind: 'memory' }, { id: SECOND, kind: 'memory' }
  ], {
    userId: USER,
    lifecycle: {
      epoch: expect.any(String),
      records: [[agentKey, expect.any(String)], [sessionKey, expect.any(String)]]
    },
    agentOwner: { id: AGENT, userId: USER, storage: 'ReJSON-RL', created: JSON.stringify(AGENT_CREATED) },
    sessionOwner: { id: SESSION, userId: USER, storage: 'ReJSON-RL', created: JSON.stringify(SESSION_CREATED) }
  })
}

describe.runIf(process.env.VITEST_USE_REAL_REDIS !== 'true')('direct-id recall final observation freshness', () => {
  it.each(['second touch', 'queue'] as const)('does not return the already-touched first record deleted while %s waits', async (seam) => {
    const entered = deferred(), gate = deferred()
    if (seam === 'second touch') {
      seams.touchMemoryRecall.mockImplementation(async (_agentId, id) => {
        if (id === SECOND) { entered.resolve(); await gate.promise }
      })
    } else {
      seams.queuePendingMemoryRecalls.mockImplementation(async () => { entered.resolve(); await gate.promise })
    }
    const pending = recallMemoriesOp(CONTEXT, { memoryIds: [FIRST, SECOND] })
    try {
      await reached(entered.promise, pending)
      expect(seams.touchMemoryRecall.mock.calls.map(call => call.slice(0, 2))).toEqual([[AGENT, FIRST], [AGENT, SECOND]])
      expect(observationKeys).toEqual([[agentKey, sessionKey, memoryKey(FIRST), memoryKey(SECOND)]])
      if (seam === 'second touch') expect(seams.queuePendingMemoryRecalls).not.toHaveBeenCalled()
      else expectOriginalQueueOwner()

      const deleted = Date.now()
      await redis.json.set(memoryKey(FIRST), '$', record(FIRST, FIRST_CONTENT, {
        deleted_ts: deleted, deleted_at: new Date(deleted).toISOString()
      }) as never)
      await redis.json.set(memoryKey(SECOND), '$', record(SECOND, FRESH_CONTENT) as never)
    } finally { gate.resolve() }

    const result = await pending
    expect(result.recalled).toEqual([expect.objectContaining({ id: SECOND, content: FRESH_CONTENT, expired: false })])
    expect(JSON.stringify(result)).not.toContain(FIRST_CONTENT)
    expect(JSON.stringify(result)).not.toContain(SECOND_CONTENT)
    expect(result.note).toContain('Some requested records became unavailable during recall and were not returned.')
    expect(observationKeys).toEqual(Array.from({ length: 2 }, () => [agentKey, sessionKey, memoryKey(FIRST), memoryKey(SECOND)]))
    expectOriginalQueueOwner()
    expect(seams.touchMemorySegmentRecall).not.toHaveBeenCalled()
  })

  it('returns an explicit expired-only historical LTM read without statistics or an empty queue write', async () => {
    const expired = Date.now() - 60_000
    await redis.json.set(memoryKey(FIRST), '$', record(FIRST, FIRST_CONTENT, {
      lane: 'awareness', expires_ts: expired, expires_at: new Date(expired).toISOString()
    }) as never)

    const result = await recallMemoriesOp(CONTEXT, { memoryIds: [FIRST], include_expired: true })

    expect(result.recalled).toEqual([expect.objectContaining({ id: FIRST, content: FIRST_CONTENT, lane: 'ltm', expired: true })])
    expect(result.note).toContain('Expired results are historical references and are excluded from automatic context.')
    expect(result.note).toContain('No records were queued for later messages.')
    expect(seams.touchMemoryRecall).not.toHaveBeenCalled()
    expect(seams.touchMemorySegmentRecall).not.toHaveBeenCalled()
    expect(seams.queuePendingMemoryRecalls).not.toHaveBeenCalled()
    expect(observationKeys).toEqual([[agentKey, sessionKey, memoryKey(FIRST)], [agentKey, sessionKey, memoryKey(FIRST)]])
  })

  it.each([
    { label: 'user ownership', replacement: { ...sessionRecord, user_id: 'another_user' } },
    { label: 'creation incarnation', replacement: { ...sessionRecord, created_at: '2026-10-03T12:00:00.000Z' } }
  ])('refuses changed session $label at the final observation', async ({ replacement }) => {
    const entered = deferred(), gate = deferred()
    seams.queuePendingMemoryRecalls.mockImplementation(async () => { entered.resolve(); await gate.promise })
    const pending = recallMemoriesOp(CONTEXT, { memoryIds: [FIRST, SECOND] })
    try {
      await reached(entered.promise, pending)
      expectOriginalQueueOwner()
      expect(observationKeys).toHaveLength(1)
      await redis.json.set(sessionKey, '$', replacement as never)
    } finally { gate.resolve() }

    await expect(pending).rejects.toThrow('The originating chat owner changed.')
    expect(observationKeys).toEqual(Array.from({ length: 2 }, () => [agentKey, sessionKey, memoryKey(FIRST), memoryKey(SECOND)]))
    expect(seams.touchMemoryRecall).toHaveBeenCalledTimes(2)
    expect(seams.touchMemorySegmentRecall).not.toHaveBeenCalled()
  })

  it('refuses an identical same-id chat recreation through its actual lifecycle owner', async () => {
    const entered = deferred(), gate = deferred()
    seams.queuePendingMemoryRecalls.mockImplementation(async () => { entered.resolve(); await gate.promise })
    const pending = recallMemoriesOp(CONTEXT, { memoryIds: [FIRST, SECOND] })
    try {
      await reached(entered.promise, pending)
      expectOriginalQueueOwner()
      await withSettingsRecordReplacement(sessionKey, async () => {
        await redis.del(sessionKey)
        await redis.json.set(sessionKey, '$', sessionRecord as never)
      })
      expect(await redis.json.get(sessionKey)).toEqual(sessionRecord)
    } finally { gate.resolve() }

    await expect(pending).rejects.toBeInstanceOf(SettingsLifecycleRefusal)
    await expect(pending).rejects.toMatchObject({
      status: 409, code: 'SETTINGS_LIFECYCLE_CHANGED',
      message: 'Settings identity changed or is being replaced. Reload before continuing.'
    })
    expect(observationKeys).toEqual(Array.from({ length: 2 }, () => [agentKey, sessionKey, memoryKey(FIRST), memoryKey(SECOND)]))
    expect(seams.touchMemoryRecall).toHaveBeenCalledTimes(2)
    expect(seams.touchMemorySegmentRecall).not.toHaveBeenCalled()
  })
})
