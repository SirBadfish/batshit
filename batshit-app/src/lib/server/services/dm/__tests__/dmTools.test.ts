import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  __resetWakeRunRegistryForTests,
  registerWakeRun
} from '$lib/server/services/wakeRunRegistry'
import {
  clearSessionTurn,
  clearStreamAbort,
  registerSessionTurn,
  registerStreamAbort
} from '$lib/server/services/streamAbortRegistry'
import {
  __resetSteerInboxRegistryForTests,
  listPendingSteers,
  registerSteerRun,
  takeMissedDmSteers
} from '$lib/server/services/steerInboxRegistry'
import { STEER_MISSED_REASON } from '$lib/utils/dmControl'
import {
  __resetDmLocksForTests,
  createDm,
  degradeMissedDmSteers,
  getDm,
  listInbox,
  reopenDm,
  stampDmNeedsUser
} from '../dmStore'
import { createSchedule } from '$lib/server/services/schedules/scheduleStore'
import {
  buildWokenDmContent,
  claimDmOp,
  deliverScheduledDm,
  closeDmOp,
  listDmAgentsOp,
  listDmsOp,
  readDmOp,
  requireDmEnabledAgent,
  resolveSessionChainDepth,
  sendDmOp
} from '../dmTools'
import type { DmRecord } from '$lib/types/dm'

/**
 * SA-113 P2 (DL-113-03, DL-113-11, DL-113-16) — the `sys.dm.*` operations.
 *
 * `fetch` is stubbed, so a `wake` send exercises the real wake primitive without starting
 * a turn; the assertion is on what the DM records and what the sender is told.
 */

useRedisTestServer()

const USER = 'user-dm-tools'
const COOPER = 'agent-cooper'
const FAYE = 'agent-faye'
const OPIE = 'agent-opie'

const fetchCalls: { url: string; init: any }[] = []

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: any) => {
      fetchCalls.push({ url: String(input), init })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    })
  )
}

async function seedAgent(id: string, overrides: Record<string, any> = {}) {
  const agent = {
    id,
    user_id: USER,
    displayName: id.replace('agent-', '').replace(/^./, (c) => c.toUpperCase()),
    agentType: 'api',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4-5',
    dms_enabled: true,
    ...overrides
  }
  await redis.createAgent(agent as any)
  return agent
}

/**
 * `sendDmOp` returns a union since F-P2-4 (`to: 'all'` broadcasts). Every test below sends
 * to ONE recipient, so this narrows once instead of at each assertion; the broadcast shape
 * has its own describe block.
 */
async function sendOne(
  context: ReturnType<typeof baseContext>,
  input: Parameters<typeof sendDmOp>[1]
) {
  const result = await sendDmOp(context, input)
  if ('broadcast' in result) throw new Error('expected a single-recipient send, got a broadcast')
  return result
}

function baseContext(agentId = FAYE, sessionId: string | null = 'sess-faye') {
  return { userId: USER, agentId, sessionId }
}

function assignmentInput(overrides: Record<string, any> = {}) {
  return {
    to: COOPER,
    kind: 'assignment' as const,
    subject: 'Verify the package',
    body: 'Run the audit and tell me what it says.',
    requested_outcome: 'A pass/fail plus the audit output.',
    scope: 'The packaged Mac app only.',
    report_back_to: FAYE,
    deliver: 'wait' as const,
    ...overrides
  }
}

const envRecord = env as Record<string, string | undefined>
let previousToken: string | undefined

beforeEach(async () => {
  fetchCalls.length = 0
  __resetDmLocksForTests()
  __resetWakeRunRegistryForTests()
  __resetSteerInboxRegistryForTests()
  previousToken = envRecord.BATSHIT_TOKEN
  envRecord.BATSHIT_TOKEN = 'test-service-token'
  stubFetch()
  await seedAgent(FAYE)
  await seedAgent(COOPER)
})

afterEach(() => {
  __resetWakeRunRegistryForTests()
  __resetSteerInboxRegistryForTests()
  if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
  else envRecord.BATSHIT_TOKEN = previousToken
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the enablement gate (DL-113-03)', () => {
  it('refuses an agent that does not have Agent DMs on', async () => {
    await redis.updateAgent(FAYE, { dms_enabled: false } as any)
    await expect(requireDmEnabledAgent(USER, FAYE)).rejects.toThrow(/not turned on/i)
  })

  it('refuses an agent owned by somebody else', async () => {
    await redis.updateAgent(FAYE, { user_id: 'someone-else' } as any)
    await expect(requireDmEnabledAgent(USER, FAYE)).rejects.toThrow(/does not belong/i)
  })

  it('refuses with no agent context at all', async () => {
    await expect(requireDmEnabledAgent(USER, '')).rejects.toThrow(/agent context/i)
  })
})

describe('sending (DL-113-03)', () => {
  it('sends a wait DM and returns a summary plus the recipient state', async () => {
    const result = await sendOne(baseContext(), {
      to: COOPER,
      kind: 'info',
      subject: 'Heads up',
      body: 'The audit script moved.',
      deliver: 'wait'
    })

    expect(result).toMatchObject({ delivered_as: 'wait', recipient_state: 'idle' })
    expect(result.expires_at).toBeTruthy()
    const record = await getDm(result.dm_id)
    expect(record).toMatchObject({ to: COOPER, from: { agentId: FAYE, name: 'Faye' } })
    // A wait send starts NO turn.
    expect(fetchCalls.filter((call) => call.url.includes('send-routed'))).toHaveLength(0)
  })

  it('refuses a recipient that does not exist, or is not a primary agent', async () => {
    await expect(
      sendDmOp(baseContext(), {
        to: 'nobody',
        kind: 'info',
        subject: 'x',
        body: 'y',
        deliver: 'wait'
      })
    ).rejects.toThrow(/was not found/i)

    await seedAgent('agent-group-ish', { agentType: 'n8n' })
    await expect(
      sendDmOp(baseContext(), {
        to: 'agent-group-ish',
        kind: 'info',
        subject: 'x',
        body: 'y',
        deliver: 'wait'
      })
    ).rejects.toThrow(/not an API or CLI primary/i)
  })

  it('refuses a recipient with Agent DMs off', async () => {
    await redis.updateAgent(COOPER, { dms_enabled: false } as any)
    await expect(
      sendDmOp(baseContext(), {
        to: COOPER,
        kind: 'info',
        subject: 'x',
        body: 'y',
        deliver: 'wait'
      })
    ).rejects.toThrow(/does not have Agent DMs turned on/i)
  })

  it("honours the recipient's sender allowlist", async () => {
    await redis.updateAgent(COOPER, {
      dm_senders: 'selected',
      dm_sender_agent_ids: [OPIE]
    } as any)
    await expect(
      sendDmOp(baseContext(), {
        to: COOPER,
        kind: 'info',
        subject: 'x',
        body: 'y',
        deliver: 'wait'
      })
    ).rejects.toThrow(/chosen list of agents/i)

    await redis.updateAgent(COOPER, { dm_sender_agent_ids: [FAYE] } as any)
    await expect(
      sendDmOp(baseContext(), {
        to: COOPER,
        kind: 'info',
        subject: 'now allowed',
        body: 'y',
        deliver: 'wait'
      })
    ).resolves.toMatchObject({ delivered_as: 'wait' })
  })

  it('accepts `steer` and degrades it to wait when nobody is mid-reply (DL-114-13)', async () => {
    // SA-113 reserved this mode and this test asserted it was refused. SA-114 P4 filled it
    // in: a steer with no reply to land in is not an error — the DM is written, the sender
    // is told what happened, and it waits in the inbox like any other note.
    const result = await sendDmOp(baseContext(), {
      to: COOPER,
      kind: 'info',
      subject: 'x',
      body: 'y',
      deliver: 'steer'
    })
    expect(result).toMatchObject({ delivered_as: 'wait' })
    expect((result as any).reason).toMatch(/not mid-reply/i)
    const record = await getDm((result as any).dm_id)
    expect(record?.delivery.requested).toBe('steer')
    expect(record?.delivery.actual).toBe('wait')
  })
})

