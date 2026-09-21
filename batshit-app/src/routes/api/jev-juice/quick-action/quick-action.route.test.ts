import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import type { TypesafeCallRecord } from '$lib/types/typesafe'
import { executionViewerService } from '$lib/server/services/executionViewerService'

/**
 * SA-120 P9 — `POST /api/jev-juice/quick-action`: the browser's one check before it decides
 * whether to send a spoken turn. The switch is re-read from the user's own voice settings here
 * (a stale page can never make a call the settings do not allow), every call gets its own
 * Execution Viewer entry (a swallowed turn has no run to ride), and a failure of any kind is
 * "no quick action": the answer never blocks a turn.
 */

const lane = vi.hoisted(() => ({
  calls: [] as Array<{ userId: string; said: string; featureEnabled: boolean }>,
  answer: null as null | { decision: unknown; record: TypesafeCallRecord | null },
  throwNext: false
}))

vi.mock('$lib/server/services/quickActions.jev', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/quickActions.jev')>()
  return {
    ...actual,
    computeQuickAction: vi.fn(async (input: { userId: string; said: string; featureEnabled: boolean }) => {
      lane.calls.push({ userId: input.userId, said: input.said, featureEnabled: input.featureEnabled })
      if (lane.throwNext) throw new Error('boom')
      return lane.answer ?? { decision: null, record: null }
    })
  }
})

import { POST } from './+server'

useRedisTestServer()

const USER = 'user-quick-action-route'

const RECORD: TypesafeCallRecord = {
  feature: 'quick_actions',
  model: 'jev-1.13.0',
  latencyMs: 201,
  usage: { inputTokens: 2300, outputTokens: 350 },
  deadlineHit: false,
  status: 'ok',
  questionCount: 8,
  at: '2026-09-17T23:00:00.000Z',
  decision: 'open_goon_dock 0.98 (next 0.03); only the request 0.97 → nothing sent to the agent'
}

function call(body: unknown, user: { id: string } | null = { id: USER }) {
  return POST({
    locals: user ? { user } : {},
    request: new Request('http://localhost/api/jev-juice/quick-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
  } as never)
}

async function seedVoiceSettings(quickActions: boolean | undefined) {
  await redis.json.set(`user:${USER}:settings`, '$', {
    id: `settings_${USER}`,
    user_id: USER,
    voice_settings: {
      schemaVersion: 2,
      voiceMode: quickActions === undefined ? { submitMode: 'auto' } : { submitMode: 'auto', jevJuiceQuickActions: quickActions }
    }
  } as never)
}

beforeEach(async () => {
  lane.calls = []
  lane.answer = null
  lane.throwNext = false
  await redis.del(`user:${USER}:settings`)
  await redis.del('agent:agent_qa')
  await redis.json.set('agent:agent_qa', '$', { id: 'agent_qa', user_id: USER, displayName: 'Faye' } as never)
})

describe('POST /api/jev-juice/quick-action', () => {
  it('requires a signed-in user and a `said`', async () => {
    expect((await call({ said: 'stop' }, null)).status).toBe(401)
    expect((await call({ said: '   ' })).status).toBe(400)
    expect((await call('not json')).status).toBe(400)
    expect(lane.calls).toHaveLength(0)
  })

  it('passes the switch from the user\'s OWN voice settings, never from the request (absent means OFF)', async () => {
    await seedVoiceSettings(undefined)
    await call({ said: 'open the dock', featureEnabled: true })
    await seedVoiceSettings(true)
    await call({ said: 'open the dock' })
    await seedVoiceSettings(false)
    await call({ said: 'open the dock' })
    expect(lane.calls.map((entry) => entry.featureEnabled)).toEqual([false, true, false])
    expect(lane.calls[0]).toMatchObject({ userId: USER, said: 'open the dock' })
  })

  it('answers a fired decision and writes the check\'s own Execution Viewer entry with the record', async () => {
    await seedVoiceSettings(true)
    lane.answer = {
      decision: { action: 'open_goon_dock', tab: null, confidence: 0.98, second: 0.03, onlyThis: true, summary: RECORD.decision },
      record: RECORD
    }
    const response = await call({ said: 'open the dock', spoken: 'Yo, open the dock', sessionId: 'sess_qa_1', agentId: 'agent_qa' })
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload).toMatchObject({ action: 'open_goon_dock', tab: null, onlyThis: true, confidence: 0.98, skipped: null, feature: 'quick_actions' })
    expect(payload.snapshotId).toMatch(/^qa_/)
    const snapshots = await executionViewerService.getSnapshots('sess_qa_1')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      id: payload.snapshotId,
      userId: USER,
      agentId: 'agent_qa',
      agentName: 'Faye',
      agentType: 'quick_action',
      // P9b: the entry shows what was spoken (wake word included) and, beside it, what Jev judged.
      userMessage: 'Yo, open the dock'
    })
    expect(snapshots[0].executionMetadata?.quickActionJudged).toBe('open the dock')
    expect(lane.calls[0].said).toBe('open the dock')
    expect(snapshots[0].executionMetadata?.typesafeCalls).toEqual([RECORD])
    expect(snapshots[0].executionMetadata?.quickAction).toEqual({ id: 'open_goon_dock', tab: null, onlyThis: true, confidence: 0.98 })
  })

  it('a miss answers no action with the reason, and still writes the entry; another user\'s agent is not named', async () => {
    await seedVoiceSettings(true)
    await redis.json.set('agent:agent_qa', '$', { id: 'agent_qa', user_id: 'someone-else', displayName: 'Theirs' } as never)
    lane.answer = { decision: null, record: { ...RECORD, status: 'unavailable', reason: 'deadline', deadlineHit: true, usage: null, decision: undefined } }
    const payload = await (await call({ said: 'stop', sessionId: 'sess_qa_2', agentId: 'agent_qa' })).json()
    expect(payload).toMatchObject({ action: null, onlyThis: false, confidence: 0, skipped: 'deadline' })
    const snapshots = await executionViewerService.getSnapshots('sess_qa_2')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ agentId: null, agentName: 'Batshit' })
  })

  it('a long turn is not a quick action, and a thrown check is "no quick action", never an error', async () => {
    await seedVoiceSettings(true)
    const long = await (await call({ said: 'a'.repeat(601) })).json()
    expect(long).toMatchObject({ action: null, skipped: 'too_long' })
    expect(lane.calls).toHaveLength(0)

    lane.throwNext = true
    const response = await call({ said: 'stop', sessionId: 'sess_qa_3' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ action: null, skipped: 'local_error' })
  })
})
