// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TypesafeConfig } from '$lib/types/typesafe'

/**
 * SA-120 P3 — the group speaker lane: request shape, the three floors (each one
 * mutation-sensitive at its exact boundary), the user-event "always a speaker" rule, the
 * follow-up gating, the DCM lines, the Execution Viewer metadata, and the orchestrator
 * against an injected fetch (including the DL-120-11 master-off no-call pin). No network.
 */

const retrieve = vi.hoisted(() => vi.fn<(service: string, userId: string) => Promise<string | null>>())
const dynamicPrivateEnv = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }))
const configState = vi.hoisted(() => ({
  config: { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null } as TypesafeConfig
}))

vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve } }))
vi.mock('$env/dynamic/private', () => dynamicPrivateEnv)
vi.mock('../typesafe/typesafeConfig', () => ({ getTypesafeConfig: vi.fn(async () => configState.config) }))

import { createTypesafeClient, type TypesafeFetch } from '../typesafe/typesafeClient'
import {
  GROUP_SPEAKER_LIMITS,
  GROUP_SPEAKER_THRESHOLDS,
  JEV_JUICE_GROUP_HEADING,
  buildGroupSpeakerDcmLines,
  buildGroupSpeakerKeys,
  buildGroupSpeakerRequest,
  buildGroupSpeakerSelectionMetadata,
  computeGroupSpeakerSelection,
  decideGroupSpeaker,
  describeGroupSpeakerCandidate,
  type GroupSpeakerCandidate,
  type GroupSpeakerRequest
} from '../groupSpeaker.jev'

const CANDIDATES: GroupSpeakerCandidate[] = [
  { agentId: 'agent-faye', name: 'Faye', about: 'Planning and architecture lead; speaks when design or risk is at stake', preset: 'smart' },
  { agentId: 'agent-opie', name: 'Opie', about: 'Hands-on implementer; loves code details and tests', preset: 'smart' },
  { agentId: 'agent-chef', name: 'Chef', about: 'Cooking and recipe specialist', preset: 'balanced' }
]

function request(overrides: Partial<Parameters<typeof buildGroupSpeakerRequest>[0]> = {}): GroupSpeakerRequest {
  const built = buildGroupSpeakerRequest({
    eventType: 'user',
    message: 'should the memory reranker live in the compile path or after it?',
    spokeLast: 'the user (Josh)',
    earlierThisTurn: [],
    candidates: CANDIDATES,
    ...overrides
  })
  if (!built) throw new Error('expected a request')
  return built
}

function answers(overrides: Record<string, any> = {}) {
  return {
    speaker: {
      type: 'choice',
      choice: 'faye',
      probabilities: { faye: 0.72, opie: 0.28, chef: 0, nobody: 0 },
      confidence: 0.65
    },
    needs_reply: { type: 'noul', noul: 0.93 },
    adds_value_faye: { type: 'noul', noul: 0.8 },
    adds_value_opie: { type: 'noul', noul: 0.74 },
    adds_value_chef: { type: 'noul', noul: 0.04 },
    ...overrides
  } as any
}

beforeEach(() => {
  retrieve.mockReset()
  retrieve.mockResolvedValue('user-key')
  dynamicPrivateEnv.env = {}
  configState.config = { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null }
})