describe('waking (DL-113-05 through the DM lane)', () => {
  it('creates a session, records the wake on the DM, and returns the session id', async () => {
    const result = await sendOne(baseContext(), assignmentInput({ deliver: 'wake' }))

    expect(result.delivered_as).toBe('wake')
    expect(result.session_id).toBeTruthy()
    const record = await getDm(result.dm_id)
    expect(record?.delivery).toMatchObject({
      requested: 'wake',
      actual: 'wake',
      sessionId: result.session_id
    })

    const messages = await redis.getMessages(result.session_id as string, 10)
    expect(messages[0].content).toContain('[Agent DM — from Faye, not from the user]')
    expect(messages[0].content).toContain('Requested outcome:')
    expect(messages[0].content).toContain(`DM id: ${result.dm_id}`)
  })

  it('degrades to wait with a reason when the recipient may not be woken', async () => {
    await redis.updateAgent(COOPER, { wake_enabled: false } as any)
    const result = await sendOne(baseContext(), assignmentInput({ deliver: 'wake' }))

    expect(result.delivered_as).toBe('wait')
    expect(result.reason).toMatch(/May be woken/i)
    expect((await getDm(result.dm_id))?.delivery).toMatchObject({
      requested: 'wake',
      actual: 'wait'
    })
    // Nothing is dropped: the DM is still in the inbox.
    expect(await listInbox(COOPER)).toHaveLength(1)
  })

  it('degrades to wait while the recipient already holds an assignment', async () => {
    const held = await createDm({
      userId: USER,
      from: { kind: 'agent', agentId: OPIE, name: 'Opie' },
      to: COOPER,
      kind: 'assignment',
      subject: 'Already working this',
      body: 'In progress.',
      requestedOutcome: 'x',
      scope: 'y',
      reportBackTo: OPIE,
      deliver: 'wait'
    })
    await claimDmOp({ userId: USER, agentId: COOPER, sessionId: 'sess-cooper' }, {
      dm_id: held.id
    })

    const result = await sendOne(baseContext(), assignmentInput({ deliver: 'wake' }))
    expect(result.delivered_as).toBe('wait')
    expect(result.reason).toMatch(/already working an assignment/i)
  })

  it('stops a wake chain at the locked depth', async () => {
    // The acting session's last user message says the chain is already three deep.
    await redis.createSession({
      id: 'sess-deep',
      user_id: USER,
      name: 'Deep',
      agent_id: FAYE,
      created_at: '2026-09-07T09:00:00.000Z',
      last_modified_at: '2026-09-07T09:00:00.000Z',
      metadata: {}
    } as any)
    await redis.saveMessage({
      id: 'msg-deep',
      session_id: 'sess-deep',
      user_id: USER,
      agent_id: FAYE,
      role: 'user',
      content: 'woken',
      created_at: '2026-09-07T09:00:00.000Z',
      metadata: { wake: { chainDepth: 3 } }
    } as any)

    const result = await sendOne(baseContext(FAYE, 'sess-deep'), {
      to: COOPER,
      kind: 'info',
      subject: 'Too deep',
      body: 'This should not wake anybody.',
      deliver: 'wake'
    })
    expect(result.delivered_as).toBe('wait')
    expect(result.reason).toMatch(/chain is already 3 deep/i)
  })

  it('reads the chain depth from the server, never from input', async () => {
    expect(await resolveSessionChainDepth(null)).toBe(0)
    expect(await resolveSessionChainDepth('sess-missing')).toBe(0)
  })
})

describe('reading, claiming, and closing', () => {
  it('lists open items as summaries with no bodies', async () => {
    await createDm({
      userId: USER,
      from: { kind: 'agent', agentId: FAYE, name: 'Faye' },
      to: COOPER,
      kind: 'info',
      subject: 'A note',
      body: 'SECRET BODY TEXT',
      deliver: 'wait'
    })

    const listed = await listDmsOp({ userId: USER, agentId: COOPER, sessionId: null })
    expect(listed.total_open).toBe(1)
    expect(JSON.stringify(listed)).not.toContain('SECRET BODY TEXT')
  })

  it('returns the body only on read, and acknowledges an info item', async () => {
    const note = await createDm({
      userId: USER,
      from: { kind: 'agent', agentId: FAYE, name: 'Faye' },
      to: COOPER,
      kind: 'info',
      subject: 'A note',
      body: 'THE BODY',
      deliver: 'wait'
    })

    const read = await readDmOp({ userId: USER, agentId: COOPER, sessionId: null }, {
      dm_id: note.id
    })
    expect(read.dm.body).toBe('THE BODY')
    expect((await getDm(note.id))?.status).toBe('done')
  })

  it('refuses to read somebody else’s DM', async () => {
    const note = await createDm({
      userId: USER,
      from: { kind: 'agent', agentId: FAYE, name: 'Faye' },
      to: COOPER,
      kind: 'info',
      subject: 'For Cooper',
      body: 'x',
      deliver: 'wait'
    })
    await expect(
      readDmOp({ userId: USER, agentId: FAYE, sessionId: null }, { dm_id: note.id })
    ).rejects.toThrow(/not in your inbox/i)
  })

  it('closing an assignment creates and delivers its result in the same act', async () => {
    const sent = await sendOne(baseContext(), assignmentInput())
    await claimDmOp({ userId: USER, agentId: COOPER, sessionId: 'sess-cooper' }, {
      dm_id: sent.dm_id
    })

    const closed = await closeDmOp(
      { userId: USER, agentId: COOPER, sessionId: 'sess-cooper' },
      { dm_id: sent.dm_id, result: 'The audit passed with no findings.' },
      'done'
    )

    expect(closed.dm.status).toBe('done')
    expect(closed.result_dm_id).toBeTruthy()
    expect(closed.result_delivered_as).toBe('wait')

    // The result landed in the SENDER's inbox, pointing back at the assignment.
    const fayeInbox = await listInbox(FAYE)
    expect(fayeInbox).toHaveLength(1)
    expect(fayeInbox[0]).toMatchObject({
      kind: 'result',
      relatedDmId: sent.dm_id,
      body: 'The audit passed with no findings.'
    })
  })

  it('reports back on `blocked` too, so a stuck item is never silent', async () => {
    const sent = await sendOne(baseContext(), assignmentInput({ subject: 'Blocked job' }))
    await claimDmOp({ userId: USER, agentId: COOPER, sessionId: 'sess-cooper' }, {
      dm_id: sent.dm_id
    })
    const closed = await closeDmOp(
      { userId: USER, agentId: COOPER, sessionId: 'sess-cooper' },
      { dm_id: sent.dm_id, result: 'The signing key is missing.' },
      'blocked'
    )
    expect(closed.dm.status).toBe('blocked')
    expect((await listInbox(FAYE))[0]).toMatchObject({ kind: 'result' })
  })

  it('does not create a second result if the same item is closed twice', async () => {
    const sent = await sendOne(baseContext(), assignmentInput())
    await claimDmOp({ userId: USER, agentId: COOPER, sessionId: 'sess-cooper' }, {
      dm_id: sent.dm_id
    })
    await closeDmOp(
      { userId: USER, agentId: COOPER, sessionId: 'sess-cooper' },
      { dm_id: sent.dm_id, result: 'Done.' },
      'done'
    )
    await expect(
      closeDmOp(
        { userId: USER, agentId: COOPER, sessionId: 'sess-cooper' },
        { dm_id: sent.dm_id, result: 'Done again.' },
        'done'
      )
    ).rejects.toThrow(/already done/i)
    expect(await listInbox(FAYE)).toHaveLength(1)
  })
})

