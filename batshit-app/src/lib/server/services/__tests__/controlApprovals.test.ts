import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  CONTROL_APPROVAL_TTL_SECONDS,
  GROUP_RISK_REFUSAL_MESSAGE,
  consumeApproval,
  controlApprovalKey,
  controlApprovalsIndexKey,
  createPendingApproval,
  decideApproval,
  decideRiskGate,
  findApprovedMatch,
  getControlApproval,
  hasScopedRiskWindow,
  hashControlInput,
  isWellFormedApprovalId,
  listSessionApprovals,
  markApprovalExpired,
  summarizeControlInput,
  sweepSessionApprovals
} from '../controlApprovals'

/**
 * SA-116 P1 (DL-116-01 … DL-116-04, DL-116-09, DL-116-10) — the click is the approval.
 *
 * The claims here are Redis claims and security claims, so this suite runs on the curated
 * `npm run test:redis` lane in `.github/workflows/ci.yml` as well as the default fake lane:
 * a path write that must be a no-op on a swept key, an index that must be a ZSET, an id
 * guard that exists because two key spaces overlap, and a consume that two callers must not
 * both win.
 *
 * Every test in here was checked the way SA-115's were: revert the fix, watch it go red.
 * The mutation log is in `_local/sa116/p1/P1-EVIDENCE.md`.
 */

useRedisTestServer()

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

const USER = 'user-approvals'
const OTHER_USER = 'user-other'
const AGENT = 'agent-cooper'
const SESSION = 'session-direct'
const GROUP_SESSION = 'session-group'

const stampDmNeedsUser = vi.fn(async () => undefined)
vi.mock('$lib/server/services/dm/dmStore', () => ({
  stampDmNeedsUser: (...args: any[]) => stampDmNeedsUser(...args)
}))

/** The wake primitive's user message — `metadata.wake` is what makes a turn a woken one. */
const wokenUserMessage = (dmId?: string) => ({
  role: 'user',
  content: '[Agent DM — from Faye, not from the user] assignment — Tidy the build',
  metadata: { wake: { chainDepth: 1, ...(dmId ? { dmId } : {}) } }
})

const typedUserMessage = { role: 'user', content: 'hello', metadata: {} }

async function seedSession(id: string, options: { group?: boolean } = {}) {
  await redis.createSession({
    id,
    user_id: USER,
    name: id,
    created_at: new Date().toISOString(),
    last_modified_at: new Date().toISOString(),
    metadata: options.group ? { group_chat: { group_id: 'grp_1' } } : {}
  } as any)
}

/**
 * `resolveWokenTurnState` reads `redis.getRecentMessages`. Spying on the wrapper rather
 * than seeding messages keeps the woken/typed distinction explicit in each test, and is the
 * only way to make the read THROW for the fail-closed case.
 */
function setTurnMessages(messages: unknown[] | Error) {
  return vi
    .spyOn(redis, 'getRecentMessages')
    .mockImplementation(async () => {
      if (messages instanceof Error) throw messages
      return messages as any
    })
}

function gateInput(overrides: Record<string, any> = {}) {
  return {
    userId: USER,
    agentId: AGENT,
    sessionId: SESSION,
    controlId: 'sys.memory.delete',
    controlTitle: 'Delete Memory',
    riskLevel: 'confirm' as const,
    lane: 'api' as const,
    input: { memory_id: 'mem_1' },
    ...overrides
  }
}

beforeEach(async () => {
  vi.restoreAllMocks()
  stampDmNeedsUser.mockClear()
  await seedSession(SESSION)
  await seedSession(GROUP_SESSION, { group: true })
  setTurnMessages([typedUserMessage])
})

afterEach(() => {
  vi.restoreAllMocks()
})

/* ------------------------------------------------------------------ *
 * The record store (DL-116-02)
 * ------------------------------------------------------------------ */