describe('buildGroupSpeakerRequest', () => {
  it('asks one Choice over the candidates plus nobody, one needs_reply Noul, and one adds_value Noul per candidate', () => {
    const built = request({ earlierThisTurn: [{ name: 'Faye', content: 'we could put it in the DCM tail.' }] })
    expect(Object.keys(built.questions).sort()).toEqual(
      ['adds_value_chef', 'adds_value_faye', 'adds_value_opie', 'needs_reply', 'speaker'].sort()
    )
    const speaker = built.questions.speaker as any
    expect(speaker.type).toBe('choice')
    expect(Object.keys(speaker.criteria)).toEqual(['faye', 'opie', 'chef', 'nobody'])
    expect(speaker.criteria.faye).toContain('Faye:')
    expect(speaker.criteria.faye).toContain('speaks when it has something new to add')
    expect(speaker.criteria.chef).toContain('speaks when it adds clear value')
    expect(built.questions.needs_reply.type).toBe('noul')
    expect((built.questions.adds_value_opie as any).instructions).toContain('Opie (`agents.opie`)')
    expect(built.state.agents.faye).toBe(speaker.criteria.faye)
    expect(built.state.spoke_last).toBe('the user (Josh)')
    expect(built.state.earlier_this_turn).toEqual(['Faye: we could put it in the DCM tail.'])
    expect(built.candidates.map((candidate) => candidate.key)).toEqual(['faye', 'opie', 'chef'])
  })

  it('omits earlier_this_turn when there is none and keeps only the newest replies', () => {
    expect(request().state.earlier_this_turn).toBeUndefined()
    const built = request({
      earlierThisTurn: [
        { name: 'A', content: 'one' },
        { name: 'B', content: 'two' },
        { name: 'C', content: 'three' }
      ]
    })
    expect(built.state.earlier_this_turn).toEqual(['B: two', 'C: three'])
    expect(GROUP_SPEAKER_LIMITS.maxEarlierReplies).toBe(2)
  })

  it('clips the message, the about text, and the earlier replies', () => {
    const built = request({
      message: 'x'.repeat(GROUP_SPEAKER_LIMITS.maxMessageChars + 50),
      earlierThisTurn: [{ name: 'Opie', content: 'y'.repeat(GROUP_SPEAKER_LIMITS.maxEarlierReplyChars + 50) }],
      candidates: [{ agentId: 'a', name: 'Long', about: 'z'.repeat(GROUP_SPEAKER_LIMITS.maxAboutChars + 50), preset: 'smart' }]
    })
    expect(built.state.message.length).toBe(GROUP_SPEAKER_LIMITS.maxMessageChars)
    expect(built.state.earlier_this_turn?.[0].length).toBeLessThanOrEqual(GROUP_SPEAKER_LIMITS.maxEarlierReplyChars + 'Opie: '.length)
    expect(built.state.agents.long.length).toBeLessThanOrEqual(GROUP_SPEAKER_LIMITS.maxAboutChars + 'Long: '.length + '; speaks when it has something new to add'.length)
  })

  it('returns null with no message or no candidates, so no call is made', () => {
    expect(buildGroupSpeakerRequest({ eventType: 'user', message: '   ', spokeLast: 'x', earlierThisTurn: [], candidates: CANDIDATES })).toBeNull()
    expect(buildGroupSpeakerRequest({ eventType: 'user', message: 'hi', spokeLast: 'x', earlierThisTurn: [], candidates: [] })).toBeNull()
  })

  it('derives unique keys from names and never lets an agent claim nobody', () => {
    const keyed = buildGroupSpeakerKeys([
      { agentId: '1', name: 'Nobody', about: null, preset: 'smart' },
      { agentId: '2', name: 'Faye B', about: null, preset: 'smart' },
      { agentId: '3', name: 'faye-b', about: null, preset: 'smart' },
      { agentId: '4', name: '!!!', about: null, preset: 'smart' }
    ])
    expect(keyed.map((candidate) => candidate.key)).toEqual(['nobody_2', 'faye_b', 'faye_b_2', 'agent'])
  })

  it('describes a topic-only agent with its topics and a description-less agent honestly', () => {
    expect(describeGroupSpeakerCandidate({ agentId: 'a', name: 'Doc', about: null, preset: 'topic_only', topics: ['redis', 'svelte'] })).toBe(
      'Doc: no description; speaks only about: redis, svelte'
    )
  })
})

