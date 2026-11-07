// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TypesafeConfig } from '$lib/types/typesafe'

const retrieve = vi.hoisted(() => vi.fn(async () => 'test-key'))
const configState = vi.hoisted(() => ({ config: {
  enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750,
  screenIncomingText: false, updatedAt: null
} as TypesafeConfig }))
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve } }))
vi.mock('$env/dynamic/private', () => ({ env: {} }))
vi.mock('../typesafe/typesafeConfig', () => ({ getTypesafeConfig: vi.fn(async () => configState.config) }))

import {
  buildSkillSessionCloseRequest, decideSkillSessionCloses, computeSkillSessionCloses,
  type SkillSessionCloseCandidate, type SkillSessionCloseEvidence
} from '../skillSessions.jev'
import type { TypesafeClient } from '../typesafe/typesafeClient'

const candidate = (overrides: Partial<SkillSessionCloseCandidate> = {}): SkillSessionCloseCandidate => ({
  skillId: 'artifact_creator', agentId: 'agent-one', name: 'Artifact Creator', generation: 2,
  revision: 4, holdFingerprint: 'holds-v4', accessFingerprint: 'access-v2', status: 'open',
  openedAt: 100, openedMessageId: 'reply-one', openMessages: 3,
  reads: [{ zipId: 'zip_held', rawZipId: 'cool_tool_held', messageId: 'reply-one', path: 'SKILL.md' }],
  description: 'Build a working Artifact', taskRequest: 'Build a calculator and test it.',
  readWindows: ['SKILL.md: characters 0-11999', 'references/native.md: characters 300-799'],
  readWindowsComplete: true, automatic: true, hasExplicitHold: false,
  ...overrides
})
const evidence = (overrides: Partial<SkillSessionCloseEvidence> = {}): SkillSessionCloseEvidence => ({
  request: 'Finish testing the calculator.', reply: 'The calculator is ready and the requested checks passed.',
  recentUserIntent: ['Build it, then test it.'], complete: true, unfinishedWork: false,
  scope: 'primary', origin: 'user', finished: true, ...overrides
})
const answers = (completed = 0.95, again = 0.05) => ({
  completed_s1: { type: 'noul', noul: completed }, again_s1: { type: 'noul', noul: again }
})
const request = () => buildSkillSessionCloseRequest(evidence(), [candidate()]).request!
function clientWith(values: Record<string, unknown> = answers()) {
  return { systemOne: vi.fn(async () => ({
    status: 'ok', response: { model: 'jev-1.13.0', answers: values, usage: { inputTokens: 80, outputTokens: 0 } },
    latencyMs: 50, attempts: 1, deadlineHit: false, requestChars: 100
  })) } as unknown as TypesafeClient & { systemOne: ReturnType<typeof vi.fn> }
}
beforeEach(() => {
  retrieve.mockReset().mockResolvedValue('test-key')
  configState.config = { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null } as TypesafeConfig
})

