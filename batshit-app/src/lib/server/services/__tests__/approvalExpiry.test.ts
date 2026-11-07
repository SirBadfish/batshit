import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import * as commitOwner from '../approvalExpiryCommit'
import { retireSavedCliApprovals, sweepApprovalState } from '../approvalExpiry'

let admittedDatabase: number | undefined
useRedisTestServer({ beforeCleanupAdmission: async ({ adminClient }) => {
  const connection = await adminClient.clientInfo()
  expect([14, 15]).toContain(connection.db)
  expect(await adminClient.info('server')).toContain('redis_version:8.10.1')
  expect(await adminClient.sendCommand(['JSON.GET', 'bl1998:missing', '$'])).toBeNull()
  const appConnection = await redis.execute(client => client.clientInfo())
  expect(appConnection.db).toBe(connection.db)
  expect(appConnection.id).not.toBe(connection.id)
  admittedDatabase = connection.db
  console.info('[BL-1998 Redis admission]', JSON.stringify({ database: connection.db, appDatabase: appConnection.db, version: '8.10.1', json: true }))
} })
afterAll(async () => {
  if (process.env.VITEST_USE_REAL_REDIS !== 'true') return
  try {
    if (admittedDatabase === undefined) return
    await redis.execute(async client => {
      const connection = await client.clientInfo()
      if (connection.db !== admittedDatabase || ![14, 15].includes(connection.db)) throw new Error('BL-1998 fixture cleanup refuses a different/unadmitted database.')
      await client.unlink([KEY, `session:${SESSION}`])
      expect(await client.exists([KEY, `session:${SESSION}`])).toBe(0)
      console.info('[BL-1998 Redis cleanup]', JSON.stringify({ database: connection.db, remainingOwnedKeys: 0 }))
    })
  } finally { await redis.disconnect() }
})
afterEach(() => vi.restoreAllMocks())

const USER = 'bl1998-user'
const SESSION = 'bl1998-session'
const CARD = 'bl1998-card'
const KEY = `message:${SESSION}:${CARD}`
const REQUESTED = '2026-10-21T20:00:00.000Z'
const NOW = Date.parse(REQUESTED) + 300_000
const entry = (approvalId = 'bash', extra: Record<string, unknown> = {}) => ({
  approvalId, status: 'pending', requestedAt: REQUESTED, toolName: 'native_bash_execute', ...extra
})
const siblings = {
  zipIds: ['zip-current'], steers: [{ id: 'steer-current', text: 'Keep it' }], notes: ['current'],
  imageOriginExpected: true, imageOriginExpectedVersion: 7,
  whiteboardContextSnapshot: { version: 3, content: 'current' }, futureLiveSnapshot: { private: ['retain'] }
}
function card(metadata: Record<string, unknown> = {}) {
  return { id: CARD, session_id: SESSION, user_id: USER, role: 'assistant', content: 'server words', created_at: REQUESTED,
    metadata: { ...siblings, toolApprovals: { mode: 'all', source: 'vercel', approvals: [entry()] }, ...metadata } }
}
async function seed(value = card()) {
  await redis.json.set(`session:${SESSION}`, '$', { id: SESSION, user_id: USER })
  await redis.json.set(KEY, '$', value)
}
const read = () => redis.json.get(KEY) as Promise<any>
const sweep = (extra: Partial<Parameters<typeof sweepApprovalState>[0]> = {}) => sweepApprovalState({
  userId: USER, sessionId: SESSION, persistedMessages: [card()], requestMessages: [], nowMs: NOW, ...extra
})