describe('presence (DL-113-16)', () => {
  it('lists DM-enabled primaries as idle when nothing is running', async () => {
    const { agents } = await listDmAgentsOp(baseContext())
    expect(agents.map((agent) => agent.id).sort()).toEqual([COOPER, FAYE].sort())
    expect(agents.every((agent) => agent.state === 'idle')).toBe(true)
    expect(agents.find((agent) => agent.id === COOPER)).toMatchObject({
      wake_enabled: true,
      working_style: 'new-session',
      open_dms: 0
    })
  })

  it('omits agents without Agent DMs turned on', async () => {
    await seedAgent(OPIE, { dms_enabled: false })
    const { agents } = await listDmAgentsOp(baseContext())
    expect(agents.map((agent) => agent.id)).not.toContain(OPIE)
  })

  it('reports an agent mid-turn as running, through its session', async () => {
    await redis.createSession({
      id: 'sess-cooper-live',
      user_id: USER,
      name: 'Cooper at work',
      agent_id: COOPER,
      created_at: '2026-09-07T09:00:00.000Z',
      last_modified_at: '2026-09-07T09:00:00.000Z',
      metadata: { agent_id: COOPER }
    } as any)
    registerSessionTurn('sess-cooper-live', 'single', 'msg-1')
    try {
      const { agents } = await listDmAgentsOp(baseContext())
      const cooper = agents.find((agent) => agent.id === COOPER)
      expect(cooper?.state).toBe('running')
      expect(cooper?.running_session_id).toBe('sess-cooper-live')
      expect(cooper?.running_since).toBeTruthy()
    } finally {
      clearSessionTurn('sess-cooper-live', 'msg-1')
    }
  })

  it('reports a woken turn as running even with no session-turn lock', async () => {
    registerWakeRun({
      sessionId: 'sess-woken',
      agentId: COOPER,
      userId: USER,
      origin: {
        kind: 'dm',
        label: 'Faye',
        at: new Date().toISOString(),
        chainDepth: 1
      } as never,
      startedAt: Date.now(),
      controller: new AbortController(),
      timer: setTimeout(() => {}, 60_000)
    })
    const { agents } = await listDmAgentsOp(baseContext())
    expect(agents.find((agent) => agent.id === COOPER)?.state).toBe('running')
  })

  it('F-SEC-1b: an open item stamped "needs you" reports waiting_approval, not idle', async () => {
    // The holdup outlives the turn that hit it. A woken turn that ended on a tool approval,
    // or that Batshit refused a risky control in, leaves the agent NOT running — so without
    // this the honest answer "it is stuck on a person" reads as `idle`, and the next agent
    // asking "who is free?" cheerfully hands Cooper more work.
    const dm = await createDm({
      userId: USER,
      from: { kind: 'agent', agentId: FAYE, name: 'Faye' },
      to: COOPER,
      kind: 'assignment',
      subject: 'Verify the package',
      body: 'Run the audit.',
      requestedOutcome: 'Pass or fail.',
      scope: 'The packaged Mac app only.',
      reportBackTo: FAYE,
      deliver: 'wake'
    })
    await stampDmNeedsUser(dm.id, 'This chat is waiting for you to approve a tool.')

    const { agents } = await listDmAgentsOp(baseContext())
    expect(agents.find((agent) => agent.id === COOPER)?.state).toBe('waiting_approval')
    // Nobody else is affected.
    expect(agents.find((agent) => agent.id === FAYE)?.state).toBe('idle')
  })

  it('every send result carries the recipient state', async () => {
    registerSessionTurn('sess-cooper-live', 'single', 'msg-1')
    await redis.createSession({
      id: 'sess-cooper-live',
      user_id: USER,
      name: 'Cooper at work',
      agent_id: COOPER,
      created_at: '2026-09-07T09:00:00.000Z',
      last_modified_at: '2026-09-07T09:00:00.000Z',
      metadata: { agent_id: COOPER }
    } as any)
    try {
      const result = await sendOne(baseContext(), {
        to: COOPER,
        kind: 'info',
        subject: 'While you work',
        body: 'No rush.',
        deliver: 'wait'
      })
      expect(result.recipient_state).toBe('running')
    } finally {
      clearSessionTurn('sess-cooper-live', 'msg-1')
    }
  })
})

describe('the woken first message (DL-113-04c)', () => {
  it('says plainly that it did not come from the user', () => {
    const record = {
      id: 'dm_1',
      kind: 'assignment',
      priority: 'urgent',
      from: { kind: 'agent', agentId: FAYE, name: 'Faye' },
      subject: 'Verify the package',
      body: 'Run the audit.',
      requestedOutcome: 'Pass or fail.',
      scope: 'Mac app only.',
      reportBackTo: FAYE
    } as unknown as DmRecord

    const content = buildWokenDmContent(record)
    expect(content.startsWith('[Agent DM — from Faye, not from the user] assignment, urgent —')).toBe(
      true
    )
    expect(content).toContain('Requested outcome: Pass or fail.')
    expect(content).toContain('Report back to: agent-faye')
    expect(content).toContain('DM id: dm_1')
  })

  it('names a webhook sender as a webhook', () => {
    const record = {
      id: 'dm_2',
      kind: 'info',
      priority: 'normal',
      from: { kind: 'webhook', hookId: 'hook_1', name: 'Nightly build' },
      subject: 'Build finished',
      body: 'Green.'
    } as unknown as DmRecord

    expect(buildWokenDmContent(record)).toContain(
      '[Wake-up webhook "Nightly build" — not from the user] info — Build finished'
    )
  })
})

/* ------------------------------------------------------------------ *
 * P3 — the four P2 review follow-ups
 * ------------------------------------------------------------------ */