describe('skill-session close evidence and policy', () => {
  it('asks two independent questions per actual skill in one state, keeps identities home, and preserves partial file reads', () => {
    const built = request()
    expect(Object.keys(built.questions)).toEqual(['completed_s1', 'again_s1'])
    expect(built.state.skills.s1).toEqual({ description: 'Build a working Artifact', task: 'Build a calculator and test it.', read_windows: candidate().readWindows })
    expect(JSON.stringify(built.state)).not.toMatch(/artifact_creator|agent-one|holds-v4|access-v2|reply-one|zip_held/)
    expect(built.candidates[0].candidate).toEqual(candidate())
    // Complete accounting means every actual window, not every byte in the underlying file.
    expect(built.candidates[0].candidate.readWindows[1]).toContain('300-799')
  })

  it('never judges partial/stopped/failed work, an approval wait, a group/delegate, a wake, or missing task context', () => {
    for (const change of [
      { finished: false }, { unfinishedWork: true }, { complete: false }, { scope: 'group' },
      { scope: 'delegated' }, { origin: 'wake' }, { request: '' }, { reply: '' }
    ] as Partial<SkillSessionCloseEvidence>[]) {
      expect(buildSkillSessionCloseRequest(evidence(change), [candidate()]).request).toBeNull()
    }
    for (const change of [
      { automatic: false }, { hasExplicitHold: true }, { readWindowsComplete: false },
      { taskRequest: '' }, { readWindows: [] }, { holdFingerprint: '' }, { accessFingerprint: '' }
    ]) expect(buildSkillSessionCloseRequest(evidence(), [candidate(change)]).request).toBeNull()
  })

  it('keeps a conflicting duplicate snapshot out and never silently shortens task or reply evidence', () => {
    expect(buildSkillSessionCloseRequest(evidence(), [candidate(), candidate({ revision: 5 })]).request).toBeNull()
    const long = 'complete evidence '.repeat(3000)
    const built = buildSkillSessionCloseRequest(evidence({ request: long, reply: long }), [candidate()]).request!
    expect(built.state.request).toBe(long)
    expect(built.state.reply).toBe(long)
  })

  it('requires completed >= .85 AND needed-again <= .15, with literal boundary pins', () => {
    expect(decideSkillSessionCloses(answers(0.85, 0.15), request()).close).toHaveLength(1)
    expect(decideSkillSessionCloses(answers(0.8499, 0.15), request()).close).toEqual([])
    expect(decideSkillSessionCloses(answers(0.85, 0.1501), request()).close).toEqual([])
    expect(decideSkillSessionCloses(answers(0.99, 0.9), request()).close).toEqual([])
  })

  it('keeps open on either missing, malformed or undecided probability', () => {
    for (const values of [
      { completed_s1: answers().completed_s1 }, { again_s1: answers().again_s1 },
      answers(0.5, 0.5), answers(NaN, 0), answers(1, -0.1),
      { completed_s1: { type: 'choice', noul: 1 }, again_s1: answers().again_s1 }
    ]) expect(decideSkillSessionCloses(values, request()).close).toEqual([])
  })
})

describe('skill-session close access and evidence wrapper (no network)', () => {
  const run = (client: TypesafeClient, agent: Record<string, any> = { jev_juice_skill_tool_hints: 'manage' }, facts = evidence()) => computeSkillSessionCloses({ userId: 'user-one', agent, evidence: facts, candidates: [candidate()], client })

  it('old true, Suggest, Off and absent settings never call or close', async () => {
    for (const value of [undefined, null, false, true, 'off', 'suggest']) {
      const client = clientWith()
      expect((await run(client, { jev_juice_skill_tool_hints: value })).decision).toBeNull()
      expect(client.systemOne).not.toHaveBeenCalled()
    }
  })

  it('master OFF and missing keys call nothing, keep open, and return visible reasons plus EV rows', async () => {
    configState.config.enabled = false
    const client = clientWith()
    const off = await run(client)
    expect(client.systemOne).not.toHaveBeenCalled()
    expect(retrieve).not.toHaveBeenCalled()
    expect(off.record).toMatchObject({ feature: 'skill_tool_hints', reason: 'master_off', usage: null })
    expect(off.note?.reason).toBe('master_off')
    configState.config.enabled = true
    retrieve.mockResolvedValue(null as never)
    const noKey = await run(client)
    expect(client.systemOne).not.toHaveBeenCalled()
    expect(noKey.note?.reason).toBe('no_key')
  })

  it('keeps incomplete task context open before any key or provider work', async () => {
    const client = clientWith()
    const skipped = await run(client, { jev_juice_skill_tool_hints: 'manage' }, evidence({ complete: false }))
    expect(client.systemOne).not.toHaveBeenCalled()
    expect(retrieve).not.toHaveBeenCalled()
    expect(skipped.skipped.join(' ')).toContain('kept open')
  })

  it('uses the same provider lane, own after-reply budget and per-call EV record, returning proposals without writing state', async () => {
    const client = clientWith()
    const outcome = await run(client)
    expect(client.systemOne).toHaveBeenCalledTimes(1)
    expect(client.systemOne.mock.calls[0][0]).toMatchObject({ deadlineMs: 2000, model: 'jev-1.13.0' })
    expect(outcome.record).toMatchObject({ feature: 'skill_tool_hints', status: 'ok', questionCount: 2, usage: { inputTokens: 80, outputTokens: 0 } })
    expect(outcome.decision?.close[0].candidate).toEqual(candidate())
    expect(outcome.record?.decision).toContain('propose close')
  })
})