describe('decideGroupSpeaker', () => {
  it('picks the top candidate on a user event and reads the distribution among real candidates', () => {
    const decision = decideGroupSpeaker(answers(), request())
    expect(decision.outcome).toBe('picked')
    expect(decision.picked).toEqual({ agentId: 'agent-faye', name: 'Faye', probability: 0.72 })
    expect(decision.skipped).toEqual([])
    expect(decision.remaining).toHaveLength(3)
    expect(decision.summary).toContain('needs_reply 0.93')
    expect(decision.summary).toContain('speaker faye (nobody 0.00)')
    expect(decision.summary).toContain('→ picked Faye 0.72')
  })

  it('never lets nobody win a user event: the mass on nobody is set aside and the real candidates are renormalized', () => {
    // The E1 probe's "lol ok": nobody 0.61, Sadie 0.37. Among the agents who could answer, one is clearly best.
    const decision = decideGroupSpeaker(
      answers({
        speaker: { type: 'choice', choice: 'nobody', probabilities: { nobody: 0.61, faye: 0.37, opie: 0.02, chef: 0 }, confidence: 0.51 },
        needs_reply: { type: 'noul', noul: 0.43 }
      }),
      request()
    )
    expect(decision.outcome).toBe('picked')
    expect(decision.picked?.agentId).toBe('agent-faye')
    expect(decision.picked?.probability).toBeCloseTo(0.37 / 0.39, 5)
    expect(decision.skipped).toEqual([])
  })

  it('falls back to the usual rules when no candidate clears the speaker floor (exact boundary)', () => {
    const floor = GROUP_SPEAKER_THRESHOLDS.speakerFloor
    const at = decideGroupSpeaker(
      answers({ speaker: { type: 'choice', choice: 'faye', probabilities: { faye: floor, opie: 1 - floor, chef: 0, nobody: 0 }, confidence: 0.1 } }),
      request()
    )
    expect(at.outcome).toBe('picked')
    const rest = (1 - (floor - 0.01)) / 2
    const under = decideGroupSpeaker(
      answers({ speaker: { type: 'choice', choice: 'faye', probabilities: { faye: floor - 0.01, opie: rest, chef: rest, nobody: 0 }, confidence: 0.1 } }),
      request()
    )
    expect(under.outcome).toBe('low_confidence')
    expect(under.picked).toBeNull()
    expect(under.summary).toContain('low confidence → usual rules')
    // A distribution with nothing on any real candidate is not a pick either.
    const empty = decideGroupSpeaker(
      answers({ speaker: { type: 'choice', choice: 'nobody', probabilities: { nobody: 1, faye: 0, opie: 0, chef: 0 }, confidence: 1 } }),
      request()
    )
    expect(empty.outcome).toBe('low_confidence')
  })

  it('on a follow-up event skips a smart candidate under the adds_value floor and leaves other presets alone (exact boundary)', () => {
    const floor = GROUP_SPEAKER_THRESHOLDS.addsValueFloor
    const decision = decideGroupSpeaker(
      answers({
        speaker: { type: 'choice', choice: 'faye', probabilities: { faye: 0.5, opie: 0.3, chef: 0.2, nobody: 0 }, confidence: 0.3 },
        adds_value_faye: { type: 'noul', noul: floor },
        adds_value_opie: { type: 'noul', noul: floor - 0.01 },
        adds_value_chef: { type: 'noul', noul: 0.01 }
      }),
      request({ eventType: 'agent' })
    )
    expect(decision.skipped.map((reading) => reading.agentId)).toEqual(['agent-opie'])
    expect(decision.remaining.map((reading) => reading.agentId)).toEqual(['agent-faye', 'agent-chef'])
    // Faye's share among the remaining is 0.5 / 0.7.
    expect(decision.picked?.agentId).toBe('agent-faye')
    expect(decision.picked?.probability).toBeCloseTo(0.5 / 0.7, 5)
    expect(decision.summary).toContain('skipped Opie')
  })

  it('on a follow-up event skips every smart candidate when needs_reply is under its floor (exact boundary)', () => {
    const floor = GROUP_SPEAKER_THRESHOLDS.needsReplyFloor
    const kept = decideGroupSpeaker(answers({ needs_reply: { type: 'noul', noul: floor } }), request({ eventType: 'agent' }))
    expect(kept.skipped).toEqual([])
    const gated = decideGroupSpeaker(answers({ needs_reply: { type: 'noul', noul: floor - 0.01 } }), request({ eventType: 'agent' }))
    expect(gated.skipped.map((reading) => reading.agentId)).toEqual(['agent-faye', 'agent-opie'])
    // Chef is `balanced`, so the follow-up still has a candidate and Jev's share among the remaining is Chef alone.
    expect(gated.remaining.map((reading) => reading.agentId)).toEqual(['agent-chef'])
    expect(gated.outcome).toBe('low_confidence')
  })

  it('ends the follow-up chain when every candidate was smart and none clears the floors', () => {
    const decision = decideGroupSpeaker(
      answers({ needs_reply: { type: 'noul', noul: 0.2 } }),
      request({ eventType: 'agent', candidates: CANDIDATES.filter((candidate) => candidate.preset === 'smart') })
    )
    expect(decision.outcome).toBe('nobody_left')
    expect(decision.remaining).toEqual([])
    expect(decision.picked).toBeNull()
    expect(decision.summary).toContain('→ follow-up skipped')
  })

  it('never gates on a user event, whatever the Nouls say', () => {
    const decision = decideGroupSpeaker(
      answers({ needs_reply: { type: 'noul', noul: 0 }, adds_value_faye: { type: 'noul', noul: 0 }, adds_value_opie: { type: 'noul', noul: 0 } }),
      request({ eventType: 'user' })
    )
    expect(decision.skipped).toEqual([])
    expect(decision.remaining).toHaveLength(3)
  })

  it('treats a missing adds_value answer as "ask the model", never as a skip', () => {
    const decision = decideGroupSpeaker(
      answers({ adds_value_faye: undefined, adds_value_opie: { type: 'noul', noul: 0.1 } }),
      request({ eventType: 'agent' })
    )
    expect(decision.skipped.map((reading) => reading.agentId)).toEqual(['agent-opie'])
    expect(decision.agents.find((reading) => reading.agentId === 'agent-faye')?.addsValue).toBeNull()
  })
})