describe('F-P2-1 — the readers take the RECENT end of a chat', () => {
  async function seedChat(sessionId: string, count: number, tail: Record<string, any>) {
    await redis.createSession({
      id: sessionId,
      user_id: USER,
      name: 'Long chat',
      agent_id: FAYE,
      created_at: '2026-09-07T09:00:00.000Z',
      last_modified_at: '2026-09-07T09:00:00.000Z',
      metadata: {}
    } as any)
    // `count` older messages first, then the one the readers actually care about.
    for (let index = 0; index < count; index += 1) {
      await redis.saveMessage({
        id: `msg-old-${index}`,
        session_id: sessionId,
        user_id: USER,
        agent_id: FAYE,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `old ${index}`,
        created_at: '2026-09-07T09:00:00.000Z',
        // The head of this chat is a deep wake AND a pending approval, so a head-first
        // reader gets a confidently wrong answer rather than an empty one.
        metadata:
          index % 2 === 0
            ? { wake: { chainDepth: 3 } }
            : { toolApprovals: [{ id: 'approval-old', status: 'pending' }] }
      } as any)
    }
    await redis.saveMessage({
      id: 'msg-tail',
      session_id: sessionId,
      user_id: USER,
      agent_id: FAYE,
      created_at: '2026-09-07T10:00:00.000Z',
      ...tail
    } as any)
  }

  it('resolves the chain depth past a 50-message window', async () => {
    await seedChat('sess-long-depth', 60, {
      role: 'user',
      content: 'a fresh typed turn',
      metadata: {}
    })
    // The user typed the latest turn, so the chain restarts at zero even though this chat
    // began with a depth-3 wake sixty messages ago.
    expect(await resolveSessionChainDepth('sess-long-depth')).toBe(0)
  })

  it('lets a wake through in a long chat whose OLD messages were deep', async () => {
    await seedChat('sess-long-wake', 60, {
      role: 'user',
      content: 'a fresh typed turn',
      metadata: {}
    })
    const result = await sendOne(baseContext(FAYE, 'sess-long-wake'), {
      to: COOPER,
      kind: 'info',
      subject: 'Not too deep after all',
      body: 'The chain restarted when the user typed.',
      deliver: 'wake'
    })
    expect(result.delivered_as).toBe('wake')
  })

  it('reports presence from the RECENT end, not the first five messages', async () => {
    await seedChat('sess-long-presence', 20, {
      role: 'assistant',
      content: 'all done',
      metadata: {}
    })
    registerSessionTurn('sess-long-presence', 'msg-live')
    try {
      const { agents } = await listDmAgentsOp(baseContext(COOPER, 'sess-cooper'))
      const faye = agents.find((agent) => agent.id === FAYE)
      // Head-first, the old pending approval at message two would report waiting_approval.
      expect(faye?.state).toBe('running')
    } finally {
      clearSessionTurn('sess-long-presence', 'msg-live')
    }
  })

  it('still sees a real pending approval on the latest assistant message', async () => {
    await seedChat('sess-long-approval', 20, {
      role: 'assistant',
      content: 'may I run this?',
      metadata: { toolApprovals: [{ id: 'approval-live', status: 'pending' }] }
    })
    registerSessionTurn('sess-long-approval', 'msg-live-2')
    try {
      const { agents } = await listDmAgentsOp(baseContext(COOPER, 'sess-cooper'))
      expect(agents.find((agent) => agent.id === FAYE)?.state).toBe('waiting_approval')
    } finally {
      clearSessionTurn('sess-long-approval', 'msg-live-2')
    }
  })
})

describe('F-P2-2 — report_back_to is validated at send time', () => {
  it('refuses an assignment whose report_back_to does not exist', async () => {
    await expect(
      sendDmOp(baseContext(), assignmentInput({ report_back_to: 'agent-typo' }))
    ).rejects.toThrow(/agent-typo.*not found.*report_back_to/is)
    // Nothing was written: the mistake fails before the recipient's inbox changes.
    expect(await listInbox(COOPER)).toHaveLength(0)
  })

  it('refuses an assignment whose report_back_to has DMs turned off', async () => {
    await seedAgent(OPIE, { dms_enabled: false })
    await expect(
      sendDmOp(baseContext(), assignmentInput({ report_back_to: OPIE }))
    ).rejects.toThrow(/does not have Agent DMs turned on \(report_back_to\)/i)
  })

  it('leaves info and result sends alone', async () => {
    const result = await sendOne(baseContext(), {
      to: COOPER,
      kind: 'info',
      subject: 'No report back needed',
      body: 'Just a note.',
      deliver: 'wait'
    })
    expect(result.delivered_as).toBe('wait')
  })
})

describe('F-P2-4 — an info broadcast to "all"', () => {
  it('writes one record per allowed recipient under one message id', async () => {
    await seedAgent(OPIE)
    const result = await sendDmOp(baseContext(), {
      to: 'all',
      kind: 'info',
      subject: 'Standup at ten',
      body: 'Bring your own coffee.',
      deliver: 'wait'
    })
    if (!('broadcast' in result)) throw new Error('expected a broadcast result')

    expect(result.delivered.map((entry) => entry.to).sort()).toEqual([COOPER, OPIE].sort())
    const records = await Promise.all(result.delivered.map((entry) => getDm(entry.dm_id)))
    // One note, one message id, one record each.
    expect(new Set(records.map((record) => record?.messageId))).toEqual(
      new Set([result.message_id])
    )
    // The sender never receives its own broadcast.
    expect(result.delivered.some((entry) => entry.to === FAYE)).toBe(false)
    expect(await listInbox(FAYE)).toHaveLength(0)
  })

  it('skips an agent that does not accept this sender, and says so', async () => {
    await seedAgent(OPIE, { dm_senders: 'selected', dm_sender_ids: [COOPER] })
    const result = await sendDmOp(baseContext(), {
      to: 'all',
      kind: 'info',
      subject: 'Only some of you',
      body: 'Opie has an allowlist.',
      deliver: 'wait'
    })
    if (!('broadcast' in result)) throw new Error('expected a broadcast result')

    expect(result.delivered.map((entry) => entry.to)).toEqual([COOPER])
    expect(result.skipped).toEqual([
      { to: OPIE, to_name: 'Opie', reason: expect.stringMatching(/chosen list/i) }
    ])
  })

  it('refuses an assignment or a result to everybody', async () => {
    await expect(
      sendDmOp(baseContext(), assignmentInput({ to: 'all' }))
    ).rejects.toThrow(/can only be an info note/i)
  })

  it('refuses to wake everybody', async () => {
    await expect(
      sendDmOp(baseContext(), {
        to: 'all',
        kind: 'info',
        subject: 'Wake up',
        body: 'Everybody at once.',
        deliver: 'wake'
      })
    ).rejects.toThrow(/cannot wake anybody/i)
  })

  it('fails loudly when there is nobody to broadcast to', async () => {
    await redis.updateAgent(COOPER, { dms_enabled: false } as any)
    await expect(
      sendDmOp(baseContext(), {
        to: 'all',
        kind: 'info',
        subject: 'Anybody there',
        body: 'Hello?',
        deliver: 'wait'
      })
    ).rejects.toThrow(/no other agent with Agent DMs turned on/i)
  })
})

/* ------------------------------------------------------------------ *
 * P3 — the webhook lane (DL-113-09)
 * ------------------------------------------------------------------ */

