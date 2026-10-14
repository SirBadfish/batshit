import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'
import { requestAgentWakeup } from '$lib/server/services/agentWakeups'

/**
 * BL-401 review finding 2 (BL-702) — a schedule fire that lands while a woken turn is ENDING.
 *
 * `finishWokenTurn` removes the turn from the wake registry first and only then, after
 * awaits, stamps the DM's delivery and acknowledges an info note. A fire in that gap no
 * longer sees the note as "being delivered", so it updates it (BL-401 S1). The old turn must
 * then leave the note alone: its stamp would copy the old chat onto the new fire's delivery,
 * and its acknowledge would close a fire the agent never saw.
 *
 * The gap is made deterministic by running the fire inside the first delivery stamp the
 * ending turn makes, before that stamp touches the record.
 */

const refire = vi.hoisted(() => ({ run: null as null | (() => Promise<void>), ran: false }))
const finishedRuns = vi.hoisted(() => [] as string[])
const pendingApproval = vi.hoisted(() => ({ value: false }))

vi.mock('$lib/server/services/dm/pendingToolApproval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/dm/pendingToolApproval')>()
  return {
    ...actual,
    hasPendingToolApproval: async (...args: Parameters<typeof actual.hasPendingToolApproval>) =>
      pendingApproval.value ? true : actual.hasPendingToolApproval(...args)
  }
})

vi.mock('$lib/server/services/dm/dmStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/dm/dmStore')>()
  return {
    ...actual,
    stampDmDelivery: async (...args: Parameters<typeof actual.stampDmDelivery>) => {
      if (refire.run && !refire.ran) {
        refire.ran = true
        await refire.run()
      }
      return actual.stampDmDelivery(...args)
    }
  }
})

vi.mock('$lib/server/ssePublisher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/ssePublisher')>()
  return {
    ...actual,
    publishUserEvent: async (userId: string, event: Record<string, any>) => {
      await actual.publishUserEvent(userId, event)
      if (event?.type === 'session_run_status' && event.reason) finishedRuns.push(event.sessionId)
    }
  }
})

const { fileScheduleDm, getDm, __resetDmLocksForTests } = await import(
  '$lib/server/services/dm/dmStore'
)

useRedisTestServer()

const USER = 'user-wake-refire'
const COOPER = 'agent-cooper'
const envRecord = env as Record<string, string | undefined>
let previousToken: string | undefined

function fire() {
  return fileScheduleDm({
    userId: USER,
    from: { kind: 'schedule', scheduleId: 'sch_refire', name: 'Queue check' },
    to: COOPER,
    kind: 'info',
    subject: 'Queue check',
    body: 'Check the queue.',
    deliver: 'wake'
  })
}

beforeEach(async () => {
  finishedRuns.length = 0
  refire.run = null
  refire.ran = false
  pendingApproval.value = false
  __resetDmLocksForTests()
  previousToken = envRecord.BATSHIT_TOKEN
  envRecord.BATSHIT_TOKEN = 'test-service-token'
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
  )
  await redis.createAgent({
    id: COOPER,
    user_id: USER,
    displayName: 'Cooper',
    agentType: 'api',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4-5',
    dms_enabled: true
  } as any)
})

afterEach(() => {
  __resetWakeRunRegistryForTests()
  if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
  else envRecord.BATSHIT_TOKEN = previousToken
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('BL-702 — a fire that lands while the woken turn that delivered the note is ending', () => {
  it('the ending turn leaves the re-fired note open and does not stamp its chat onto it', async () => {
    const first = await fire()
    let refired: Awaited<ReturnType<typeof fire>> | null = null
    // The fire lands after the registry dropped the turn and before the turn's first stamp.
    refire.run = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      refired = await fire()
    }

    const woke = await requestAgentWakeup({
      userId: USER,
      agentId: COOPER,
      target: { kind: 'new-session', subject: 'Queue check' },
      content: '[Schedule "Queue check" — not from the user] info — Queue check',
      origin: { kind: 'schedule', fromLabel: 'Queue check', scheduleId: 'sch_refire', dmId: first.record.id },
      chainDepth: 0
    })
    expect(woke.ok).toBe(true)
    if (!woke.ok) throw new Error('the wake was refused')
    await vi.waitFor(
      () => {
        if (!finishedRuns.includes(woke.sessionId)) throw new Error('not finished yet')
      },
      { timeout: 4_000, interval: 10 }
    )

    expect(refire.ran).toBe(true)
    expect(refired!.updated).toBe(true)
    expect(refired!.record.id).toBe(first.record.id)
    const stored = await getDm(first.record.id)
    // The new fire is still unread, so the agent sees it on its next turn.
    expect(stored?.status).toBe('new')
    expect(stored?.fireCount).toBe(2)
    // And its delivery is the new fire's own, not the ended turn's chat and outcome.
    expect(stored?.delivery).toEqual({ requested: 'wake', actual: 'wait' })
  })

  // BL-739: the BL-702 guard is `stampDmNeedsUser`'s own `firedAfterTurnStarted` check
  // (`dmStore.ts` ~1139), never reached by the two tests above (neither ends parked on an
  // approval). No test failed when that guard was removed.
  it('a re-fire during the ending turn skips the Needs-you stamp, not only the outcome stamp', async () => {
    const first = await fire()
    let refired: Awaited<ReturnType<typeof fire>> | null = null
    refire.run = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      refired = await fire()
    }
    // The woken turn ends sitting on a tool approval — the second holdup `stampDmNeedsUser`
    // exists for.
    pendingApproval.value = true

    const woke = await requestAgentWakeup({
      userId: USER,
      agentId: COOPER,
      target: { kind: 'new-session', subject: 'Queue check' },
      content: '[Schedule "Queue check" — not from the user] info — Queue check',
      origin: { kind: 'schedule', fromLabel: 'Queue check', scheduleId: 'sch_refire', dmId: first.record.id },
      chainDepth: 0
    })
    expect(woke.ok).toBe(true)
    if (!woke.ok) throw new Error('the wake was refused')
    await vi.waitFor(
      () => {
        if (!finishedRuns.includes(woke.sessionId)) throw new Error('not finished yet')
      },
      { timeout: 4_000, interval: 10 }
    )

    expect(refire.ran).toBe(true)
    expect(refired!.updated).toBe(true)
    const stored = await getDm(first.record.id)
    // The re-fired note is still open and unread, exactly like the outcome-stamp test above —
    // and the ended turn's approval holdup must not overwrite it with "needs you".
    expect(stored?.status).toBe('new')
    expect(stored?.fireCount).toBe(2)
    expect(stored?.delivery?.needsUser).toBeUndefined()
  })

  it('a note that was NOT re-fired is still acknowledged when its woken turn completes', async () => {
    const first = await fire()
    const woke = await requestAgentWakeup({
      userId: USER,
      agentId: COOPER,
      target: { kind: 'new-session', subject: 'Queue check' },
      content: '[Schedule "Queue check" — not from the user] info — Queue check',
      origin: { kind: 'schedule', fromLabel: 'Queue check', scheduleId: 'sch_refire', dmId: first.record.id },
      chainDepth: 0
    })
    if (!woke.ok) throw new Error('the wake was refused')
    await vi.waitFor(
      () => {
        if (!finishedRuns.includes(woke.sessionId)) throw new Error('not finished yet')
      },
      { timeout: 4_000, interval: 10 }
    )
    const stored = await getDm(first.record.id)
    expect(stored?.status).toBe('done')
    expect(stored?.delivery).toMatchObject({ outcome: 'completed', sessionId: woke.sessionId })
  })
})