describe('buildGroupSpeakerDcmLines and the selection metadata', () => {
  it('tells the picked agent it was picked and whom Jev skipped', () => {
    const decision = decideGroupSpeaker(
      answers({ adds_value_chef: { type: 'noul', noul: 0.04 } }),
      request({ eventType: 'agent', candidates: [...CANDIDATES.slice(0, 2), { ...CANDIDATES[2], preset: 'smart' }] })
    )
    const lines = buildGroupSpeakerDcmLines(decision, 'agent-faye')
    expect(lines[0]).toBe(JEV_JUICE_GROUP_HEADING)
    expect(lines[1]).toBe('- You were picked to speak now (0.72 among 2 candidates). If you truly have nothing new to add, answer listening.')
    expect(lines[2]).toBe('- Skipped this turn for adding little: Chef (0.04).')
    const metadata = buildGroupSpeakerSelectionMetadata({ decision, record: {} as any, note: null }, 'agent-faye')
    expect(metadata).toEqual({
      by: 'jev',
      reason: 'picked',
      probability: 0.72,
      needsReply: 0.93,
      skipped: [{ agentId: 'agent-chef', agentName: 'Chef', addsValue: 0.04 }]
    })
  })

  it('tells an agent the usual rules picked it when Jev was not confident', () => {
    const decision = decideGroupSpeaker(
      answers({ speaker: { type: 'choice', choice: 'faye', probabilities: { faye: 0.4, opie: 0.35, chef: 0.25, nobody: 0 }, confidence: 0.1 } }),
      request()
    )
    const lines = buildGroupSpeakerDcmLines(decision, 'agent-opie')
    expect(lines).toEqual([
      JEV_JUICE_GROUP_HEADING,
      '- Jev Juice was not confident about a speaker (top Faye 0.40); Batshit picked you by its usual rules.'
    ])
    expect(buildGroupSpeakerSelectionMetadata({ decision, record: {} as any, note: null }, 'agent-opie')).toEqual({
      by: 'rules',
      reason: 'low_confidence',
      needsReply: 0.93,
      skipped: []
    })
  })

  it('records a miss as rules-picked with the reason', () => {
    expect(
      buildGroupSpeakerSelectionMetadata({ decision: null, record: { status: 'unavailable' } as any, note: null }, 'agent-opie')
    ).toEqual({ by: 'rules', reason: 'unavailable', skipped: [] })
    expect(
      buildGroupSpeakerSelectionMetadata({ decision: null, record: { status: 'error' } as any, note: null }, 'agent-opie')
    ).toEqual({ by: 'rules', reason: 'error', skipped: [] })
  })
})