describe('approval expiry: stored authority and atomic leaf writes (BL-1998)', () => {
  it('retires only saved CLI/Claude entries, preserves a live API entry and every sibling, and retries a changed preimage', async () => {
    await seed(card({ answeredApprovalIds: ['old-permission'], toolApprovals: { mode: 'all', source: 'claude', extra: { keep: 'summary' }, approvals: [
      entry('old-permission', { source: 'claude', submitted: true }), entry('old-control', { source: 'fabric', control: { lane: 'cli', approvalId: 'apr_old' } }),
      entry('api', { source: 'vercel', control: { lane: 'api', approvalId: 'apr_api' } })
    ] } }))
    const commit = commitOwner.commitApprovalExpiry
    const spy = vi.spyOn(commitOwner, 'commitApprovalExpiry').mockImplementationOnce(async input => {
      await redis.json.set(KEY, '$.metadata.notes', ['concurrent'])
      return commit(input)
    })
    const result = await retireSavedCliApprovals({ userId: USER, sessionId: SESSION, messageId: CARD, approvalIds: ['old-control'] })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ retiredApprovalIds: ['old-permission', 'old-control'], controlApprovalIds: ['apr_old'], hasPending: true })
    const saved = await read()
    expect(saved.content).toBe('server words')
    expect(saved.metadata).toMatchObject({ ...siblings, notes: ['concurrent'] })
    expect(saved.metadata.toolApprovals.extra).toEqual({ keep: 'summary' })
    expect(saved.metadata.toolApprovals.approvals).toMatchObject([
      { status: 'expired', expiryReason: 'run_ended' }, { status: 'expired', expiryReason: 'run_ended' }, { status: 'pending' }
    ])
  })

  it('never treats a current Claude-plan card or request-only old card as retirement authority', async () => {
    const current = card({ claudePlanReply: true, toolApprovals: { source: 'claude', approvals: [entry('current')] } })
    await seed(current)
    const before = await redis.json.getRaw(KEY, '$')
    await expect(retireSavedCliApprovals({ userId: USER, sessionId: SESSION, messageId: CARD, approvalIds: ['current'] })).resolves.toBeNull()
    await expect(retireSavedCliApprovals({ userId: 'foreign', sessionId: SESSION, messageId: CARD, approvalIds: ['current'] })).resolves.toBeNull()
    expect(await redis.json.getRaw(KEY, '$')).toBe(before)
  })

  it('establishes the held-receipt marker on an already expired old card without rewriting sibling fields', async () => {
    await seed(card({ steerPromoted: { steerIds: ['voice-1'], future: { keep: true } }, toolApprovals: {
      source: 'fabric', approvals: [entry('old', { status: 'expired', source: 'fabric', control: { lane: 'cli', approvalId: 'apr_old' } })] } }))
    const result = await retireSavedCliApprovals({ userId: USER, sessionId: SESSION, messageId: CARD, approvalIds: ['old'] })
    expect(result).toMatchObject({ hasPending: false, controlApprovalIds: ['apr_old'], retiredApprovalIds: ['old'] })
    expect((await read()).metadata).toMatchObject({ ...siblings, whiteboardContextSnapshot: null, retiredApprovalSettled: true,
      steerPromoted: { steerIds: ['voice-1'], disposition: 'unanswered', reason: 'approval_expired', future: { keep: true } } })
  })

  it('preflights a malformed steer disposition before writing a retired-card status', async () => {
    await seed(card({ steerPromoted: 'bad', steers: [{ steerId: 'voice-1', source: 'user' }], toolApprovals: {
      source: 'fabric', approvals: [entry('old', { source: 'fabric', control: { lane: 'cli' } })] } }))
    const before = await redis.json.getRaw(KEY, '$')
    await expect(retireSavedCliApprovals({ userId: USER, sessionId: SESSION, messageId: CARD, approvalIds: ['old'] }))
      .rejects.toMatchObject({ code: 'retired_approval_unconfirmed' })
    expect(await redis.json.getRaw(KEY, '$')).toBe(before)
  })
  it.each([{}, { toolApprovals: null }, { toolApprovals: { approvals: [] } }])('ignores stale request cards over cleared stored metadata: %j', async metadata => {
    const stored = card(metadata)
    // The first fixture really has no summary, rather than a pending default summary.
    if (!Object.hasOwn(metadata, 'toolApprovals')) delete (stored.metadata as any).toolApprovals
    await seed(stored)
    const before = await redis.json.getRaw(KEY, '$')
    const result = await sweep({ requestMessages: [card({ ...siblings, notes: ['stale'] })] })
    expect(result.newlyExpired).toEqual([])
    expect(result.byId.size).toBe(0)
    expect(await redis.json.getRaw(KEY, '$')).toBe(before)
  })

  it('expires genuine API/Bash cards, keeps CLI/service and Claude clocks, and retains every sibling', async () => {
    const value = card({ toolApprovals: { mode: 'all', source: 'vercel', extra: { keep: 'summary' }, approvals: [
      entry(), entry('api', { control: { lane: 'api', approvalId: 'apr_api' } }),
      entry('cli', { control: { lane: 'cli' } }), entry('service', { control: { lane: 'service' } }),
      entry('claude', { expiresAt: new Date(NOW + 300_000).toISOString() }),
      entry('answered', { status: 'approved', submitted: true }), entry('denied', { status: 'denied' })
    ] } })
    await seed(value)
    const result = await sweep({ requestMessages: [card({ zipIds: ['stale'] })] })
    expect(result.newlyExpired.map(item => item.approvalId)).toEqual(['bash', 'api'])
    expect(result.newlyExpired[1].controlApprovalId).toBe('apr_api')
    const saved = await read()
    expect(saved).toMatchObject({ content: 'server words', metadata: siblings })
    expect(saved.metadata.toolApprovals.extra).toEqual({ keep: 'summary' })
    expect(saved.metadata.toolApprovals.approvals.map((item: any) => item.status)).toEqual(['expired', 'expired', 'pending', 'pending', 'pending', 'approved', 'denied'])
    expect((await sweep()).newlyExpired).toEqual([])
    expect(saved.metadata.toolApprovals.approvals[0]).toMatchObject({ submitted: false, expiredAt: new Date(NOW).toISOString() })
  })

  it('point-reads a clicked old card beyond both history windows; missing/request-only cards stay absent', async () => {
    await seed()
    const result = await sweep({ persistedMessages: [], requestMessages: [], cardMessageId: CARD })
    expect(result.newlyExpired).toHaveLength(1)
    await redis.del(KEY)
    expect((await sweep({ requestMessages: [card(), { metadata: card().metadata }] })).newlyExpired).toEqual([])
    expect(await read()).toBeNull()
  })

  it.each(['settled', 'answered', 'sibling'] as const)('recomputes after a concurrent %s save and never overwrites it', async boundary => {
    await seed()
    const commit = commitOwner.commitApprovalExpiry
    const spy = vi.spyOn(commitOwner, 'commitApprovalExpiry').mockImplementationOnce(async input => {
      const current = await read()
      if (boundary === 'settled') current.metadata.toolApprovals = null
      if (boundary === 'answered') {
        current.metadata.toolApprovals.approvals[0] = entry('bash', { status: 'approved', submitted: true })
        current.metadata.answeredApprovalIds = ['bash']
      }
      current.metadata.notes = ['concurrent']
      await redis.json.set(KEY, '$', current)
      return commit(input)
    })
    const result = await sweep()
    const saved = await read()
    expect(saved.metadata.notes).toEqual(['concurrent'])
    expect(saved.metadata.zipIds).toEqual(siblings.zipIds)
    if (boundary === 'sibling') {
      expect(result.newlyExpired).toHaveLength(1)
      expect(spy).toHaveBeenCalledTimes(2)
    } else {
      expect(result.newlyExpired).toEqual([])
      expect(spy).toHaveBeenCalledTimes(1)
      expect(saved.metadata.toolApprovals).toEqual(boundary === 'settled' ? null : expect.objectContaining({ approvals: [expect.objectContaining({ status: 'approved', submitted: true })] }))
    }
  })

  it.each(['message', 'session'] as const)('does not recreate data deleted at the %s boundary', async boundary => {
    await seed()
    const commit = commitOwner.commitApprovalExpiry
    vi.spyOn(commitOwner, 'commitApprovalExpiry').mockImplementationOnce(async input => {
      await redis.del(boundary === 'message' ? KEY : `session:${SESSION}`)
      return commit(input)
    })
    if (boundary === 'session') await expect(sweep()).rejects.toThrow('MISSING_SESSION')
    else expect((await sweep()).newlyExpired).toEqual([])
    expect(await redis.json.get(boundary === 'message' ? KEY : `session:${SESSION}`)).toBeNull()
    if (boundary === 'session') expect((await read()).metadata.toolApprovals.approvals[0].status).toBe('pending')
  })

  it.each([{ role: 'user' }, { user_id: 'other' }, { session_id: 'other' }, { id: 'other' }])('ignores a nonowned/nonassistant record: %j', async changes => {
    await seed({ ...card(), ...changes })
    const before = await redis.json.getRaw(KEY, '$')
    expect((await sweep()).newlyExpired).toEqual([])
    expect(await redis.json.getRaw(KEY, '$')).toBe(before)
  })

  it('refuses a changed session owner in the atomic write', async () => {
    await seed()
    await redis.json.set(`session:${SESSION}`, '$', { id: SESSION, user_id: 'other' })
    await expect(sweep()).rejects.toThrow('FORBIDDEN')
    expect((await read()).metadata.toolApprovals.approvals[0].status).toBe('pending')
  })

  it('preserves an answered marker even when a stored entry still says pending', async () => {
    await seed(card({ answeredApprovalIds: ['bash'] }))
    const before = await redis.json.getRaw(KEY, '$')
    expect((await sweep()).newlyExpired).toEqual([])
    expect(await redis.json.getRaw(KEY, '$')).toBe(before)
  })

  it('observes Stop after the read and before issuing a write', async () => {
    await seed()
    const stop = new AbortController()
    const getRaw = redis.json.getRaw.bind(redis.json)
    vi.spyOn(redis.json, 'getRaw').mockImplementationOnce(async (...args) => {
      const raw = await getRaw(...args)
      stop.abort(new Error('Stopped'))
      return raw
    })
    const commit = vi.spyOn(commitOwner, 'commitApprovalExpiry')
    await expect(sweep({ signal: stop.signal })).rejects.toThrow('Stopped')
    expect(commit).not.toHaveBeenCalled()
    expect((await read()).metadata.toolApprovals.approvals[0].status).toBe('pending')
  })

  it('fences Stop after awaited client acquisition and before the actual EVAL issue', async () => {
    const actual = await vi.importActual<typeof import('../approvalExpiryCommit')>('../approvalExpiryCommit')
    const stop = new AbortController()
    let acquire!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const acquired = new Promise<void>(resolve => { acquire = resolve })
    const evalCommand = vi.fn()
    vi.spyOn(redis, 'execute').mockImplementationOnce(async operation => {
      entered()
      await acquired
      return operation({ eval: evalCommand } as any)
    })
    const pending = actual.commitApprovalExpiry({ userId: USER, sessionId: SESSION, messageId: CARD,
      expectedRaw: '[]', changes: [], signal: stop.signal })
    await waiting
    stop.abort(new Error('Stopped during client acquisition'))
    acquire()
    await expect(pending).rejects.toThrow('Stopped during client acquisition')
    expect(evalCommand).not.toHaveBeenCalled()
  })

  it('refuses repeated conflicts instead of announcing an unsaved expiry', async () => {
    await seed()
    const commit = vi.spyOn(commitOwner, 'commitApprovalExpiry').mockResolvedValue('CHANGED')
    await expect(sweep()).rejects.toThrow('kept changing')
    expect(commit).toHaveBeenCalledTimes(3)
    expect((await read()).metadata.toolApprovals.approvals[0].status).toBe('pending')
  })

  it('never retries an unknown acknowledgement or returns expiry notices for it', async () => {
    await seed()
    const commit = commitOwner.commitApprovalExpiry
    const spy = vi.spyOn(commitOwner, 'commitApprovalExpiry').mockImplementationOnce(async input => {
      await commit(input)
      throw new Error('Write acknowledgement lost')
    })
    await expect(sweep()).rejects.toThrow('acknowledgement lost')
    expect(spy).toHaveBeenCalledTimes(1)
    expect((await read()).metadata.toolApprovals.approvals[0].status).toBe('expired')
  })

  describe('SA-137: the expired pause retires its own live-file-read snapshot in the same write', () => {
    const replay = (pauseId = 'pause-1', approvalIds = ['bash']) =>
      ({ schema_version: 1, pauseId, approvalIds, copies: [{ zipId: 'cool_tool_1', status: 'static', reason: 'deadline' }] })

    it('a card that fully expires clears its snapshot; every sibling, the whiteboard fragment included, stays', async () => {
      await seed(card({ liveFileReadSnapshot: replay() }))
      expect((await sweep()).newlyExpired).toHaveLength(1)
      const saved = await read()
      expect(saved.metadata.liveFileReadSnapshot).toBeNull()
      expect(saved).toMatchObject({ content: 'server words', metadata: siblings })
    })

    it('a card with an approval still pending keeps it', async () => {
      await seed(card({ liveFileReadSnapshot: replay('pause-1', ['bash', 'cli']),
        toolApprovals: { mode: 'all', source: 'vercel', approvals: [entry(), entry('cli', { control: { lane: 'cli' } })] } }))
      expect((await sweep()).newlyExpired).toHaveLength(1)
      expect((await read()).metadata.liveFileReadSnapshot).toEqual(replay('pause-1', ['bash', 'cli']))
    })

    it('an absent field stays absent, and a cleared one stays null', async () => {
      await seed()
      await sweep()
      expect(Object.hasOwn((await read()).metadata, 'liveFileReadSnapshot')).toBe(false)
      await seed(card({ liveFileReadSnapshot: null }))
      await sweep()
      expect((await read()).metadata.liveFileReadSnapshot).toBeNull()
    })

    it('a concurrent new pause on the same record is never retired (the exact-record check, then a recompute)', async () => {
      await seed(card({ liveFileReadSnapshot: replay() }))
      const commit = commitOwner.commitApprovalExpiry
      const spy = vi.spyOn(commitOwner, 'commitApprovalExpiry').mockImplementationOnce(async input => {
        const current = await read()
        current.metadata.toolApprovals.approvals = [entry('bash-2', { requestedAt: new Date(NOW).toISOString() })]
        current.metadata.liveFileReadSnapshot = replay('pause-2', ['bash-2'])
        await redis.json.set(KEY, '$', current)
        return commit(input)
      })
      expect((await sweep()).newlyExpired).toEqual([])
      // The recompute only stamps the new card's clock; it names no pause to retire.
      expect(spy).toHaveBeenCalledTimes(2)
      expect(spy.mock.calls[1][0].retireLiveReplayPauseId).toBeNull()
      expect((await read()).metadata.liveFileReadSnapshot).toEqual(replay('pause-2', ['bash-2']))
    })

    it('an older card\'s entry expiring on the same record never clears the current pause\'s snapshot', async () => {
      // A mixed click left `old` pending; the reply then paused again on `current`, which was just
      // answered (its resume reads the snapshot next).
      await seed(card({ liveFileReadSnapshot: replay('pause-now', ['current']), answeredApprovalIds: ['current'],
        toolApprovals: { mode: 'all', source: 'vercel', approvals: [entry('old'), entry('current', { status: 'approved', submitted: true })] } }))
      expect((await sweep()).newlyExpired.map(item => item.approvalId)).toEqual(['old'])
      expect((await read()).metadata.liveFileReadSnapshot).toEqual(replay('pause-now', ['current']))
    })

    it('the write clears only the pause it names', async () => {
      const value = card({ liveFileReadSnapshot: replay('pause-now') })
      await seed(value)
      const expectedRaw = await redis.json.getRaw(KEY, '$')
      const changes = [{ index: 0, fields: { status: 'expired' } }]
      expect(await commitOwner.commitApprovalExpiry({ userId: USER, sessionId: SESSION, messageId: CARD, expectedRaw: expectedRaw!,
        changes, retireLiveReplayPauseId: 'pause-other' })).toBe('OK')
      expect((await read()).metadata.liveFileReadSnapshot).toEqual(replay('pause-now'))
      await seed(value)
      expect(await commitOwner.commitApprovalExpiry({ userId: USER, sessionId: SESSION, messageId: CARD,
        expectedRaw: (await redis.json.getRaw(KEY, '$'))!, changes, retireLiveReplayPauseId: 'pause-now' })).toBe('OK')
      const saved = await read()
      expect(saved.metadata.liveFileReadSnapshot).toBeNull()
      expect(saved.metadata.toolApprovals.approvals[0].status).toBe('expired')
    })
  })

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('retains raw large numbers in siblings and tool input without JSON re-encoding', async () => {
    await seed()
    const raw = JSON.stringify(card()).replace('"server words"', '"server words","precise":9007199254740993')
      .replace('"toolName":"native_bash_execute"', '"toolName":"native_bash_execute","input":{"precise":9007199254740993}')
    await redis.execute(client => client.sendCommand(['JSON.SET', KEY, '$', raw]))
    // Multi-path JSON.GET returns a map with unspecified key order. Compare each raw value
    // independently, without parsing its large integer through JavaScript numbers.
    const readProtectedRaw = () => Promise.all(['$.precise', '$.metadata.toolApprovals.approvals[0].input'].map(path =>
      redis.execute(client => client.sendCommand(['JSON.GET', KEY, path]))))
    const before = await readProtectedRaw()
    await sweep()
    expect(await readProtectedRaw()).toEqual(before)
  })
})
