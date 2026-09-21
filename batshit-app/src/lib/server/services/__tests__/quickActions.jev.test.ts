// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TypesafeConfig } from '$lib/types/typesafe'
import type { TypesafeCallOutcome, TypesafeClient, TypesafeSystemOneRequest } from '../typesafe/typesafeClient'

/**
 * SA-120 P9 — quick actions from speech: the one request shape (only the words of the turn
 * and the catalog's names leave the machine), the decision (the top action at or over the
 * floor with no runner-up over it fires; "only the request" at or over its floor swallows the
 * turn; the Settings tab is a soft hint), every floor at its exact boundary AND in the literal
 * numbers the probe measured (F-P6-7's rule), and the orchestrator against a fake client: the
 * switch, the DL-120-11 master-off no-call pin, the in-chat budget (P8), and a miss.
 */

const retrieve = vi.hoisted(() => vi.fn<(service: string, userId: string) => Promise<string | null>>())
const dynamicPrivateEnv = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }))
const configState = vi.hoisted(() => ({
  config: {
    enabled: true,
    modelId: 'jev-1.13.0',
    attemptTimeoutMs: 5000,
    inChatWaitMs: 750,
    screenIncomingText: false,
    updatedAt: null
  } as TypesafeConfig
}))

vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve } }))
vi.mock('$env/dynamic/private', () => dynamicPrivateEnv)
vi.mock('../typesafe/typesafeConfig', () => ({ getTypesafeConfig: vi.fn(async () => configState.config) }))

import { QUICK_ACTION_IDS, QUICK_ACTION_SETTINGS_TABS } from '$lib/utils/jevJuiceQuickActions'
import {
  QUICK_ACTION_LIMITS,
  QUICK_ACTION_QUESTIONS,
  buildQuickActionRequest,
  clipQuickActionSaid,
  computeQuickAction,
  decideQuickAction
} from '../quickActions.jev'

function answers(wants: Partial<Record<string, number>>, only = 0.95, tab?: { choice: string; probability: number }) {
  const out: Record<string, unknown> = {}
  for (const id of QUICK_ACTION_IDS) out[`wants_${id}`] = { type: 'noul', noul: wants[id] ?? 0.03 }
  out.only_the_request = { type: 'noul', noul: only }
  out.settings_tab = tab
    ? { type: 'choice', choice: tab.choice, confidence: tab.probability, probabilities: { [tab.choice]: tab.probability } }
    : { type: 'choice', choice: 'unspecified', confidence: 1, probabilities: { unspecified: 1 } }
  return out
}