describe('a webhook-sent assignment fires its callback on close', () => {
  async function seedWebhookAssignment(callbackUrl?: string) {
    return createDm({
      userId: USER,
      from: { kind: 'webhook', hookId: 'whk_1', name: 'Nightly build' },
      to: COOPER,
      kind: 'assignment',
      subject: 'Check the build',
      body: 'Build 412 finished. Tell me if it is green.',
      requestedOutcome: 'Green or not, plus why.',
      scope: 'Only build 412.',
      deliver: 'wait',
      ...(callbackUrl ? { callbackUrl } : {})
    })
  }

  it('POSTs the result once and records the outcome on the DM', async () => {
    const dm = await seedWebhookAssignment('http://127.0.0.1:5678/webhook/result')
    await claimDmOp(baseContext(COOPER, 'sess-cooper'), { dm_id: dm.id })

    const result = await closeDmOp(
      baseContext(COOPER, 'sess-cooper'),
      { dm_id: dm.id, result: 'Green. 5,163 tests passed.' },
      'done'
    )

    expect(result.callback_status).toBe('delivered: 200')
    const callback = fetchCalls.find((call) => call.url.includes('/webhook/result'))
    expect(callback).toBeTruthy()
    expect(JSON.parse(callback!.init.body)).toMatchObject({
      dm_id: dm.id,
      status: 'done',
      result: 'Green. 5,163 tests passed.',
      agent: { id: COOPER, name: 'Cooper' }
    })
    expect((await getDm(dm.id))?.callbackStatus).toBe('delivered: 200')
  })

  it('creates no result DM, because a program has no inbox', async () => {
    const dm = await seedWebhookAssignment('http://127.0.0.1:5678/webhook/result')
    await claimDmOp(baseContext(COOPER, 'sess-cooper'), { dm_id: dm.id })
    const result = await closeDmOp(
      baseContext(COOPER, 'sess-cooper'),
      { dm_id: dm.id, result: 'Done.' },
      'done'
    )

    expect(result.result_dm_id).toBeUndefined()
    // And the closing agent did not DM itself, which is what a report_back_to pointing at
    // the recipient would have produced.
    expect(await listInbox(COOPER)).toHaveLength(0)
  })

  it('closes normally when the item has no callback', async () => {
    const dm = await seedWebhookAssignment()
    await claimDmOp(baseContext(COOPER, 'sess-cooper'), { dm_id: dm.id })
    const result = await closeDmOp(
      baseContext(COOPER, 'sess-cooper'),
      { dm_id: dm.id, result: 'Done.' },
      'done'
    )
    expect(result.callback_status).toBeUndefined()
    expect(fetchCalls.some((call) => call.url.includes('/webhook/'))).toBe(false)
  })

  it('still closes the item when the callback cannot be delivered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    const dm = await seedWebhookAssignment('http://127.0.0.1:5678/webhook/result')
    await claimDmOp(baseContext(COOPER, 'sess-cooper'), { dm_id: dm.id })

    const result = await closeDmOp(
      baseContext(COOPER, 'sess-cooper'),
      { dm_id: dm.id, result: 'Green.' },
      'done'
    )

    // The agent's work is done and its result is stored; the callback failing is reported,
    // never raised.
    expect(result.dm.status).toBe('done')
    expect(result.callback_status).toMatch(/^failed:/)
    const stored = await getDm(dm.id)
    expect(stored?.status).toBe('done')
    expect(stored?.result).toBe('Green.')
    expect(stored?.callbackStatus).toMatch(/^failed:/)
  })

  it('fires for blocked as well as done', async () => {
    const dm = await seedWebhookAssignment('http://127.0.0.1:5678/webhook/result')
    await claimDmOp(baseContext(COOPER, 'sess-cooper'), { dm_id: dm.id })
    const result = await closeDmOp(
      baseContext(COOPER, 'sess-cooper'),
      { dm_id: dm.id, result: 'The build log is missing.' },
      'blocked'
    )

    expect(result.callback_status).toBe('delivered: 200')
    const callback = fetchCalls.find((call) => call.url.includes('/webhook/result'))
    expect(JSON.parse(callback!.init.body).status).toBe('blocked')
  })
})

/* ------------------------------------------------------------------ *
 * P5 — F-P4-1: a reopened item reports again when it is closed again
 * ------------------------------------------------------------------ */

describe('F-P4-1 — Reopen clears the "already reported" markers', () => {
  it('sends a SECOND result DM when the agent closes a reopened assignment', async () => {
    const sent = await sendOne(baseContext(), assignmentInput())
    await claimDmOp(baseContext(COOPER, 'sess-cooper'), { dm_id: sent.dm_id })
    const first = await closeDmOp(
      baseContext(COOPER, 'sess-cooper'),
      { dm_id: sent.dm_id, result: 'Audit passed.' },
      'done'
    )
    expect(first.result_dm_id).toBeTruthy()
    expect(await listInbox(FAYE)).toHaveLength(1)

    // The user is not happy with that answer and reopens the item from the drawer.
    const reopened = await reopenDm(USER, sent.dm_id)
    expect(reopened.status).toBe('new')
    // The markers are gone, which is the whole fix: `reportBack` and `fireWakeCallback`
    // both return early while they are set.
    expect(reopened.resultDmId).toBeUndefined()
    expect(reopened.callbackStatus).toBeUndefined()

    await claimDmOp(baseContext(COOPER, 'sess-cooper'), { dm_id: sent.dm_id })
    const second = await closeDmOp(
      baseContext(COOPER, 'sess-cooper'),
      { dm_id: sent.dm_id, result: 'Audit re-run: still passing, with the log this time.' },
      'done'
    )

    expect(second.result_dm_id).toBeTruthy()
    expect(second.result_dm_id).not.toBe(first.result_dm_id)

    // The sender now holds BOTH results: the first stays as history, the redo arrives.
    const fayeInbox = await listInbox(FAYE)
    expect(fayeInbox).toHaveLength(2)
    expect(fayeInbox.map((dm) => dm.body)).toEqual(
      expect.arrayContaining([
        'Audit passed.',
        'Audit re-run: still passing, with the log this time.'
      ])
    )
  })

  it('fires the webhook callback a SECOND time after a reopen', async () => {
    const dm = await createDm({
      userId: USER,
      from: { kind: 'webhook', hookId: 'whk_reopen', name: 'Nightly build' },
      to: COOPER,
      kind: 'assignment',
      subject: 'Check the build',
      body: 'Build 412 finished.',
      requestedOutcome: 'Green or not.',
      scope: 'Only build 412.',
      deliver: 'wait',
      callbackUrl: 'http://127.0.0.1:5678/webhook/result'
    })

    await claimDmOp(baseContext(COOPER, 'sess-cooper'), { dm_id: dm.id })
    const first = await closeDmOp(
      baseContext(COOPER, 'sess-cooper'),
      { dm_id: dm.id, result: 'Green.' },
      'done'
    )
    expect(first.callback_status).toBe('delivered: 200')
    expect(fetchCalls.filter((call) => call.url.includes('/webhook/result'))).toHaveLength(1)

    await reopenDm(USER, dm.id)
    await claimDmOp(baseContext(COOPER, 'sess-cooper'), { dm_id: dm.id })
    const second = await closeDmOp(
      baseContext(COOPER, 'sess-cooper'),
      { dm_id: dm.id, result: 'Green, re-checked.' },
      'done'
    )

    expect(second.callback_status).toBe('delivered: 200')
    const callbacks = fetchCalls.filter((call) => call.url.includes('/webhook/result'))
    expect(callbacks).toHaveLength(2)
    expect(JSON.parse(callbacks[1].init.body).result).toBe('Green, re-checked.')
  })
})