describe('the approval record', () => {
  it('stores the record, indexes it by requestedAt, and expires both in 24 hours', async () => {
    const record = await createPendingApproval({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: 'msg_1',
      controlId: 'sys.memory.delete',
      controlTitle: 'Delete Memory',
      riskLevel: 'confirm',
      lane: 'api',
      input: { memory_id: 'mem_1' }
    })

    expect(isWellFormedApprovalId(record.id)).toBe(true)
    expect(record.status).toBe('pending')
    expect(record.inputHash).toBe(hashControlInput({ memory_id: 'mem_1' }))

    const stored = await getControlApproval(record.id)
    expect(stored?.messageId).toBe('msg_1')
    expect(stored?.lane).toBe('api')

    const members = await redis.execute(async (client) =>
      client.zRange(controlApprovalsIndexKey(SESSION), 0, -1)
    )
    expect(members).toEqual([record.id])

    // A TTL is not an excuse to skip `deleteSession`, but it IS the backstop for an
    // abandoned card, so it has to actually be set — on the record AND on the index.
    const recordTtl = await redis.ttl(controlApprovalKey(record.id))
    const indexTtl = await redis.ttl(controlApprovalsIndexKey(SESSION))
    expect(recordTtl).toBeGreaterThan(CONTROL_APPROVAL_TTL_SECONDS - 60)
    expect(indexTtl).toBeGreaterThan(CONTROL_APPROVAL_TTL_SECONDS - 60)
  })

  it('never turns a malformed id into a key — it does not touch Redis at all', async () => {
    // Saved and restored by hand: `vi.restoreAllMocks` does not put back a spy on
    // `redis.json.get` here (the wrapper object is a module-level singleton shared by every
    // test in the file), and a leaked spy makes every later test read `undefined`.
    const originalGet = redis.json.get
    let keyReads = 0
    redis.json.get = (async (...args: any[]) => {
      keyReads += 1
      return await (originalGet as any)(...args)
    }) as any

    const malformed = [
      `s:${SESSION}`,
      'apr_*',
      'control_approvals:session-direct',
      'apr_' + 'x'.repeat(200),
      'apr_ok\nsomething-else'
    ]

    try {
      for (const id of malformed) {
        await expect(getControlApproval(id)).resolves.toBeNull()
        await expect(decideApproval({ userId: USER, approvalId: id, approved: true }))
          .resolves.toBeNull()
        await expect(markApprovalExpired(id)).resolves.toBe(false)
        await expect(consumeApproval(id)).resolves.toBeNull()
      }
    } finally {
      redis.json.get = originalGet
    }

    // The guard's actual job: a malformed id answers "no such approval" without ever
    // becoming a key. A wildcard, a newline, or a 200-character string must not reach a key
    // name or a log line built from one, and a typo must be a clean null rather than a
    // Redis error escaping as a 500.
    expect(keyReads).toBe(0)
  })

  it('creates once per approval id — a second create with the same id changes nothing', async () => {
    // AMD-116-01: the SDK re-asks the per-tool policy on the approval resume, so anything
    // that wrote from a lane reached twice must be idempotent or the card doubles.
    const first = await createPendingApproval({
      approvalId: 'apr_fixed-id',
      userId: USER,
      sessionId: SESSION,
      controlId: 'sys.memory.delete',
      controlTitle: 'Delete Memory',
      riskLevel: 'confirm',
      lane: 'api',
      input: { memory_id: 'mem_1' },
      now: new Date('2026-09-09T10:00:00.000Z')
    })
    await decideApproval({ userId: USER, approvalId: first.id, approved: true })

    const second = await createPendingApproval({
      approvalId: 'apr_fixed-id',
      userId: USER,
      sessionId: SESSION,
      controlId: 'sys.memory.delete',
      controlTitle: 'Delete Memory',
      riskLevel: 'confirm',
      lane: 'api',
      input: { memory_id: 'mem_1' },
      now: new Date('2026-09-09T11:00:00.000Z')
    })

    expect(second.requestedAt).toBe(first.requestedAt)
    // The decision survives: a re-create must never reset an answered card back to pending.
    expect(second.status).toBe('approved')
    const members = await redis.execute(async (client) =>
      client.zRange(controlApprovalsIndexKey(SESSION), 0, -1)
    )
    expect(members).toEqual(['apr_fixed-id'])
  })

  it('F-P1-4: keeps the SDK approval id and the tool call id on the record', async () => {
    // The AI SDK mints ids like `aitxt-…`, which `APPROVAL_ID_PATTERN` rightly rejects: an
    // approval RECORD id is ours. So the API lane keeps both, and the mapping is server
    // state. Before P2 both fields were accepted by this function and silently dropped.
    const record = await createPendingApproval({
      approvalId: 'apr_sdk-mapped',
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: 'msg_1',
      controlId: 'sys.memory.delete',
      controlTitle: 'Delete Memory',
      riskLevel: 'confirm',
      lane: 'api',
      input: { memory_id: 'mem_1' },
      sdkApprovalId: 'aitxt-abc123',
      toolCallId: 'toolu_013Y'
    })

    expect(record.sdkApprovalId).toBe('aitxt-abc123')
    expect(record.toolCallId).toBe('toolu_013Y')
    const stored = await getControlApproval('apr_sdk-mapped')
    expect(stored?.sdkApprovalId).toBe('aitxt-abc123')
    expect(stored?.toolCallId).toBe('toolu_013Y')
  })

  it('F-P1-4: two concurrent creates with one id produce one record, not two', async () => {
    // P2 reaches the supplied-id path more than once per call, and read-then-create without
    // the lock is a compare-and-set with a gap in the middle: both creates see no record,
    // both write, and the second root write resets the first one's clock — and its status,
    // even if a click landed in between.
    const [first, second] = await Promise.all([
      createPendingApproval({
        approvalId: 'apr_raced',
        userId: USER,
        sessionId: SESSION,
        controlId: 'sys.memory.delete',
        controlTitle: 'Delete Memory',
        riskLevel: 'confirm',
        lane: 'api',
        input: { memory_id: 'mem_1' },
        now: new Date('2026-09-10T10:00:00.000Z')
      }),
      createPendingApproval({
        approvalId: 'apr_raced',
        userId: USER,
        sessionId: SESSION,
        controlId: 'sys.memory.delete',
        controlTitle: 'Delete Memory',
        riskLevel: 'confirm',
        lane: 'api',
        input: { memory_id: 'mem_1' },
        now: new Date('2026-09-10T10:00:05.000Z')
      })
    ])

    expect(first.requestedAt).toBe(second.requestedAt)
    const members = await redis.execute(async (client) =>
      client.zRange(controlApprovalsIndexKey(SESSION), 0, -1)
    )
    expect(members).toEqual(['apr_raced'])
  })

  it('writes status by path, so a swept approval stays gone instead of resurrecting', async () => {
    const record = await createPendingApproval({
      userId: USER,
      sessionId: SESSION,
      controlId: 'sys.memory.delete',
      controlTitle: 'Delete Memory',
      riskLevel: 'confirm',
      lane: 'api',
      input: {}
    })

    // The race this guards: the chat is deleted (or the 24-hour expiry fires) between the
    // read that finds the record and the write that decides it. A read-before-write check
    // alone cannot see that window — it has to be opened deliberately, or a whole-record
    // write passes this test while still resurrecting the key in production.
    const stored = await getControlApproval(record.id)
    // Saved and restored by hand, for the same reason as the id-guard test above.
    const originalGet = redis.json.get
    let opened = false
    redis.json.get = (async (key: string) => {
      if (key !== controlApprovalKey(record.id)) return null
      if (!opened) {
        opened = true
        await redis.del(key)
      }
      return stored
    }) as any

    try {
      await expect(decideApproval({ userId: USER, approvalId: record.id, approved: true }))
        .resolves.toBeNull()
    } finally {
      redis.json.get = originalGet
    }
    // `JSON.SET key $ record` CREATES a missing key, so a root write here would put the
    // record back — approved, with a fresh 24-hour clock, in a chat that no longer exists.
    await expect(getControlApproval(record.id)).resolves.toBeNull()
  })

})

