// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TypesafeConfig } from '$lib/types/typesafe'
import type { TypesafeCallOutcome, TypesafeClient, TypesafeSystemOneRequest } from '../typesafe/typesafeClient'

/**
 * SA-120 P2 (H1) — `sys.judge.ask`, the agent-callable judgment tool.
 *
 * The op is the whole feature (DL-120-03): the agent's switch, the input contract, the
 * size guard, the model rule, one `runTypesafeJudgment` call, and the Execution Viewer
 * row. The DL-120-11 pin is here too: with the master switch OFF the fake client is
 * never touched, whatever the agent's own switch says.
 */

const redisGet = vi.hoisted(() => vi.fn<(key: string) => Promise<unknown>>())
const getActiveStream = vi.hoisted(() => vi.fn<(sessionId: string) => { messageId?: string | null } | null>())
const appendTypesafeCallRecords = vi.hoisted(() => vi.fn(async () => true))
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

vi.mock('$lib/server/redis', () => ({ redis: { get: redisGet } }))
vi.mock('../streamAbortRegistry', () => ({ getActiveStream }))
vi.mock('../typesafe/typesafeEvidence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../typesafe/typesafeEvidence')>()),
  appendTypesafeCallRecords
}))
vi.mock('../typesafe/typesafeConfig', () => ({
  getTypesafeConfig: vi.fn(async () => configState.config)
}))
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve } }))
vi.mock('$env/dynamic/private', () => dynamicPrivateEnv)

import { buildJevJuiceGuidancePromptBlock } from '$lib/utils/toolPromptInjection'
import {
  JUDGE_ASK_LIMITS,
  JudgeAskError,
  judgeAskOp,
  requireJudgeEnabledAgent,
  validateJudgeAskInput,
  validateJudgeQuestion
} from '../judgeAsk.jev'

const AGENT = { id: 'agent-1', user_id: 'josh', name: 'Cody', jev_juice_judge_tool: true }
const CONTEXT = { userId: 'josh', agentId: 'agent-1', sessionId: 'session-1' }

const OK_ANSWERS = {
  urgent: { type: 'noul', noul: 0.92 },
  tool: { type: 'choice', choice: 'web_search', probabilities: { web_search: 0.8, none: 0.2 }, confidence: 0.8 }
}

function fakeClient(outcome?: Partial<TypesafeCallOutcome>): TypesafeClient & { calls: TypesafeSystemOneRequest[] } {
  const calls: TypesafeSystemOneRequest[] = []
  return {
    calls,
    async systemOne(request) {
      calls.push(request as TypesafeSystemOneRequest)
      return {
        status: 'ok',
        response: { model: request.model, answers: OK_ANSWERS as never, usage: { inputTokens: 312, outputTokens: 48 } },
        latencyMs: 214,
        attempts: 1,
        deadlineHit: false,
        httpStatus: 200,
        requestChars: 240,
        ...outcome
      } as TypesafeCallOutcome
    }
  }
}