describe('computeGroupSpeakerSelection', () => {
  function client(fetchImpl: TypesafeFetch) {
    return createTypesafeClient({ fetch: fetchImpl, dispatcher: null, sleep: async () => {} })
  }

  function okResponse(body: unknown) {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  it('makes one call, applies the floors, and writes the decision on the record', async () => {
    const fetchImpl = vi.fn<TypesafeFetch>(async (_url, init) => {
      const body = JSON.parse(String(init.body))
      expect(body.model).toBe('jev-1.13.0')
      expect(body.state.agents.faye).toContain('Faye:')
      return okResponse({ model: 'jev-1.13.0', answers: answers(), usage: { input_tokens: 820, output_tokens: 150 } })
    })
    const outcome = await computeGroupSpeakerSelection({ userId: 'josh', request: request(), client: client(fetchImpl) })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(outcome.decision?.picked?.agentId).toBe('agent-faye')
    expect(outcome.note).toBeNull()
    expect(outcome.record.feature).toBe('group_speaker')
    expect(outcome.record.status).toBe('ok')
    expect(outcome.record.usage).toEqual({ inputTokens: 820, outputTokens: 150 })
    expect(outcome.record.questionCount).toBe(5)
    expect(outcome.record.decision).toContain('→ picked Faye 0.72')
  })

  it('makes no call with the master switch off (DL-120-11) and reports it as a note', async () => {
    configState.config = { ...configState.config, enabled: false }
    const fetchImpl = vi.fn<TypesafeFetch>()
    const outcome = await computeGroupSpeakerSelection({ userId: 'josh', request: request(), client: client(fetchImpl) })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(outcome.decision).toBeNull()
    expect(outcome.record).toMatchObject({ feature: 'group_speaker', status: 'unavailable', reason: 'master_off' })
    expect(outcome.note).toMatchObject({ feature: 'group_speaker', status: 'unavailable', reason: 'master_off' })
  })

  it('reports a deadline miss as a note and no decision, so the usual rules pick', async () => {
    const fetchImpl = vi.fn<TypesafeFetch>((_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    )
    const outcome = await computeGroupSpeakerSelection({
      userId: 'josh',
      request: request(),
      client: createTypesafeClient({ fetch: fetchImpl, dispatcher: null, now: (() => { let t = 0; return () => (t += 500) })() })
    })
    expect(outcome.decision).toBeNull()
    expect(outcome.record.status).toBe('unavailable')
    expect(outcome.record.reason).toBe('deadline')
    expect(outcome.record.deadlineHit).toBe(true)
    expect(outcome.note?.reason).toBe('deadline')
  })

  it('SA-120 P8: the call runs under the stored In-Chat Wait Limit, and a change reaches the very next group turn', async () => {
    const budgets: Array<number | undefined> = []
    const recording = {
      async systemOne(request: { deadlineMs?: number }) {
        budgets.push(request.deadlineMs)
        return { status: 'unavailable', reason: 'deadline', latencyMs: 1, attempts: 1, deadlineHit: true, requestChars: 10 } as never
      }
    }
    await computeGroupSpeakerSelection({ userId: 'josh', request: request(), client: recording as never })
    configState.config = { ...configState.config, inChatWaitMs: 5000 }
    await computeGroupSpeakerSelection({ userId: 'josh', request: request(), client: recording as never })
    expect(budgets).toEqual([750, 5000])
  })
})