function fakeClient(reply: Record<string, unknown>, outcome?: Partial<TypesafeCallOutcome>): TypesafeClient & { calls: TypesafeSystemOneRequest[] } {
  const calls: TypesafeSystemOneRequest[] = []
  return {
    calls,
    async systemOne(request) {
      calls.push(request as TypesafeSystemOneRequest)
      return {
        status: 'ok',
        response: { model: 'jev-1.13.0', answers: reply, usage: { inputTokens: 2300, outputTokens: 350 } },
        latencyMs: 201,
        attempts: 1,
        deadlineHit: false,
        httpStatus: 200,
        requestChars: 5000,
        ...outcome
      } as never
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  configState.config = { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null }
  retrieve.mockResolvedValue('user-key')
})

describe('buildQuickActionRequest', () => {
  it('sends only the words of the turn and the fixed questions: one Noul per action, "only the request", and the tab Choice', () => {
    const request = buildQuickActionRequest('  open   the dock  ')
    expect(request).not.toBeNull()
    expect(request!.state).toEqual({ context: QUICK_ACTION_QUESTIONS.context, said: 'open the dock' })
    expect(Object.keys(request!.questions)).toEqual([
      ...QUICK_ACTION_IDS.map((id) => `wants_${id}`),
      'only_the_request',
      'settings_tab'
    ])
    const wantsDock = request!.questions.wants_open_goon_dock as { type: string; instructions: string; criteria: { true: string } }
    expect(wantsDock.type).toBe('noul')
    expect(wantsDock.instructions).toContain('open the Goon Dock')
    expect(wantsDock.criteria.true).toContain('"open the dock"')
    const tab = request!.questions.settings_tab as { type: string; criteria: Record<string, string> }
    expect(tab.type).toBe('choice')
    expect(Object.keys(tab.criteria)).toEqual([...Object.keys(QUICK_ACTION_SETTINGS_TABS), 'unspecified'])
    // Nothing else: no history, no agent, no settings.
    expect(JSON.stringify(request!.state)).not.toMatch(/history|agent|memory/i)
  })

  it('clips a long turn and asks nothing for an empty one', () => {
    expect(buildQuickActionRequest('   ')).toBeNull()
    expect(clipQuickActionSaid('a'.repeat(1000))).toHaveLength(QUICK_ACTION_LIMITS.maxSaidChars)
    expect(QUICK_ACTION_LIMITS.maxSaidChars).toBe(600)
  })
})

describe('decideQuickAction', () => {
  it('fires the top action at the floor and not one hundredth under it (0.8)', () => {
    expect(QUICK_ACTION_LIMITS.actionFloor).toBe(0.8)
    expect(decideQuickAction(answers({ open_goon_dock: 0.8 })).action).toBe('open_goon_dock')
    expect(decideQuickAction(answers({ open_goon_dock: 0.79 })).action).toBeNull()
  })

  it('a tie at the floor is no action; a clear runner-up under the floor is fine', () => {
    expect(decideQuickAction(answers({ end_voice_mode: 0.95, stop: 0.8 })).action).toBeNull()
    expect(decideQuickAction(answers({ end_voice_mode: 0.95, stop: 0.79 })).action).toBe('end_voice_mode')
  })

  it('swallows the turn only at the "only the request" floor (0.8); under it the rest goes to the agent', () => {
    expect(QUICK_ACTION_LIMITS.onlyFloor).toBe(0.8)
    expect(decideQuickAction(answers({ stop: 0.9 }, 0.8)).onlyThis).toBe(true)
    expect(decideQuickAction(answers({ stop: 0.9 }, 0.79)).onlyThis).toBe(false)
    // With no action, "only" means nothing.
    expect(decideQuickAction(answers({ stop: 0.5 }, 0.99)).onlyThis).toBe(false)
  })

  it('names the Settings tab only for open_settings and only at the tab floor (0.6)', () => {
    expect(QUICK_ACTION_LIMITS.tabFloor).toBe(0.6)
    expect(decideQuickAction(answers({ open_settings: 0.9 }, 0.9, { choice: 'voice', probability: 0.6 })).tab).toBe('voice')
    expect(decideQuickAction(answers({ open_settings: 0.9 }, 0.9, { choice: 'voice', probability: 0.59 })).tab).toBeNull()
    expect(decideQuickAction(answers({ open_settings: 0.9 }, 0.9, { choice: 'unspecified', probability: 1 })).tab).toBeNull()
    expect(decideQuickAction(answers({ open_goon_dock: 0.9 }, 0.9, { choice: 'voice', probability: 0.99 })).tab).toBeNull()
  })

  it('the literal probe numbers (round 3, 2026-09-17): requests fire and swallow, mixed turns fire and send, near-misses do not fire', () => {
    // "Stop." → stop 0.85 / only 0.85: the closest plain request, fires and swallows.
    expect(decideQuickAction(answers({ stop: 0.85, end_voice_mode: 0.26 }, 0.85))).toMatchObject({ action: 'stop', onlyThis: true })
    // "hang up" → end_voice_mode 0.95, stop 0.55: the runner-up is under the floor, so it fires.
    expect(decideQuickAction(answers({ end_voice_mode: 0.95, stop: 0.55 }, 0.98))).toMatchObject({ action: 'end_voice_mode', onlyThis: true })
    // "open the dock, and what's on my calendar today?" → dock 0.98 / only 0.05: fires, the rest goes to the agent.
    expect(decideQuickAction(answers({ open_goon_dock: 0.98 }, 0.05))).toMatchObject({ action: 'open_goon_dock', onlyThis: false })
    // "don't open the dock" → close 0.51: the closest non-request; nothing fires.
    expect(decideQuickAction(answers({ close_goon_dock: 0.51 }, 0.93)).action).toBeNull()
    // "settings" alone → open_settings 0.74: a bare word does not act.
    expect(decideQuickAction(answers({ open_settings: 0.74 }, 0.85)).action).toBeNull()
    // "open up the agent settings" → 0.72: a miss, and the safe direction (the turn goes to the agent).
    expect(decideQuickAction(answers({ open_settings: 0.72 }, 0.94)).action).toBeNull()
  })

  it('writes a decision line the Execution Viewer can show', () => {
    expect(decideQuickAction(answers({ open_settings: 0.9 }, 0.9, { choice: 'voice', probability: 0.8 })).summary).toBe(
      'open_settings 0.90 (next 0.03); only the request 0.90 → nothing sent to the agent; tab voice'
    )
    expect(decideQuickAction(answers({ stop: 0.5 })).summary).toBe('top stop 0.50 (needed 0.8) → no action')
  })
})

describe('computeQuickAction', () => {
  it('makes one in_chat call under the stored In-Chat Wait Limit and returns the decision with the record', async () => {
    const client = fakeClient(answers({ open_goon_dock: 0.98 }, 0.97))
    const outcome = await computeQuickAction({ userId: 'josh', said: 'open the dock', featureEnabled: true, client })
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].deadlineMs).toBe(750)
    expect(client.calls[0].state).toEqual({ context: QUICK_ACTION_QUESTIONS.context, said: 'open the dock' })
    expect(outcome.decision).toMatchObject({ action: 'open_goon_dock', onlyThis: true, confidence: 0.98 })
    expect(outcome.record).toMatchObject({ feature: 'quick_actions', status: 'ok', usage: { inputTokens: 2300, outputTokens: 350 }, questionCount: 8 })
    expect(outcome.record?.decision).toContain('open_goon_dock 0.98')
  })

  it('the switch off means no call and a feature_off record; the master switch off means no call at all (DL-120-11)', async () => {
    const client = fakeClient(answers({ stop: 0.99 }))
    const off = await computeQuickAction({ userId: 'josh', said: 'stop', featureEnabled: false, client })
    expect(client.calls).toHaveLength(0)
    expect(off.decision).toBeNull()
    expect(off.record).toMatchObject({ status: 'unavailable', reason: 'feature_off' })

    configState.config = { ...configState.config, enabled: false }
    const master = await computeQuickAction({ userId: 'josh', said: 'stop', featureEnabled: true, client })
    expect(client.calls).toHaveLength(0)
    expect(master.record).toMatchObject({ status: 'unavailable', reason: 'master_off' })
  })

  it('a miss is no action, with the record saying why; an empty turn asks nothing', async () => {
    const client = fakeClient({}, { status: 'unavailable', reason: 'deadline', deadlineHit: true, response: undefined } as never)
    const miss = await computeQuickAction({ userId: 'josh', said: 'stop', featureEnabled: true, client })
    expect(miss.decision).toBeNull()
    expect(miss.record).toMatchObject({ status: 'unavailable', reason: 'deadline', deadlineHit: true })
    const empty = await computeQuickAction({ userId: 'josh', said: '   ', featureEnabled: true, client })
    expect(empty).toEqual({ decision: null, record: null })
    expect(client.calls).toHaveLength(1)
  })
})