/**
 * An assignment that expires unclaimed owes its sender a "nobody picked this up" result.
 *
 * It never arrived. The report was built with `from: record.from` — the ORIGINAL SENDER —
 * and `to: record.reportBackTo`, and `report_back_to` is almost always that same sender, so
 * `createDm`'s self-send guard threw every time. The throw was swallowed as a warning,
 * `resultDmId` was never linked, and every later `sys.dm.list` retried the same failing
 * write. The report is now sent FROM the inbox it expired in, as a real close would be.
 */
describe('an expired unclaimed assignment reports back', () => {
  it('sends the sender a result DM instead of silently retrying forever', async () => {
    await seedAgent(COOPER)
    await seedAgent(FAYE)

    const sent = await sendDmOp(baseContext(), assignmentInput({ expires_in_hours: 1 }))
    const dmId = (sent as any).dm_id ?? (sent as any).dm?.id
    expect(dmId).toBeTruthy()

    // Push it past its expiry without waiting an hour.
    const record = await getDm(dmId)
    await redis.json.set(
      `dm:${dmId}`,
      '$.expiresAt',
      new Date(Date.now() - 60_000).toISOString() as never
    )
    expect(record?.reportBackTo).toBe(FAYE)

    // Cooper lists his inbox; the reaper expires the item and the report goes out.
    await listDmsOp({ userId: USER, agentId: COOPER, sessionId: null })

    const fayeInbox = await listInbox(FAYE, { includeClosed: true })
    const report = fayeInbox.find((item) => item.kind === 'result' && item.relatedDmId === dmId)
    expect(report).toBeTruthy()
    expect(report?.from).toMatchObject({ kind: 'agent', agentId: COOPER })
    expect(report?.body).toMatch(/expired unclaimed/i)

    // Linked, so a second list does not send it again.
    expect((await getDm(dmId))?.resultDmId).toBe(report?.id)
    await listDmsOp({ userId: USER, agentId: COOPER, sessionId: null })
    expect(
      (await listInbox(FAYE, { includeClosed: true })).filter(
        (item) => item.kind === 'result' && item.relatedDmId === dmId
      )
    ).toHaveLength(1)
  })
})

describe('scheduled wake-ups (SA-115, DL-115-05)', () => {
  async function seedSchedule(overrides: Record<string, any> = {}) {
    return createSchedule({
      userId: USER,
      agentId: COOPER,
      name: 'Morning check',
      cadence: { type: 'daily', at: '09:00' },
      timeZone: 'America/Chicago',
      message: 'Say good morning.',
      ...overrides
    })
  }

  it('writes a DM FROM the schedule and wakes the agent with a schedule origin', async () => {
    const schedule = await seedSchedule()
    const result = await deliverScheduledDm(schedule, { trigger: 'tick' })

    expect(result.deliveredAs).toBe('wake')
    expect(result.outcome).toBe(`woke: ${result.sessionId}`)

    const dm = await getDm(result.dmId)
    expect(dm?.from).toEqual({ kind: 'schedule', scheduleId: schedule.id, name: 'Morning check' })
    expect(dm?.subject).toBe('Morning check')
    expect(dm?.body).toBe('Say good morning.')
    expect(dm?.delivery).toMatchObject({ requested: 'wake', actual: 'wake', sessionId: result.sessionId })

    // A clock starts a chain; it never continues one. Depth 0 in means depth 1 on the
    // woken turn, exactly as a webhook produces.
    const session = await redis.getSession(result.sessionId as string)
    expect((session?.metadata as any)?.origin).toMatchObject({
      kind: 'schedule',
      label: 'Morning check',
      scheduleId: schedule.id,
      dmId: result.dmId,
      chainDepth: 1
    })
    expect(session?.name).toBe('Schedule: Morning check')

    const messages = await redis.getMessages(result.sessionId as string, 10)
    expect(messages[0].content).toContain('[Schedule "Morning check" — not from the user]')
    expect(messages[0].content).toContain(`DM id: ${result.dmId}`)
    expect((messages[0].metadata as any)?.wake?.chainDepth).toBe(1)
  })

  it('leaves a `wait` schedule in the inbox and never starts a turn', async () => {
    const schedule = await seedSchedule({ deliver: 'wait' })
    const before = fetchCalls.length
    const result = await deliverScheduledDm(schedule, { trigger: 'tick' })

    expect(result.deliveredAs).toBe('wait')
    expect(result.outcome).toBe('waiting in inbox')
    expect(result.sessionId).toBeUndefined()
    expect(fetchCalls.length).toBe(before)
    expect((await listInbox(COOPER)).map((item) => item.id)).toContain(result.dmId)
  })

  it('degrades to wait with the reason on the DM and in the outcome', async () => {
    const schedule = await seedSchedule()
    await redis.updateAgent(COOPER, { wake_enabled: false } as any)

    const result = await deliverScheduledDm(schedule, { trigger: 'tick' })
    expect(result.deliveredAs).toBe('wait')
    expect(result.outcome).toMatch(/^waited: /)
    expect(result.outcome).toMatch(/May be woken/i)
    expect((await getDm(result.dmId))?.delivery).toMatchObject({
      requested: 'wake',
      actual: 'wait'
    })
    // Nothing is dropped: the DM is still there for the agent's next turn.
    expect(await listInbox(COOPER)).toHaveLength(1)
  })

  it('an assignment gets stated defaults and NO report-back, because a clock has no inbox', async () => {
    const schedule = await seedSchedule({ kind: 'assignment', deliver: 'wait' })
    const result = await deliverScheduledDm(schedule, { trigger: 'tick' })

    const dm = await getDm(result.dmId)
    expect(dm?.kind).toBe('assignment')
    expect(dm?.requestedOutcome).toBeTruthy()
    expect(dm?.scope).toBeTruthy()
    expect(dm?.reportBackTo).toBeUndefined()
  })

  it('says when a LATE run was due, and stays quiet when it is on time', async () => {
    const schedule = await seedSchedule({ deliver: 'wait' })
    const dueAt = new Date('2026-09-08T14:00:00.000Z')

    const late = await deliverScheduledDm(schedule, {
      trigger: 'tick',
      dueAt,
      now: new Date(dueAt.getTime() + 4 * 60_000)
    })
    expect((await getDm(late.dmId))?.body).toContain(
      '(This run was due Tue, Sep 8, 9:00 AM CDT and is running late.)'
    )

    // The on-time body has no note, which also makes it a different body — so the DM
    // store's ten-minute duplicate guard does not swallow the second send.
    const onTime = await deliverScheduledDm(schedule, {
      trigger: 'tick',
      dueAt,
      now: new Date(dueAt.getTime() + 5_000)
    })
    expect((await getDm(onTime.dmId))?.body).toBe('Say good morning.')
  })

  it('refuses a recipient that is gone, not a primary, or has Agent DMs off', async () => {
    const schedule = await seedSchedule()

    await redis.updateAgent(COOPER, { dms_enabled: false } as any)
    await expect(deliverScheduledDm(schedule, { trigger: 'tick' })).rejects.toThrow(/Agent DMs/i)

    await redis.updateAgent(COOPER, { dms_enabled: true, agentType: 'n8n' } as any)
    await expect(deliverScheduledDm(schedule, { trigger: 'tick' })).rejects.toThrow(
      /API or CLI primary/i
    )

    await redis.del(`agent:${COOPER}`)
    await expect(deliverScheduledDm(schedule, { trigger: 'tick' })).rejects.toThrow(
      /no longer exists/i
    )
  })
})