describe('deciding an approval', () => {
  async function pending(overrides: Record<string, any> = {}) {
    return await createPendingApproval({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      controlId: 'sys.memory.delete',
      controlTitle: 'Delete Memory',
      riskLevel: 'confirm',
      lane: 'api',
      input: { memory_id: 'mem_1' },
      ...overrides
    })
  }

  it('refuses a record belonging to another user', async () => {
    const record = await pending()
    await expect(
      decideApproval({ userId: OTHER_USER, approvalId: record.id, approved: true })
    ).resolves.toBeNull()
    expect((await getControlApproval(record.id))?.status).toBe('pending')
  })

  it('keeps the first answer — a replayed click cannot turn a denial into an approval', async () => {
    const record = await pending()
    await decideApproval({ userId: USER, approvalId: record.id, approved: false })
    const replayed = await decideApproval({ userId: USER, approvalId: record.id, approved: true })
    expect(replayed?.status).toBe('denied')
    expect((await getControlApproval(record.id))?.status).toBe('denied')
  })

  it('seeds the scoped window only for a record that carries a scope key', async () => {
    const scoped = await pending({
      controlId: 'sys.voice.engine.complete_local_setup',
      controlTitle: 'Complete Local Setup',
      scopeKey: 'engine:demo'
    })
    await decideApproval({ userId: USER, approvalId: scoped.id, approved: true })
    await expect(
      hasScopedRiskWindow({
        userId: USER,
        agentId: AGENT,
        controlId: 'sys.voice.engine.complete_local_setup',
        scopeKey: 'engine:demo'
      })
    ).resolves.toBe(true)
    // A different engine is a different action and gets its own card.
    await expect(
      hasScopedRiskWindow({
        userId: USER,
        agentId: AGENT,
        controlId: 'sys.voice.engine.complete_local_setup',
        scopeKey: 'engine:other'
      })
    ).resolves.toBe(false)

    const unscoped = await pending()
    await decideApproval({ userId: USER, approvalId: unscoped.id, approved: true })
    // DL-116-04: approving "delete memory X" must not unlock anything at all afterwards.
    await expect(
      hasScopedRiskWindow({
        userId: USER,
        agentId: AGENT,
        controlId: 'sys.memory.delete',
        scopeKey: 'engine:demo'
      })
    ).resolves.toBe(false)
  })

  it('a denial seeds no window', async () => {
    const scoped = await pending({
      controlId: 'sys.voice.engine.complete_local_setup',
      scopeKey: 'engine:demo'
    })
    await decideApproval({ userId: USER, approvalId: scoped.id, approved: false })
    await expect(
      hasScopedRiskWindow({
        userId: USER,
        agentId: AGENT,
        controlId: 'sys.voice.engine.complete_local_setup',
        scopeKey: 'engine:demo'
      })
    ).resolves.toBe(false)
  })
})