const GOOD_INPUT = {
  state: { message: 'The build is broken and the demo is in an hour, can you look?' },
  questions: {
    urgent: { type: 'noul', instructions: 'Does `message` convey urgency?' },
    tool: {
      type: 'choice',
      instructions: 'Which tool does `message` need?',
      criteria: { web_search: 'looks something up online', none: 'no tool' }
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  configState.config = { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null }
  redisGet.mockImplementation(async (key) => (key === 'agent:agent-1' ? AGENT : null))
  getActiveStream.mockReturnValue({ messageId: 'msg-1' })
  appendTypesafeCallRecords.mockResolvedValue(true)
  retrieve.mockResolvedValue('user-key')
  for (const key of Object.keys(dynamicPrivateEnv.env)) delete dynamicPrivateEnv.env[key]
})

describe('validateJudgeQuestion', () => {
  it('accepts the three v1 shapes', () => {
    expect(validateJudgeQuestion('a', { type: 'noul', instructions: 'Is it true?' })).toEqual({
      type: 'noul',
      instructions: 'Is it true?'
    })
    expect(
      validateJudgeQuestion('b', { type: 'choice', instructions: 'Which?', criteria: { x: 'one', none: 'nothing' } })
    ).toEqual({ type: 'choice', instructions: 'Which?', criteria: { x: 'one', none: 'nothing' } })
    expect(validateJudgeQuestion('c', { type: 'score', instructions: 'How much?', criteria: ['low', 'high'] })).toEqual({
      type: 'score',
      instructions: 'How much?',
      criteria: ['low', 'high']
    })
  })

  it('refuses a missing instructions field, because the id is never shown to the model', () => {
    expect(() => validateJudgeQuestion('a', { type: 'noul' })).toThrow(/instructions is required/)
  })

  it('refuses an unknown type and a malformed criteria per type', () => {
    expect(() => validateJudgeQuestion('a', { type: 'rank', instructions: 'x' })).toThrow(/must be noul, choice, or score/)
    expect(() => validateJudgeQuestion('a', { type: 'choice', instructions: 'x' })).toThrow(/criteria must be an object/)
    expect(() => validateJudgeQuestion('a', { type: 'score', instructions: 'x', criteria: 'low,high' })).toThrow(
      /array of 2-10 level descriptions/
    )
    expect(() => validateJudgeQuestion('a', { type: 'noul', instructions: 'x', criteria: ['yes'] })).toThrow(
      /must be \{true: ..., false: ...\}/
    )
  })

  it('enforces the choice and score bounds with a hint on the choice cap', () => {
    expect(() => validateJudgeQuestion('a', { type: 'choice', instructions: 'x', criteria: { only: 'one' } })).toThrow(
      /has 1 options; a choice needs 2-255/
    )
    const tooMany = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]))
    let error: unknown
    try {
      validateJudgeQuestion('a', { type: 'choice', instructions: 'x', criteria: tooMany })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(JudgeAskError)
    expect((error as JudgeAskError).hint).toMatch(/split into a coarse choice first/)
    expect(() =>
      validateJudgeQuestion('a', { type: 'score', instructions: 'x', criteria: Array.from({ length: 11 }, () => 'l') })
    ).toThrow(/2-10 level descriptions/)
  })
})

describe('validateJudgeAskInput', () => {
  it('requires state and at least one question', () => {
    expect(() => validateJudgeAskInput(null)).toThrow(/input object with state and questions/)
    expect(() => validateJudgeAskInput({ questions: GOOD_INPUT.questions })).toThrow(/state is required/)
    expect(() => validateJudgeAskInput({ state: 'x' })).toThrow(/questions must be an object/)
    expect(() => validateJudgeAskInput({ state: 'x', questions: {} })).toThrow(/at least one question/)
  })

  it('caps the question count at JUDGE_ASK_LIMITS.maxQuestions', () => {
    const questions = Object.fromEntries(
      Array.from({ length: JUDGE_ASK_LIMITS.maxQuestions + 1 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'x' }])
    )
    expect(() => validateJudgeAskInput({ state: 'x', questions })).toThrow(/the cap is 64 per call/)
  })

  it('accepts a pinned model id and refuses jev-latest (DL-120-08)', () => {
    expect(validateJudgeAskInput({ ...GOOD_INPUT, model: ' jev-1.13.0 ' }).model).toBe('jev-1.13.0')
    expect(validateJudgeAskInput(GOOD_INPUT).model).toBeNull()
    expect(() => validateJudgeAskInput({ ...GOOD_INPUT, model: 'jev-latest' })).toThrow(/jev-latest is not allowed/)
    expect(() => validateJudgeAskInput({ ...GOOD_INPUT, model: 42 })).toThrow(/must be a pinned Jev id/)
  })
})