describe('BL-703 — a fire that lands after the wake is reserved but before it registers', () => {
  // `reserveWakeSlot` holds the slot synchronously; `registerWakeRun` only runs 3-9s later,
  // after the session/message setup awaits. A fire that lands in that gap must see the note
  // as unavailable (it is about to be delivered), the same as one that lands after
  // registration (BL-702, tested above). The `/api/sse` forward call sits in exactly that
  // gap — right after the setup awaits and right before `registerWakeRun` — so hooking it
  // reproduces the race deterministically.
  it('the ending turn leaves the re-fired note open even though the fire landed before the run was registered', async () => {
    const first = await fire()
    let refired: Awaited<ReturnType<typeof fire>> | null = null
    let sseForwardSeen = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (!sseForwardSeen && typeof url === 'string' && url.endsWith('/api/sse')) {
          sseForwardSeen = true
          // The guard compares millisecond timestamps with a strict `>`; without this the
          // re-fire can land in the same millisecond as `reservedAt` and the assertion below
          // would be timing-dependent instead of pinning the fix (same pattern as the BL-702
          // case above).
          await new Promise((resolve) => setTimeout(resolve, 5))
          refired = await fire()
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      })
    )

    const woke = await requestAgentWakeup({
      userId: USER,
      agentId: COOPER,
      target: { kind: 'new-session', subject: 'Queue check' },
      content: '[Schedule "Queue check" — not from the user] info — Queue check',
      origin: { kind: 'schedule', fromLabel: 'Queue check', scheduleId: 'sch_refire', dmId: first.record.id },
      chainDepth: 0
    })
    expect(woke.ok).toBe(true)
    if (!woke.ok) throw new Error('the wake was refused')
    await vi.waitFor(
      () => {
        if (!finishedRuns.includes(woke.sessionId)) throw new Error('not finished yet')
      },
      { timeout: 4_000, interval: 10 }
    )

    expect(sseForwardSeen).toBe(true)
    expect(refired!.updated).toBe(true)
    expect(refired!.record.id).toBe(first.record.id)
    const stored = await getDm(first.record.id)
    // The new fire is still unread, so the agent sees it on its next turn — same assertion
    // shape as the BL-702 case above, but this fire landed before `registerWakeRun` ran.
    expect(stored?.status).toBe('new')
    expect(stored?.fireCount).toBe(2)
    expect(stored?.delivery).toEqual({ requested: 'wake', actual: 'wait' })
  })

  it('a note that was NOT re-fired is still acknowledged when its woken turn completes', async () => {
    const first = await fire()
    const woke = await requestAgentWakeup({
      userId: USER,
      agentId: COOPER,
      target: { kind: 'new-session', subject: 'Queue check' },
      content: '[Schedule "Queue check" — not from the user] info — Queue check',
      origin: { kind: 'schedule', fromLabel: 'Queue check', scheduleId: 'sch_refire', dmId: first.record.id },
      chainDepth: 0
    })
    if (!woke.ok) throw new Error('the wake was refused')
    await vi.waitFor(
      () => {
        if (!finishedRuns.includes(woke.sessionId)) throw new Error('not finished yet')
      },
      { timeout: 4_000, interval: 10 }
    )
    const stored = await getDm(first.record.id)
    expect(stored?.status).toBe('done')
    expect(stored?.delivery).toMatchObject({ outcome: 'completed', sessionId: woke.sessionId })
  })
})