describe('matching and consuming', () => {
  async function approved(overrides: Record<string, any> = {}) {
    const record = await createPendingApproval({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      controlId: 'sys.memory.delete',
      controlTitle: 'Delete Memory',
      riskLevel: 'confirm',
      lane: 'api',
      input: { memory_id: 'mem_1' },
      ...overrides
    })
    await decideApproval({ userId: USER, approvalId: record.id, approved: true })
    return record
  }

  const criteria = (overrides: Record<string, any> = {}) => ({
    userId: USER,
    agentId: AGENT,
    sessionId: SESSION,
    controlId: 'sys.memory.delete',
    inputHash: hashControlInput({ memory_id: 'mem_1' }),
    ...overrides
  })

  it('matches on every field that makes a call the same call', async () => {
    const record = await approved()
    expect((await findApprovedMatch(criteria()))?.id).toBe(record.id)

    // "Approve deleting memory X" must never unlock "delete memory Y" — the whole reason
    // the blanket five-minute window went away.
    await expect(
      findApprovedMatch(criteria({ inputHash: hashControlInput({ memory_id: 'mem_2' }) }))
    ).resolves.toBeNull()
    await expect(findApprovedMatch(criteria({ controlId: 'sys.skill.import' }))).resolves.toBeNull()
    await expect(findApprovedMatch(criteria({ agentId: 'agent-faye' }))).resolves.toBeNull()
    await expect(findApprovedMatch(criteria({ userId: OTHER_USER }))).resolves.toBeNull()
    await expect(findApprovedMatch(criteria({ sessionId: 'session-elsewhere' }))).resolves.toBeNull()
  })

  it('ignores key order, because re-emitted arguments are the same call', async () => {
    await approved({ input: { alpha: 1, beta: 2 } })
    const reordered = await findApprovedMatch(
      criteria({ inputHash: hashControlInput({ beta: 2, alpha: 1 }) })
    )
    expect(reordered).not.toBeNull()
  })

  it('is spent exactly once, even by two callers at the same moment', async () => {
    const record = await approved()
    const [first, second] = await Promise.all([
      consumeApproval(record.id),
      consumeApproval(record.id)
    ])
    const winners = [first, second].filter(Boolean)
    expect(winners).toHaveLength(1)
    expect((await getControlApproval(record.id))?.status).toBe('consumed')
    // And a consumed record is no longer a match, so the next retry earns a fresh card.
    await expect(findApprovedMatch(criteria())).resolves.toBeNull()
  })

  it('a pending or denied record is never a match', async () => {
    await createPendingApproval({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      controlId: 'sys.memory.delete',
      controlTitle: 'Delete Memory',
      riskLevel: 'confirm',
      lane: 'api',
      input: { memory_id: 'mem_1' }
    })
    await expect(findApprovedMatch(criteria())).resolves.toBeNull()

    const denied = await createPendingApproval({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      controlId: 'sys.memory.delete',
      controlTitle: 'Delete Memory',
      riskLevel: 'confirm',
      lane: 'api',
      input: { memory_id: 'mem_1' }
    })
    await decideApproval({ userId: USER, approvalId: denied.id, approved: false })
    await expect(findApprovedMatch(criteria())).resolves.toBeNull()
    await expect(consumeApproval(denied.id)).resolves.toBeNull()
  })
})