describe('requireJudgeEnabledAgent', () => {
  it('refuses a missing agent context, an unknown agent, and another user\'s agent', async () => {
    await expect(requireJudgeEnabledAgent('josh', null)).rejects.toThrow(/agentId missing/)
    await expect(requireJudgeEnabledAgent('josh', 'agent-9')).rejects.toThrow(/was not found for this user/)
    redisGet.mockResolvedValueOnce({ ...AGENT, user_id: 'someone-else' })
    await expect(requireJudgeEnabledAgent('josh', 'agent-1')).rejects.toThrow(/was not found for this user/)
  })

  it('refuses an agent whose switch is off, with the Settings path as the hint', async () => {
    redisGet.mockResolvedValueOnce({ ...AGENT, jev_juice_judge_tool: false })
    let error: unknown
    try {
      await requireJudgeEnabledAgent('josh', 'agent-1')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(JudgeAskError)
    expect((error as JudgeAskError).message).toBe('Jev Juice: Judgment Tool is off for this agent.')
    expect((error as JudgeAskError).hint).toMatch(/Settings → Agents → this agent → Jev Juice: Judgment Tool/)
  })
})

describe('judgeAskOp', () => {
  it('forwards state and questions on the user key and returns the typed answers with usage and the EV row', async () => {
    const client = fakeClient()
    const result = await judgeAskOp({ ...CONTEXT, client }, GOOD_INPUT)

    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]).toMatchObject({
      apiKey: 'user-key',
      model: 'jev-1.13.0',
      state: GOOD_INPUT.state,
      attemptTimeoutMs: 5000,
      deadlineMs: JUDGE_ASK_LIMITS.deadlineMs
    })
    expect(Object.keys(client.calls[0].questions)).toEqual(['urgent', 'tool'])

    expect(result).toEqual({
      model: 'jev-1.13.0',
      answers: OK_ANSWERS,
      usage: { input_tokens: 312, output_tokens: 48 },
      latency_ms: 214,
      request_chars: JSON.stringify({ state: GOOD_INPUT.state, questions: client.calls[0].questions }).length,
      question_count: 2
    })

    // DL-120-07: one Execution Viewer row on the running assistant message.
    expect(getActiveStream).toHaveBeenCalledWith('session-1')
    expect(appendTypesafeCallRecords).toHaveBeenCalledTimes(1)
    const [sessionId, messageId, records] = appendTypesafeCallRecords.mock.calls[0] as unknown as [
      string,
      string,
      Array<Record<string, unknown>>
    ]
    expect(sessionId).toBe('session-1')
    expect(messageId).toBe('msg-1')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      feature: 'judge_ask',
      model: 'jev-1.13.0',
      status: 'ok',
      latencyMs: 214,
      usage: { inputTokens: 312, outputTokens: 48 },
      questionCount: 2,
      decision: 'answered 2 questions for the agent'
    })
  })

  it('DL-120-11: with the master switch OFF the client is never touched, the row says master_off, and the error names the fix', async () => {
    configState.config = { ...configState.config, enabled: false }
    const client = fakeClient()
    let error: unknown
    try {
      await judgeAskOp({ ...CONTEXT, client }, GOOD_INPUT)
    } catch (caught) {
      error = caught
    }
    expect(client.calls).toHaveLength(0)
    expect(error).toBeInstanceOf(JudgeAskError)
    expect((error as JudgeAskError).message).toBe('Jev Juice is off in Settings → Admin.')
    expect((error as JudgeAskError).hint).toMatch(/Settings → Admin → Jev Juice/)
    const [, , records] = appendTypesafeCallRecords.mock.calls[0] as unknown as [string, string, Array<Record<string, unknown>>]
    expect(records[0]).toMatchObject({ feature: 'judge_ask', status: 'unavailable', reason: 'master_off', usage: null })
  })

  it('with no key saved anywhere the error points at Settings → API Keys and no call is made', async () => {
    retrieve.mockResolvedValue(null)
    const client = fakeClient()
    let error: unknown
    try {
      await judgeAskOp({ ...CONTEXT, client }, GOOD_INPUT)
    } catch (caught) {
      error = caught
    }
    expect(client.calls).toHaveLength(0)
    expect((error as JudgeAskError).message).toBe('No TypeSafe key is saved.')
    expect((error as JudgeAskError).hint).toMatch(/Settings → API Keys/)
  })

  it('refuses an oversized request before any call, with the split hint', async () => {
    const client = fakeClient()
    const big = { ...GOOD_INPUT, state: 'x'.repeat(JUDGE_ASK_LIMITS.maxRequestChars) }
    let error: unknown
    try {
      await judgeAskOp({ ...CONTEXT, client }, big)
    } catch (caught) {
      error = caught
    }
    expect(client.calls).toHaveLength(0)
    expect(appendTypesafeCallRecords).not.toHaveBeenCalled()
    expect((error as JudgeAskError).message).toMatch(/characters; the cap is/)
    expect((error as JudgeAskError).hint).toMatch(/Send less state, or split/)
  })

  it('refuses a model that is not the configured one, and accepts the configured one', async () => {
    const client = fakeClient()
    let error: unknown
    try {
      await judgeAskOp({ ...CONTEXT, client }, { ...GOOD_INPUT, model: 'jev-1.12.0' })
    } catch (caught) {
      error = caught
    }
    expect(client.calls).toHaveLength(0)
    expect((error as JudgeAskError).message).toBe('model jev-1.12.0 is not the configured Jev model (jev-1.13.0).')
    expect((error as JudgeAskError).hint).toMatch(/Omit model to use the configured one/)

    const ok = await judgeAskOp({ ...CONTEXT, client }, { ...GOOD_INPUT, model: 'jev-1.13.0' })
    expect(ok.model).toBe('jev-1.13.0')
    expect(client.calls).toHaveLength(1)
  })

  it('a vendor deadline miss becomes a readable error with the do-not-loop hint, and still leaves an EV row', async () => {
    const client = fakeClient({
      status: 'unavailable',
      reason: 'deadline',
      latencyMs: 15_000,
      attempts: 1,
      deadlineHit: true,
      requestChars: 240
    } as TypesafeCallOutcome)
    let error: unknown
    try {
      await judgeAskOp({ ...CONTEXT, client }, GOOD_INPUT)
    } catch (caught) {
      error = caught
    }
    expect((error as JudgeAskError).message).toBe('TypeSafe did not answer in time.')
    expect((error as JudgeAskError).hint).toMatch(/do not loop on it/)
    const [, , records] = appendTypesafeCallRecords.mock.calls[0] as unknown as [string, string, Array<Record<string, unknown>>]
    expect(records[0]).toMatchObject({ feature: 'judge_ask', status: 'unavailable', reason: 'deadline', deadlineHit: true })
  })

  it('a call with no active stream still answers; the missing EV row is logged, not hidden', async () => {
    getActiveStream.mockReturnValue(null)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = fakeClient()
    const result = await judgeAskOp({ ...CONTEXT, client }, GOOD_INPUT)
    expect(result.question_count).toBe(2)
    expect(appendTypesafeCallRecords).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no active stream'), { sessionId: 'session-1' })
    warn.mockRestore()
  })
})

describe('the guidance block restates JUDGE_ASK_LIMITS', () => {
  it('names the same caps the op enforces, so a limit change must touch the prompt too', () => {
    const guidance = buildJevJuiceGuidancePromptBlock()
    expect(guidance).toContain(`Up to ${JUDGE_ASK_LIMITS.maxQuestions} questions per call`)
    expect(guidance).toContain(`${JUDGE_ASK_LIMITS.minChoiceOptions} to ${JUDGE_ASK_LIMITS.maxChoiceOptions} options`)
    expect(guidance).toContain(`${JUDGE_ASK_LIMITS.minScoreLevels} to ${JUDGE_ASK_LIMITS.maxScoreLevels} levels`)
    // 120,000 chars is "about 30k tokens" at the four-chars-a-token rule the guard uses.
    expect(Math.round(JUDGE_ASK_LIMITS.maxRequestChars / 4 / 1000)).toBe(30)
    expect(guidance).toContain('under about 30k tokens')
  })
})
