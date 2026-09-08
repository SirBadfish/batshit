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
  registerSessionTurn
} from '$lib/server/services/streamAbortRegistry'
import {
  __resetDmLocksForTests,
  createDm,
  getDm,
  listInbox,
  reopenDm,
  stampDmNeedsUser
} from '../dmStore'
import {
  buildWokenDmContent,
  claimDmOp,
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
  previousToken = envRecord.BATSHIT_TOKEN
  envRecord.BATSHIT_TOKEN = 'test-service-token'
  stubFetch()
  await seedAgent(FAYE)
  await seedAgent(COOPER)
})

afterEach(() => {
  __resetWakeRunRegistryForTests()
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

  it('refuses `steer` until SA-114 ships', async () => {
    await expect(
      sendDmOp(baseContext(), {
        to: COOPER,
        kind: 'info',
        subject: 'x',
        body: 'y',
        deliver: 'steer' as never
      })
    ).rejects.toThrow(/SA-114/)
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
      clearSessionTurn('sess-cooper-live')
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
      clearSessionTurn('sess-cooper-live')
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