describe('the input summary', () => {
  it('keeps keys and short values, and truncates long ones with their real length', () => {
    const summary = summarizeControlInput({
      url: 'https://example.com/skill.zip',
      enabled: true,
      count: 3,
      body: 'x'.repeat(900),
      items: [1, 2, 3],
      nested: { b: 1, a: 2 }
    })
    expect(summary.url).toBe('https://example.com/skill.zip')
    expect(summary.enabled).toBe(true)
    expect(summary.count).toBe(3)
    expect(summary.body).toContain('(900 characters)')
    expect(summary.items).toBe('[3 items]')
    expect(summary.nested).toBe('{a, b}')
  })

  it('stays under 2 KB even for an input the card could never show', () => {
    const huge: Record<string, string> = {}
    for (let index = 0; index < 200; index += 1) huge[`field_${index}`] = 'y'.repeat(300)
    const summary = summarizeControlInput(huge)
    // The card is persisted on the message and shipped in a 403 body; an artifact's whole
    // HTML document must not ride along.
    expect(JSON.stringify(summary).length).toBeLessThan(2600)
    expect(summary['…']).toBe('more fields not shown')
  })
})

describe('sweeping a session', () => {
  it('DL-116-12: the history reader skips a record belonging to another user', async () => {
    // Defence in depth, and it needs its own test: the route already refuses a session the
    // caller does not own, so a mutation of THIS check survives a route-level test. The
    // index is keyed on the session alone, so the record's own `userId` is the only thing
    // standing between a session that changed hands and someone else's approval history.
    await createPendingApproval({
      userId: USER,
      sessionId: SESSION,
      messageId: 'msg_mine',
      controlId: 'sys.memory.delete',
      controlTitle: 'Memory Delete',
      riskLevel: 'confirm',
      lane: 'api',
      input: { memoryId: 'mem_1' }
    })
    await createPendingApproval({
      userId: OTHER_USER,
      sessionId: SESSION,
      messageId: 'msg_theirs',
      controlId: 'sys.skill.import',
      controlTitle: 'Skill Import',
      riskLevel: 'restricted',
      lane: 'api',
      input: { source: 'https://example.test' }
    })

    const rows = await listSessionApprovals(SESSION, USER)
    expect(rows.map((row) => row.messageId)).toEqual(['msg_mine'])
  })

  it('deletes every approval raised in the chat, plus the index', async () => {
    const first = await createPendingApproval({
      userId: USER,
      sessionId: SESSION,
      controlId: 'sys.memory.delete',
      controlTitle: 'Delete Memory',
      riskLevel: 'confirm',
      lane: 'api',
      input: { memory_id: 'mem_1' }
    })
    const second = await createPendingApproval({
      userId: USER,
      sessionId: SESSION,
      controlId: 'sys.skill.import',
      controlTitle: 'Import Skill',
      riskLevel: 'restricted',
      lane: 'cli',
      input: { url: 'https://example.com' }
    })
    const elsewhere = await createPendingApproval({
      userId: USER,
      sessionId: 'session-other',
      controlId: 'sys.memory.delete',
      controlTitle: 'Delete Memory',
      riskLevel: 'confirm',
      lane: 'api',
      input: {}
    })

    await expect(sweepSessionApprovals(SESSION)).resolves.toBe(2)
    await expect(getControlApproval(first.id)).resolves.toBeNull()
    await expect(getControlApproval(second.id)).resolves.toBeNull()
    const members = await redis.execute(async (client) =>
      client.zRange(controlApprovalsIndexKey(SESSION), 0, -1)
    )
    expect(members).toEqual([])
    // Another chat's consent is untouched.
    await expect(getControlApproval(elsewhere.id)).resolves.not.toBeNull()
  })

  // The in-memory fake has no `deleteSession`, so the wiring itself can only be proved on
  // the real lane — the same reason `groupAgentCleanup.test.ts` is real-lane only. The
  // sweep's own behaviour is covered by the test above on both lanes.
  it.runIf(REAL_REDIS_LANE)('runs from deleteSession, so an approval cannot outlive its chat', async () => {
    const record = await createPendingApproval({
      userId: USER,
      sessionId: SESSION,
      controlId: 'sys.memory.delete',
      controlTitle: 'Delete Memory',
      riskLevel: 'confirm',
      lane: 'api',
      input: {}
    })
    await redis.deleteSession(SESSION)
    await expect(getControlApproval(record.id)).resolves.toBeNull()
    const members = await redis.execute(async (client) =>
      client.zRange(controlApprovalsIndexKey(SESSION), 0, -1)
    )
    expect(members).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * The gate (DL-116-03)
 * ------------------------------------------------------------------ */

describe('decideRiskGate', () => {
  it('pauses a risky control nobody approved, and records what the card needs', async () => {
    const decision = await decideRiskGate(gateInput())
    expect(decision.kind).toBe('pause')
    if (decision.kind !== 'pause') return
    expect(decision.request.controlTitle).toBe('Delete Memory')
    expect(decision.request.riskLevel).toBe('confirm')
    expect(decision.request.inputSummary).toEqual({ memory_id: 'mem_1' })
    const stored = await getControlApproval(decision.request.approvalId)
    expect(stored?.status).toBe('pending')
  })

  it('F-P2-4: the pause carries the EXACT input, not only the summary the record keeps', async () => {
    // A 300-character URL is the shape that made this matter: `inputSummary` cuts a value
    // at 240 characters, so a user approving `sys.skill.import` was shown a truncated
    // source as if it were the thing that would run.
    const longUrl = `https://example.com/skills/${'a'.repeat(300)}.zip`
    const decision = await decideRiskGate(
      gateInput({
        controlId: 'sys.skill.import',
        controlTitle: 'Skill Import',
        input: { source: longUrl }
      })
    )
    expect(decision.kind).toBe('pause')
    if (decision.kind !== 'pause') return

    expect(decision.request.input).toEqual({ source: longUrl })
    expect(decision.request.input?.source).toHaveLength(longUrl.length)
    // The record itself stays small — the summary is still the truncated audit view.
    expect(String(decision.request.inputSummary.source).length).toBeLessThan(longUrl.length)
    const stored = await getControlApproval(decision.request.approvalId)
    expect(stored?.inputSummary).toEqual(decision.request.inputSummary)
    expect((stored as any)?.input).toBeUndefined()
  })

  it('F-P2-4: an empty input is still an object on the block, so the card shows "Exact input"', async () => {
    const decision = await decideRiskGate(gateInput({ input: {} }))
    expect(decision.kind).toBe('pause')
    if (decision.kind !== 'pause') return
    expect(decision.request.input).toEqual({})
  })

  it('a Portable Skill Token runs without a record — its family scope is the consent', async () => {
    const decision = await decideRiskGate(gateInput({ portableSkillScope: true, sessionId: null }))
    expect(decision.kind).toBe('run')
    if (decision.kind !== 'run') return
    expect(decision.approval?.kind).toBe('portable-skill-scope')
    // Nothing was written that a later, non-portable call could read as consent.
    await expect(findApprovedMatch({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      controlId: 'sys.memory.delete',
      inputHash: hashControlInput({ memory_id: 'mem_1' })
    })).resolves.toBeNull()
  })

  it('refuses in a group chat instead of raising a card nobody can answer', async () => {
    const decision = await decideRiskGate(gateInput({ sessionId: GROUP_SESSION }))
    expect(decision.kind).toBe('refuse-group')
    if (decision.kind !== 'refuse-group') return
    expect(decision.message).toBe(GROUP_RISK_REFUSAL_MESSAGE)
    const members = await redis.execute(async (client) =>
      client.zRange(controlApprovalsIndexKey(GROUP_SESSION), 0, -1)
    )
    expect(members).toEqual([])
  })

  it('pauses rather than claiming "group chat" when the session cannot be read', async () => {
    vi.spyOn(redis, 'getSession').mockRejectedValue(new Error('redis is down'))
    const decision = await decideRiskGate(gateInput())
    // Both answers stop the control; only one of them is a sentence the server can stand
    // behind for a user sitting in a direct chat.
    expect(decision.kind).toBe('pause')
  })

  it('runs and spends the approval a click made, then pauses again on the next try', async () => {
    const first = await decideRiskGate(gateInput())
    if (first.kind !== 'pause') throw new Error('expected a pause')
    await decideApproval({ userId: USER, approvalId: first.request.approvalId, approved: true })

    const run = await decideRiskGate(
      gateInput({ grant: { kind: 'sdk', approvalId: first.request.approvalId } })
    )
    expect(run.kind).toBe('run')
    if (run.kind !== 'run') return
    expect(run.approval?.approvalId).toBe(first.request.approvalId)
    expect(run.approval?.kind).toBe('sdk')

    // Consume-once: the same grant a second time is a fresh card, not a second run.
    const replay = await decideRiskGate(
      gateInput({ grant: { kind: 'sdk', approvalId: first.request.approvalId } })
    )
    expect(replay.kind).toBe('pause')
    if (replay.kind !== 'pause') return
    expect(replay.request.approvalId).not.toBe(first.request.approvalId)
  })

  it('finds the approval without a grant id, for the managed CLI retry', async () => {
    const first = await decideRiskGate(gateInput())
    if (first.kind !== 'pause') throw new Error('expected a pause')
    await decideApproval({ userId: USER, approvalId: first.request.approvalId, approved: true })

    // DL-116-08: after its resume turn the agent knows the ref and the input, not the id.
    const run = await decideRiskGate(gateInput())
    expect(run.kind).toBe('run')
    if (run.kind !== 'run') return
    expect(run.approval?.approvalId).toBe(first.request.approvalId)
  })

  it('a changed payload gets a new card rather than silently widening the old one', async () => {
    const first = await decideRiskGate(gateInput())
    if (first.kind !== 'pause') throw new Error('expected a pause')
    await decideApproval({ userId: USER, approvalId: first.request.approvalId, approved: true })

    const changed = await decideRiskGate(
      gateInput({
        input: { memory_id: 'mem_SOMETHING_ELSE' },
        grant: { kind: 'sdk', approvalId: first.request.approvalId }
      })
    )
    expect(changed.kind).toBe('pause')
    if (changed.kind !== 'pause') return
    expect(changed.request.approvalId).not.toBe(first.request.approvalId)
    // The click the user really made is still theirs to spend on the call they saw.
    expect((await getControlApproval(first.request.approvalId))?.status).toBe('approved')
  })

  it('a denied approval never runs the control', async () => {
    const first = await decideRiskGate(gateInput())
    if (first.kind !== 'pause') throw new Error('expected a pause')
    await decideApproval({ userId: USER, approvalId: first.request.approvalId, approved: false })

    const retry = await decideRiskGate(
      gateInput({ grant: { kind: 'sdk', approvalId: first.request.approvalId } })
    )
    expect(retry.kind).toBe('pause')
  })

  it('rides a click-seeded scoped window, and only for that exact scope', async () => {
    const voice = gateInput({
      controlId: 'sys.voice.engine.complete_local_setup',
      controlTitle: 'Complete Local Setup',
      input: { engineId: 'demo' },
      scopeKey: 'engine:demo'
    })
    const first = await decideRiskGate(voice)
    if (first.kind !== 'pause') throw new Error('expected a pause')
    await decideApproval({ userId: USER, approvalId: first.request.approvalId, approved: true })

    // The install fails partway and the helper retries the same engine: one action to the
    // user, so it must not ask twice.
    const retry = await decideRiskGate({ ...voice, input: { engineId: 'demo', attempt: 2 } })
    expect(retry.kind).toBe('run')
    if (retry.kind !== 'run') return
    expect(retry.approval?.kind).toBe('scoped-window')

    const otherEngine = await decideRiskGate({
      ...voice,
      input: { engineId: 'other' },
      scopeKey: 'engine:other'
    })
    expect(otherEngine.kind).toBe('pause')
  })
})

/* ------------------------------------------------------------------ *
 * SA-113 F-SEC-1, kept (DL-116-03 step 2)
 * ------------------------------------------------------------------ */

describe('a woken turn', () => {
  it('pauses for the same card instead of being refused outright', async () => {
    setTurnMessages([wokenUserMessage('dm_stuck')])
    const decision = await decideRiskGate(gateInput())
    expect(decision.kind).toBe('pause')
    if (decision.kind !== 'pause') return
    expect(decision.wokenDmId).toBe('dm_stuck')
    // F-SEC-1b, kept: the user is told their woken chat is parked on them.
    expect(stampDmNeedsUser).toHaveBeenCalledWith(
      'dm_stuck',
      'This chat is waiting for you to approve Delete Memory.'
    )
  })

  it('never rides a click-seeded window, however recent the click was', async () => {
    const voice = gateInput({
      controlId: 'sys.voice.engine.complete_local_setup',
      controlTitle: 'Complete Local Setup',
      input: { engineId: 'demo' },
      scopeKey: 'engine:demo'
    })
    // The user approves in an ordinary chat...
    const first = await decideRiskGate(voice)
    if (first.kind !== 'pause') throw new Error('expected a pause')
    await decideApproval({ userId: USER, approvalId: first.request.approvalId, approved: true })
    await expect(
      hasScopedRiskWindow({
        userId: USER,
        agentId: AGENT,
        controlId: 'sys.voice.engine.complete_local_setup',
        scopeKey: 'engine:demo'
      })
    ).resolves.toBe(true)

    // ...and three minutes later a DM wakes the same agent in the same chat and retries.
    // The retry carries different input on purpose: an identical retry would match the
    // approved RECORD, which is a real click and is allowed to run (see the last test in
    // this block). Only the WINDOW is under test here, and a woken turn never rides it.
    setTurnMessages([wokenUserMessage('dm_stuck')])
    const woken = await decideRiskGate({ ...voice, input: { engineId: 'demo', attempt: 2 } })
    expect(woken.kind).toBe('pause')
  })

  it('pauses when the session cannot be read, because unreadable means woken', async () => {
    setTurnMessages(new Error('redis is down'))
    const voice = gateInput({
      controlId: 'sys.voice.engine.complete_local_setup',
      input: { engineId: 'demo' },
      scopeKey: 'engine:demo'
    })
    const first = await decideRiskGate({ ...voice })
    if (first.kind !== 'pause') throw new Error('expected a pause')
    // Seed the window from a real click, then prove the unreadable turn still cannot use it.
    setTurnMessages([typedUserMessage])
    await decideApproval({ userId: USER, approvalId: first.request.approvalId, approved: true })
    setTurnMessages(new Error('redis is down'))
    const retry = await decideRiskGate({ ...voice, input: { engineId: 'demo', attempt: 2 } })
    expect(retry.kind).toBe('pause')
  })

  it('still spends an approval the user really clicked, which is how the card works', async () => {
    // DL-116-03 keeps the approval match BEFORE the woken check on purpose: the record was
    // created by a cookie-authenticated click, so it IS a human — that is the whole point of
    // letting a woken chat show a card at all.
    const first = await decideRiskGate(gateInput())
    if (first.kind !== 'pause') throw new Error('expected a pause')
    await decideApproval({ userId: USER, approvalId: first.request.approvalId, approved: true })

    setTurnMessages([wokenUserMessage('dm_stuck')])
    const run = await decideRiskGate(
      gateInput({ grant: { kind: 'resume', approvalId: first.request.approvalId } })
    )
    expect(run.kind).toBe('run')
  })
})