/**
 * SA-114 P4 (DL-114-13) — `deliver: 'steer'`.
 *
 * The recipient's running turn is set up here the way send-routed sets it up: the
 * session-turn lock, the stream, and the steer run's verdict, all naming one assistant
 * message id. Nothing here fakes `sendDmOp`'s own view of that — the point of these tests
 * is that it reads the SAME three registries the steer route reads.
 */
describe('steering a busy agent (DL-114-13)', () => {
  const COOPER_SESSION = 'sess-cooper-busy'
  const COOPER_ASSISTANT = 'msg_assistant_cooper'

  async function startCooperReply(
    options: { steerable?: boolean; reason?: string | null; messageId?: string } = {}
  ) {
    const messageId = options.messageId ?? COOPER_ASSISTANT
    await redis.createSession({
      id: COOPER_SESSION,
      user_id: USER,
      agent_id: COOPER,
      name: 'Cooper is working'
    } as any)
    registerSessionTurn(COOPER_SESSION, 'single', messageId)
    registerStreamAbort(COOPER_SESSION, messageId, new AbortController())
    registerSteerRun(COOPER_SESSION, {
      messageId,
      steerable: options.steerable ?? true,
      reason: options.reason ?? null,
      lane: (options.steerable ?? true) ? 'api' : null
    })
    return messageId
  }

  function stopCooperReply(messageId = COOPER_ASSISTANT) {
    clearStreamAbort(COOPER_SESSION, messageId)
    clearSessionTurn(COOPER_SESSION, messageId)
  }

  afterEach(() => {
    stopCooperReply()
  })

  it('lands inside the reply the recipient is writing and stamps the DM', async () => {
    const messageId = await startCooperReply()

    const result = await sendOne(baseContext(), {
      to: COOPER,
      kind: 'info',
      subject: 'Use the smoke lane',
      body: 'Not the Mac app — the smoke stack is the one with the seeded agents.',
      priority: 'urgent',
      deliver: 'steer'
    })

    expect(result).toMatchObject({ delivered_as: 'steer', session_id: COOPER_SESSION })

    const queued = listPendingSteers(COOPER_SESSION)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      steerId: result.dm_id,
      dmId: result.dm_id,
      messageId,
      source: 'dm',
      label: 'Faye'
    })
    // The steer text carries the DM's own content and its id, so a steered assignment is
    // still claimable — but NOT a second "not from the user" bracket: the injection wrapper
    // adds that on the way to the model.
    expect(queued[0].text).toContain('Use the smoke lane')
    expect(queued[0].text).toContain(`DM id: ${result.dm_id}`)
    expect(queued[0].text).not.toContain('not from the user')

    const record = await getDm(result.dm_id)
    expect(record?.delivery).toMatchObject({
      requested: 'steer',
      actual: 'steer',
      sessionId: COOPER_SESSION
    })
  })

  it('degrades to wait when the recipient is idle, and records why', async () => {
    const result = await sendOne(baseContext(), {
      to: COOPER,
      kind: 'info',
      subject: 'No rush',
      body: 'Whenever you get to it.',
      deliver: 'steer'
    })

    expect(result.delivered_as).toBe('wait')
    expect(result.reason).toMatch(/not mid-reply/i)
    expect(listPendingSteers(COOPER_SESSION)).toHaveLength(0)
    const record = await getDm(result.dm_id)
    expect(record?.delivery).toMatchObject({ requested: 'steer', actual: 'wait' })
    expect(record?.steerFallback).toBe('wait')
  })

  it('degrades to a real wake when the sender asked for that fallback', async () => {
    const result = await sendOne(baseContext(), {
      to: COOPER,
      kind: 'info',
      subject: 'Start now',
      body: 'The build is red.',
      deliver: 'steer',
      steer_fallback: 'wake'
    })

    expect(result.delivered_as).toBe('wake')
    expect(result.session_id).toBeTruthy()
    // A degraded steer spends the wake budget only because it BECAME a wake. The steer
    // itself spends none, which is why nothing above this line touches it.
    const record = await getDm(result.dm_id)
    expect(record?.delivery).toMatchObject({ requested: 'steer', actual: 'wake' })
    expect(record?.steerFallback).toBe('wake')
  })

  it('refuses a second agent DM while the first is still waiting for that reply', async () => {
    await startCooperReply()
    await seedAgent(OPIE)

    const first = await sendOne(baseContext(), {
      to: COOPER,
      kind: 'info',
      subject: 'First',
      body: 'one',
      deliver: 'steer'
    })
    expect(first.delivered_as).toBe('steer')

    const second = await sendOne(baseContext(OPIE, 'sess-opie'), {
      to: COOPER,
      kind: 'info',
      subject: 'Second',
      body: 'two',
      deliver: 'steer'
    })
    expect(second.delivered_as).toBe('wait')
    expect(second.reason).toMatch(/already waiting to land/i)
    expect(listPendingSteers(COOPER_SESSION)).toHaveLength(1)
  })

  it('degrades when the running turn says it cannot be steered, using the run\'s own reason', async () => {
    await startCooperReply({
      steerable: false,
      reason: 'This Codex agent runs on the one-shot exec transport.'
    })

    const result = await sendOne(baseContext(), {
      to: COOPER,
      kind: 'info',
      subject: 'Nope',
      body: 'x',
      deliver: 'steer'
    })

    expect(result.delivered_as).toBe('wait')
    expect(result.reason).toMatch(/exec transport/i)
    expect(listPendingSteers(COOPER_SESSION)).toHaveLength(0)
  })

  it('degrades when the turn dies in setup before its stream ever registers', async () => {
    // The lock is held (the top of send-routed) but the stream never comes. The DM door
    // waits through that window like the route does (F-P4-3) and stops the moment the lock
    // goes, so the honest answer arrives as soon as it is true rather than at the bound.
    await startCooperReply()
    clearStreamAbort(COOPER_SESSION, COOPER_ASSISTANT)
    const releaseTimer = setTimeout(
      () => clearSessionTurn(COOPER_SESSION, COOPER_ASSISTANT),
      200
    )

    try {
      const result = await sendOne(baseContext(), {
        to: COOPER,
        kind: 'info',
        subject: 'Too early',
        body: 'x',
        deliver: 'steer'
      })
      expect(result.delivered_as).toBe('wait')
      expect(result.reason).toMatch(/not mid-reply/i)
      expect(listPendingSteers(COOPER_SESSION)).toHaveLength(0)
      // F-P4-1: a steer that landed nowhere names no chat.
      const record = await getDm(result.dm_id)
      expect(record?.delivery).toMatchObject({ requested: 'steer', actual: 'wait' })
      expect(record?.delivery.sessionId).toBeUndefined()
    } finally {
      clearTimeout(releaseTimer)
    }
  })

  it('waits through the setup window the way the steer route does (F-P4-3)', async () => {
    // send-routed registers the session-turn lock at its top and the stream only after
    // compile, clips and the memory commit — 1.5 to 3 s later, measured. A DM steer sent in
    // that window degraded with "not mid-reply right now", which is false: the agent IS
    // mid-reply, its reply is being set up. F-P3-1 fixed the same defect on the user's door.
    await redis.createSession({
      id: COOPER_SESSION,
      user_id: USER,
      agent_id: COOPER,
      name: 'Cooper is starting a reply'
    } as any)
    registerSessionTurn(COOPER_SESSION, 'single', COOPER_ASSISTANT)
    const streamTimer = setTimeout(() => {
      registerStreamAbort(COOPER_SESSION, COOPER_ASSISTANT, new AbortController())
      registerSteerRun(COOPER_SESSION, {
        messageId: COOPER_ASSISTANT,
        steerable: true,
        reason: null,
        lane: 'api'
      })
    }, 300)

    try {
      const result = await sendOne(baseContext(), {
        to: COOPER,
        kind: 'info',
        subject: 'Early',
        body: 'Sent while the reply was still compiling.',
        deliver: 'steer'
      })
      expect(result).toMatchObject({ delivered_as: 'steer', session_id: COOPER_SESSION })
      expect(listPendingSteers(COOPER_SESSION)).toHaveLength(1)
    } finally {
      clearTimeout(streamTimer)
    }
  })

  it('keeps the steer reason on the record when the fallback wakes (F-P4-1)', async () => {
    const result = await sendOne(baseContext(), {
      to: COOPER,
      kind: 'info',
      subject: 'Start now',
      body: 'The build is red.',
      deliver: 'steer',
      steer_fallback: 'wake'
    })
    expect(result.delivered_as).toBe('wake')
    // The sender was told why the steer became a wake; the record must say the same.
    const record = await getDm(result.dm_id)
    expect(record?.delivery.actual).toBe('wake')
    expect(record?.delivery.reason).toMatch(/not mid-reply/i)
  })

  it('records both reasons when the fallback wake is refused too (F-P4-1)', async () => {
    await seedAgent(COOPER, { wake_enabled: false })
    const result = await sendOne(baseContext(), {
      to: COOPER,
      kind: 'info',
      subject: 'Start now',
      body: 'The build is red.',
      deliver: 'steer',
      steer_fallback: 'wake'
    })
    expect(result.delivered_as).toBe('wait')
    const record = await getDm(result.dm_id)
    expect(record?.delivery.actual).toBe('wait')
    expect(record?.delivery.reason).toMatch(/not mid-reply/i)
    expect(record?.delivery.reason).toMatch(/"May be woken" turned off/)
    expect(record?.delivery.sessionId).toBeUndefined()
  })

  it('cannot overwrite the end-of-turn degrade with a stale "landed" stamp (F-P4-1)', async () => {
    // The race: the entry is enqueued, the reply ends at once, the request's `finally`
    // takes the missed entry and stamps `wait` — and THEN the send's own "landed" stamp
    // completes and overwrites it with `steer`. The record would say "landed mid-reply"
    // about a DM the model never saw. The fix is order: the stamp goes down BEFORE the
    // enqueue, so a degrade can only ever come after it.
    //
    // The gate below holds the first read of this DM's record that happens while its steer
    // entry is already in the inbox. Before the fix that read is the "landed" stamp's own
    // re-read (the stamp runs AFTER the enqueue); with the fix the stamp runs before the
    // enqueue, so the gate never engages and the test simply degrades afterwards.
    await startCooperReply()
    let release: (() => void) | null = null
    let markEngaged: (() => void) | null = null
    const engaged = new Promise<void>((resolve) => {
      markEngaged = resolve
    })
    // On the fake lane `redis.json.get` is already a `vi.fn`, so spying on it REPLACES its
    // implementation rather than wrapping it — the original has to be read off the mock
    // first or the gate calls itself. On the real lane it is a plain function.
    const currentGet = redis.json.get as any
    const originalGet: (key: string, path?: string) => Promise<any> =
      typeof currentGet.getMockImplementation === 'function' &&
      currentGet.getMockImplementation()
        ? currentGet.getMockImplementation()
        : currentGet.bind(redis.json)
    const spy = vi
      .spyOn(redis.json, 'get')
      .mockImplementation(async (key: string, path?: string) => {
        if (
          key.startsWith('dm:') &&
          listPendingSteers(COOPER_SESSION).length > 0 &&
          release === null
        ) {
          await new Promise<void>((resolve) => {
            release = resolve
            markEngaged?.()
          })
        }
        return originalGet(key, path)
      })

    try {
      const sending = sendOne(baseContext(), {
        to: COOPER,
        kind: 'info',
        subject: 'Racing the end of the reply',
        body: 'x',
        deliver: 'steer'
      })
      const outcome = await Promise.race([
        engaged.then(() => 'gated' as const),
        sending.then(() => 'done' as const)
      ])

      // The reply ends now, exactly as send-routed's `finally` does it.
      const missed = takeMissedDmSteers(COOPER_SESSION)
      expect(missed).toHaveLength(1)
      await degradeMissedDmSteers(missed, STEER_MISSED_REASON)

      if (outcome === 'gated') release!()
      const result = await sending

      const record = await getDm(result.dm_id)
      expect(record?.delivery.actual).toBe('wait')
      expect(record?.delivery.reason).toBe(STEER_MISSED_REASON)
      expect(record?.delivery.sessionId).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  it('never steers somebody else\'s session', async () => {
    await redis.createSession({
      id: 'sess-theirs',
      user_id: 'someone-else',
      agent_id: COOPER,
      name: 'Not yours'
    } as any)
    registerSessionTurn('sess-theirs', 'single', 'msg_theirs')
    registerStreamAbort('sess-theirs', 'msg_theirs', new AbortController())
    registerSteerRun('sess-theirs', {
      messageId: 'msg_theirs',
      steerable: true,
      reason: null,
      lane: 'api'
    })

    const result = await sendOne(baseContext(), {
      to: COOPER,
      kind: 'info',
      subject: 'x',
      body: 'y',
      deliver: 'steer'
    })
    expect(result.delivered_as).toBe('wait')
    expect(listPendingSteers('sess-theirs')).toHaveLength(0)
    clearStreamAbort('sess-theirs', 'msg_theirs')
    clearSessionTurn('sess-theirs', 'msg_theirs')
  })

  it('refuses a broadcast that asks to steer', async () => {
    await expect(
      sendDmOp(baseContext(), {
        to: 'all',
        kind: 'info',
        subject: 'everyone',
        body: 'x',
        deliver: 'steer'
      })
    ).rejects.toThrow(/cannot steer anybody/i)
  })
})
