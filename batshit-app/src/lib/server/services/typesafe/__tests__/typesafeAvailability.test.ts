// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TypesafeConfig } from '$lib/types/typesafe'

/**
 * SA-120 P0 — THE access rule (DL-120-01/11): master switch AND feature switch AND key.
 * The DL-120-11 pin is the first test: with the master switch OFF nothing reaches fetch,
 * whatever the feature switch says and even with a key saved.
 */

const retrieve = vi.hoisted(() => vi.fn<(service: string, userId: string) => Promise<string | null>>())
const dynamicPrivateEnv = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }))
const configState = vi.hoisted(() => ({
  config: {
    enabled: false,
    modelId: 'jev-1.13.0',
    attemptTimeoutMs: 5000,
    inChatWaitMs: 750,
    screenIncomingText: false,
    updatedAt: null
  } as TypesafeConfig
}))

vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve } }))
vi.mock('$env/dynamic/private', () => dynamicPrivateEnv)
vi.mock('../typesafeConfig', () => ({
  getTypesafeConfig: vi.fn(async () => configState.config)
}))

import { createTypesafeClient, type TypesafeFetch, type TypesafeFetchInit } from '../typesafeClient'
import { __resetOllamaContextCacheForTests } from '../ollamaDecisionModels'
import type { JudgeProviderRecord } from '$lib/types/typesafe'
import { JUDGE_LANE_IDS, UNREADABLE_JUDGE_CHOICE } from '$lib/utils/judgeProviders'
import {
  resolveTypesafeAccess,
  resolveTypesafeApiKey,
  resolveTypesafeDeadlineMs,
  runTypesafeJudgment
} from '../typesafeAvailability'

const OK_BODY = {
  model: 'jev-1.13.0',
  answers: { yes: { type: 'noul', noul: 0.8 } },
  usage: { input_tokens: 10, output_tokens: 2 }
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function setConfig(patch: Partial<TypesafeConfig>) {
  configState.config = { ...configState.config, ...patch }
}

function judgment(fetchImpl: TypesafeFetch, overrides: Partial<Parameters<typeof runTypesafeJudgment>[0]> = {}) {
  return runTypesafeJudgment({
    userId: 'josh',
    featureId: 'connection_test',
    featureEnabled: true,
    state: { message: 'hello' },
    questions: { yes: { type: 'noul', instructions: 'Is it friendly?' } },
    client: createTypesafeClient({ fetch: fetchImpl, dispatcher: null }),
    ...overrides
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(dynamicPrivateEnv.env)) delete dynamicPrivateEnv.env[key]
  setConfig({
    enabled: false,
    modelId: 'jev-1.13.0',
    attemptTimeoutMs: 5000,
    inChatWaitMs: 750,
    providers: [],
    defaultProviderId: 'typesafe',
    laneProviders: {}
  })
  retrieve.mockResolvedValue(null)
  __resetOllamaContextCacheForTests()
})

describe('resolveTypesafeDeadlineMs (SA-120 P8, DL-120-16)', () => {
  it('gives an in_chat lane the user\'s In-Chat Wait Limit, and lets a caller only shorten it', () => {
    const config = { inChatWaitMs: 750 }
    expect(resolveTypesafeDeadlineMs({ lane: 'in_chat' }, config)).toBe(750)
    expect(resolveTypesafeDeadlineMs({ lane: 'in_chat', deadlineMs: 630 }, config)).toBe(630)
    expect(resolveTypesafeDeadlineMs({ lane: 'in_chat', deadlineMs: 2000 }, config)).toBe(750)
    expect(resolveTypesafeDeadlineMs({ lane: 'in_chat', deadlineMs: 750 }, config)).toBe(750)
    expect(resolveTypesafeDeadlineMs({ lane: 'in_chat' }, { inChatWaitMs: 5000 })).toBe(5000)
  })

  it('leaves every other lane\'s own budget alone, whatever the setting says', () => {
    const config = { inChatWaitMs: 200 }
    expect(resolveTypesafeDeadlineMs({ deadlineMs: 2000 }, config)).toBe(2000)
    expect(resolveTypesafeDeadlineMs({ deadlineMs: 10_000 }, config)).toBe(10_000)
    expect(resolveTypesafeDeadlineMs({}, config)).toBeUndefined()
  })
})

describe('resolveTypesafeApiKey', () => {
  it('prefers the saved user key over the env fallback', async () => {
    retrieve.mockResolvedValue('  user-key  ')
    dynamicPrivateEnv.env.TYPESAFE_API_KEY = 'env-key'
    await expect(resolveTypesafeApiKey('josh')).resolves.toEqual({ apiKey: 'user-key', source: 'user' })
    expect(retrieve).toHaveBeenCalledWith('typesafe', 'josh')
  })

  it('falls back to TYPESAFE_API_KEY when no user key is saved', async () => {
    dynamicPrivateEnv.env.TYPESAFE_API_KEY = 'env-key'
    await expect(resolveTypesafeApiKey('josh')).resolves.toEqual({ apiKey: 'env-key', source: 'env' })
  })

  it('returns null when neither exists', async () => {
    await expect(resolveTypesafeApiKey('josh')).resolves.toBeNull()
  })
})

describe('resolveTypesafeAccess', () => {
  it('denies master_off before it even looks at the feature switch or the key', async () => {
    retrieve.mockResolvedValue('user-key')
    const access = await resolveTypesafeAccess({ userId: 'josh', featureId: 'connection_test', featureEnabled: true })
    expect(access).toMatchObject({ allowed: false, reason: 'master_off' })
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('denies feature_off when the master switch is on but the feature is off', async () => {
    setConfig({ enabled: true })
    retrieve.mockResolvedValue('user-key')
    const access = await resolveTypesafeAccess({ userId: 'josh', featureId: 'connection_test', featureEnabled: false })
    expect(access).toMatchObject({ allowed: false, reason: 'feature_off' })
  })

  it('denies no_key when both switches are on but there is no key anywhere', async () => {
    setConfig({ enabled: true })
    const access = await resolveTypesafeAccess({ userId: 'josh', featureId: 'connection_test', featureEnabled: true })
    expect(access).toMatchObject({ allowed: false, reason: 'no_key' })
  })

  it('allows with the pinned model from config when all three hold', async () => {
    setConfig({ enabled: true, modelId: 'jev-1.14.0' })
    retrieve.mockResolvedValue('user-key')
    const access = await resolveTypesafeAccess({ userId: 'josh', featureId: 'connection_test', featureEnabled: true })
    expect(access).toMatchObject({ allowed: true, apiKey: 'user-key', keySource: 'user', model: 'jev-1.14.0' })
  })
})

describe('runTypesafeJudgment', () => {
  it('DL-120-11: master switch OFF means zero outbound calls, even with a key and the feature on', async () => {
    retrieve.mockResolvedValue('user-key')
    dynamicPrivateEnv.env.TYPESAFE_API_KEY = 'env-key'
    const fetchImpl = vi.fn<TypesafeFetch>().mockResolvedValue(jsonResponse(200, OK_BODY))
    const result = await judgment(fetchImpl)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.outcome).toBeNull()
    expect(result.response).toBeNull()
    expect(result.record).toMatchObject({
      feature: 'connection_test',
      status: 'unavailable',
      reason: 'master_off',
      usage: null,
      questionCount: 1,
      model: 'jev-1.13.0'
    })
  })

  it('makes no call when the feature switch is off', async () => {
    setConfig({ enabled: true })
    retrieve.mockResolvedValue('user-key')
    const fetchImpl = vi.fn<TypesafeFetch>().mockResolvedValue(jsonResponse(200, OK_BODY))
    const result = await judgment(fetchImpl, { featureEnabled: false })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.record).toMatchObject({ status: 'unavailable', reason: 'feature_off' })
  })

  it('calls once with the user key, the pinned model, and the configured attempt timeout when allowed', async () => {
    setConfig({ enabled: true, attemptTimeoutMs: 1234 })
    retrieve.mockResolvedValue('user-key')
    dynamicPrivateEnv.env.TYPESAFE_API_KEY = 'env-key'
    const fetchImpl = vi.fn<TypesafeFetch>().mockResolvedValue(jsonResponse(200, OK_BODY))
    const result = await judgment(fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const init = fetchImpl.mock.calls[0][1]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer user-key')
    expect(JSON.parse(String(init.body)).model).toBe('jev-1.13.0')
    expect(result.response?.answers.yes.noul).toBe(0.8)
    expect(result.record).toMatchObject({
      status: 'ok',
      model: 'jev-1.13.0',
      usage: { inputTokens: 10, outputTokens: 2 },
      deadlineHit: false,
      questionCount: 1
    })
  })

  it('SA-120 P8: an in_chat call runs under the stored In-Chat Wait Limit, read fresh on every call', async () => {
    setConfig({ enabled: true, inChatWaitMs: 40 })
    dynamicPrivateEnv.env.TYPESAFE_API_KEY = 'env-key'
    // A vendor that answers after 120 ms: too slow for a 40 ms limit, fine for a 5 s one.
    const fetchImpl: TypesafeFetch = (_url, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(jsonResponse(200, OK_BODY)), 120)
        ;(init.signal as AbortSignal).addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new DOMException('x', 'AbortError'))
          },
          { once: true }
        )
      })
    const slow = await judgment(fetchImpl, { lane: 'in_chat' })
    expect(slow.record).toMatchObject({ status: 'unavailable', reason: 'deadline', deadlineHit: true })

    // The user raises the limit: the very next call waits, with no reload of anything.
    setConfig({ inChatWaitMs: 5000 })
    const patient = await judgment(fetchImpl, { lane: 'in_chat' })
    expect(patient.record).toMatchObject({ status: 'ok', deadlineHit: false })
    expect(patient.response?.answers.yes.noul).toBe(0.8)

    // A tool lane with its own budget is not touched by the setting.
    setConfig({ inChatWaitMs: 200 })
    const tool = await judgment(fetchImpl, { deadlineMs: 2000 })
    expect(tool.record).toMatchObject({ status: 'ok', deadlineHit: false })
  })

  it('turns an unavailable outcome into an unavailable record with the reason and deadline state', async () => {
    setConfig({ enabled: true })
    dynamicPrivateEnv.env.TYPESAFE_API_KEY = 'env-key'
    const fetchImpl: TypesafeFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        ;(init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('x', 'AbortError')), {
          once: true
        })
      })
    const result = await judgment(fetchImpl, { deadlineMs: 15 })
    expect(result.response).toBeNull()
    expect(result.record).toMatchObject({ status: 'unavailable', reason: 'deadline', deadlineHit: true, usage: null })
    expect(result.access).toMatchObject({ allowed: true, keySource: 'env' })
  })
})

describe('SA-120 P10a (DL-120-18): judge providers behind the one entry point', () => {
  const ACCOUNT = '0123456789abcdef0123456789abcdef'
  const OLLAMA: JudgeProviderRecord = { id: 'ollama-mac', kind: 'ollama', label: 'Ollama on this Mac', baseUrl: 'http://127.0.0.1:11434', modelId: 'clef-flash' }
  const CLOUDFLARE: JudgeProviderRecord = { id: 'cf', kind: 'cloudflare', label: 'Cloudflare', accountId: ACCOUNT, modelId: 'clef-flash' }
  const LIQUID: JudgeProviderRecord = {
    id: 'liquid',
    kind: 'systemone_url',
    label: 'Liquid AI',
    baseUrl: 'https://api.liquid.ai/decisions',
    modelId: 'lfm2-d1',
    sendsKey: true
  }
  const LM_STUDIO: JudgeProviderRecord = { id: 'lmstudio', kind: 'systemone_url', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234', modelId: 'clef-flash' }
  const ALL = [OLLAMA, CLOUDFLARE, LIQUID, LM_STUDIO]
  const SAVED_KEYS: Record<string, string> = { typesafe: 'ts-key', cloudflare_workers_ai: 'cf-token', systemone_url: 'url-key' }

  type Call = { url: string; init: TypesafeFetchInit }

  /** A fake network for every judge: Ollama's `/api/show` reports `numCtx`, every System One POST answers. */
  function network(options: { numCtx?: number | null } = {}) {
    const calls: Call[] = []
    const fetchImpl = vi.fn<TypesafeFetch>(async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/api/show')) {
        return jsonResponse(200, options.numCtx === null ? { capabilities: ['decision'] } : { capabilities: ['decision'], parameters: `num_ctx ${options.numCtx ?? 16384}` })
      }
      const sent = JSON.parse(String(init.body))
      return jsonResponse(200, { model: sent.model, answers: OK_BODY.answers, usage: OK_BODY.usage })
    })
    const judgeCalls = () => calls.filter((call) => !call.url.endsWith('/api/show'))
    return { calls, fetchImpl, judgeCalls }
  }

  function via(fetchImpl: TypesafeFetch, overrides: Partial<Parameters<typeof runTypesafeJudgment>[0]> = {}) {
    return runTypesafeJudgment({
      userId: 'josh',
      featureId: 'smart_zip',
      featureEnabled: true,
      state: { message: 'hello' },
      questions: { yes: { type: 'noul', instructions: 'Is it friendly?' } },
      fetch: fetchImpl,
      ...overrides
    })
  }

  beforeEach(() => {
    retrieve.mockImplementation(async (service: string) => SAVED_KEYS[service] ?? null)
  })

  it('master OFF: zero calls to ANY judge of ANY kind, as the default or as a feature\'s own choice, and no key is read', async () => {
    const { fetchImpl, calls } = network()
    for (const judgeId of ['typesafe', ...ALL.map((judge) => judge.id)]) {
      for (const lane of JUDGE_LANE_IDS) {
        setConfig({ enabled: false, providers: ALL, defaultProviderId: judgeId, laneProviders: {} })
        const asDefault = await via(fetchImpl, { featureId: lane })
        setConfig({ enabled: false, providers: ALL, defaultProviderId: 'typesafe', laneProviders: { [lane]: judgeId } })
        const asOverride = await via(fetchImpl, { featureId: lane })
        for (const result of [asDefault, asOverride]) {
          expect(result.outcome).toBeNull()
          expect(result.record).toMatchObject({ status: 'unavailable', reason: 'master_off', provider: { id: judgeId } })
        }
      }
    }
    expect(calls).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(retrieve).not.toHaveBeenCalled()
  })

  it.each([
    {
      judge: 'typesafe',
      url: 'https://api.typesafe.ai/v1/systemone',
      authorization: 'Bearer ts-key',
      model: 'jev-1.13.0',
      keyService: 'typesafe',
      showRead: false
    },
    {
      judge: 'ollama-mac',
      url: 'http://127.0.0.1:11434/v1/systemone',
      authorization: null,
      model: 'clef-flash',
      keyService: null,
      showRead: true
    },
    {
      judge: 'cf',
      url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/clef-flash`,
      authorization: 'Bearer cf-token',
      model: 'clef-flash',
      keyService: 'cloudflare_workers_ai',
      showRead: false
    },
    {
      judge: 'liquid',
      url: 'https://api.liquid.ai/decisions/v1/systemone',
      authorization: 'Bearer url-key',
      model: 'lfm2-d1',
      keyService: 'systemone_url',
      showRead: false
    },
    {
      judge: 'lmstudio',
      url: 'http://127.0.0.1:1234/v1/systemone',
      authorization: null,
      model: 'clef-flash',
      keyService: null,
      showRead: false
    }
  ])('$judge: the URL, the auth header, and the same { state, model, questions } body', async (row) => {
    setConfig({ enabled: true, providers: ALL, defaultProviderId: row.judge })
    const { fetchImpl, calls, judgeCalls } = network()
    const result = await via(fetchImpl)
    expect(result.record).toMatchObject({ status: 'ok', model: row.model, provider: { id: row.judge } })
    expect(judgeCalls()).toHaveLength(1)
    const [call] = judgeCalls()
    expect(call.url).toBe(row.url)
    const headers = call.init.headers as Record<string, string>
    if (row.authorization) expect(headers.Authorization).toBe(row.authorization)
    else expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('authorization')
    expect(JSON.parse(String(call.init.body))).toEqual({
      state: { message: 'hello' },
      model: row.model,
      questions: { yes: { type: 'noul', instructions: 'Is it friendly?' } }
    })
    expect(calls.some((entry) => entry.url.endsWith('/api/show'))).toBe(row.showRead)
    if (row.keyService) expect(retrieve).toHaveBeenCalledWith(row.keyService, 'josh')
    else expect(retrieve).not.toHaveBeenCalled()
  })

  it('a feature\'s own judge applies to that feature only; the others keep the default', async () => {
    setConfig({ enabled: true, providers: ALL, defaultProviderId: 'typesafe', laneProviders: { smart_zip: 'ollama-mac' } })
    const { fetchImpl, judgeCalls } = network()
    const zip = await via(fetchImpl, { featureId: 'smart_zip' })
    const check = await via(fetchImpl, { featureId: 'reply_check' })
    expect(judgeCalls().map((call) => call.url)).toEqual(['http://127.0.0.1:11434/v1/systemone', 'https://api.typesafe.ai/v1/systemone'])
    expect(zip.record.provider).toEqual({ id: 'ollama-mac', kind: 'ollama', label: 'Ollama on this Mac' })
    expect(check.record.provider).toEqual({ id: 'typesafe', kind: 'typesafe', label: 'TypeSafe' })
  })

  it('no_provider: a choice naming a judge that is gone, or a judge missing what its kind needs, sends nothing and never falls back', async () => {
    const { fetchImpl } = network()
    setConfig({ enabled: true, providers: ALL, defaultProviderId: 'deleted-judge' })
    const gone = await via(fetchImpl)
    expect(gone.record).toMatchObject({ status: 'unavailable', reason: 'no_provider', model: null })
    expect(gone.record.provider).toBeUndefined()

    setConfig({ providers: [{ ...OLLAMA, baseUrl: undefined }], defaultProviderId: 'ollama-mac' })
    const halfSetUp = await via(fetchImpl)
    expect(halfSetUp.record).toMatchObject({ status: 'unavailable', reason: 'no_provider' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('no_key only for a kind that sends one: Cloudflare without a token is denied, Ollama never needs one', async () => {
    retrieve.mockResolvedValue(null)
    const { fetchImpl, judgeCalls } = network()
    setConfig({ enabled: true, providers: ALL, defaultProviderId: 'cf' })
    const cloud = await via(fetchImpl)
    expect(cloud.record).toMatchObject({ status: 'unavailable', reason: 'no_key', provider: { id: 'cf' } })
    expect(judgeCalls()).toHaveLength(0)

    setConfig({ defaultProviderId: 'ollama-mac' })
    const local = await via(fetchImpl)
    expect(local.access).toMatchObject({ allowed: true, apiKey: null, keySource: null })
    expect(judgeCalls()).toHaveLength(1)
  })

  it('provider_limit: an over-limit request is never sent, never cut, never split, and says which limit', async () => {
    setConfig({ enabled: true, providers: ALL, defaultProviderId: 'ollama-mac' })
    const { fetchImpl, judgeCalls } = network()
    const options = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`o${i}`, `option ${i}`]))
    const questions = { pick: { type: 'choice' as const, instructions: 'Pick one', criteria: options } }
    const before = JSON.stringify(questions)
    const wide = await via(fetchImpl, { questions })
    expect(judgeCalls()).toHaveLength(0)
    expect(JSON.stringify(questions)).toBe(before)
    expect(wide.outcome).toMatchObject({ status: 'unavailable', reason: 'provider_limit', attempts: 0, latencyMs: 0 })
    expect(wide.record).toMatchObject({
      status: 'unavailable',
      reason: 'provider_limit',
      detail: 'a Choice with 30 options; this judge takes at most 26',
      provider: { id: 'ollama-mac' }
    })

    // The same Choice fits TypeSafe (255 options), so a lane routed there sends it unchanged.
    setConfig({ laneProviders: { smart_zip: 'typesafe' } })
    await via(fetchImpl, { questions })
    expect(judgeCalls()).toHaveLength(1)
    expect(JSON.parse(String(judgeCalls()[0].init.body)).questions).toEqual(questions)
  })

  it("believes Ollama's reported num_ctx over the profile: a request too long for 16,384 tokens goes out at 65,536", async () => {
    setConfig({ enabled: true, providers: ALL, defaultProviderId: 'ollama-mac' })
    const state = { message: 'x'.repeat(60_000) }
    const small = network({ numCtx: 16384 })
    const refused = await via(small.fetchImpl, { state })
    expect(refused.record).toMatchObject({ reason: 'provider_limit' })
    expect(refused.record.detail).toMatch(/this judge takes at most 16,384$/)
    expect(small.judgeCalls()).toHaveLength(0)

    __resetOllamaContextCacheForTests()
    const raised = network({ numCtx: 65536 })
    const sent = await via(raised.fetchImpl, { state })
    expect(sent.record).toMatchObject({ status: 'ok' })
    expect(raised.judgeCalls()).toHaveLength(1)

    // No report at all: Batshit's profile for clef-flash (16,384) holds.
    __resetOllamaContextCacheForTests()
    const silent = network({ numCtx: null })
    expect((await via(silent.fetchImpl, { state })).record).toMatchObject({ reason: 'provider_limit' })
  })

  /** An Ollama whose `/api/show` answers after `showMs` (or never) and whose judge answers after `judgeMs`. */
  function slowOllama(showMs: number | null, judgeMs = 0) {
    const calls: Call[] = []
    const fetchImpl: TypesafeFetch = (url, init) =>
      new Promise((resolve, reject) => {
        calls.push({ url, init })
        const wait = url.endsWith('/api/show') ? showMs : judgeMs
        const signal = init.signal as AbortSignal | undefined
        if (wait !== null) {
          setTimeout(() => {
            if (url.endsWith('/api/show')) resolve(jsonResponse(200, { capabilities: ['decision'], parameters: 'num_ctx 16384' }))
            else resolve(jsonResponse(200, { model: 'clef-flash', answers: OK_BODY.answers, usage: OK_BODY.usage }))
          }, wait)
        }
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    const judgeCalls = () => calls.filter((call) => !call.url.endsWith('/api/show'))
    return { calls, fetchImpl, judgeCalls }
  }

  it('round 1, M1: a sleeping Ollama cannot hold an in-chat send past the In-Chat Wait Limit (750 ms)', async () => {
    setConfig({ enabled: true, inChatWaitMs: 750, providers: ALL, defaultProviderId: 'ollama-mac' })
    const { judgeCalls, fetchImpl } = slowOllama(null)
    const started = Date.now()
    const result = await via(fetchImpl, { lane: 'in_chat' })
    const took = Date.now() - started
    // Round 2: no tight window (a loaded machine is slow). It can never end before the limit, and before this fix
    // it ended only at the read's own 4,000 ms ceiling (measured 4,020 ms); well under that is the discriminator.
    expect(took).toBeGreaterThanOrEqual(700)
    expect(took).toBeLessThan(3_000)
    expect(judgeCalls()).toHaveLength(0)
    expect(result.outcome).toMatchObject({ status: 'unavailable', reason: 'deadline', deadlineHit: true, attempts: 0 })
    expect(result.record).toMatchObject({ status: 'unavailable', reason: 'deadline', deadlineHit: true, provider: { id: 'ollama-mac' } })
  })

  it("round 1, M1: the limits read counts against the same deadline as the judge call", async () => {
    // 300 ms to read the limits plus 600 ms for the judge: alone each fits 750 ms, together they do not.
    setConfig({ enabled: true, inChatWaitMs: 750, providers: ALL, defaultProviderId: 'ollama-mac' })
    const { judgeCalls, fetchImpl } = slowOllama(300, 600)
    const result = await via(fetchImpl, { lane: 'in_chat' })
    expect(judgeCalls()).toHaveLength(1)
    expect(result.record).toMatchObject({ status: 'unavailable', reason: 'deadline', deadlineHit: true })

    // The same pair under a 1,500 ms limit answers, and its latency includes the read.
    __resetOllamaContextCacheForTests()
    setConfig({ inChatWaitMs: 1_500 })
    const patient = await via(slowOllama(300, 200).fetchImpl, { lane: 'in_chat' })
    expect(patient.record).toMatchObject({ status: 'ok' })
    expect(patient.record.latencyMs).toBeGreaterThanOrEqual(480)
  })

  it('round 1, M1: Stop (the lane signal) ends the limits read at once, with no judge call', async () => {
    setConfig({ enabled: true, providers: ALL, defaultProviderId: 'ollama-mac' })
    const { judgeCalls, fetchImpl } = slowOllama(null)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)
    const started = Date.now()
    const result = await via(fetchImpl, { signal: controller.signal, deadlineMs: 15_000 })
    // Well under the read's own 4,000 ms ceiling, which is where it ended before the fix.
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(judgeCalls()).toHaveLength(0)
    expect(result.record).toMatchObject({ status: 'unavailable', reason: 'aborted', deadlineHit: false })
  })

  it('round 1, M1: parallel lanes share one limits read', async () => {
    setConfig({ enabled: true, providers: ALL, defaultProviderId: 'ollama-mac' })
    const { calls, fetchImpl } = slowOllama(40)
    await Promise.all([via(fetchImpl, { featureId: 'smart_zip' }), via(fetchImpl, { featureId: 'reply_check' }), via(fetchImpl, { featureId: 'style_coach' })])
    expect(calls.filter((call) => call.url.endsWith('/api/show'))).toHaveLength(1)
    expect(calls.filter((call) => call.url.endsWith('/v1/systemone'))).toHaveLength(3)
  })

  it('round 2: a stop before a judge that reads nothing says so plainly, never that limits were being read', async () => {
    setConfig({ enabled: true, providers: ALL, defaultProviderId: 'typesafe' })
    const { fetchImpl } = network()
    const stopped = new AbortController()
    stopped.abort()
    const cancelled = await via(fetchImpl, { signal: stopped.signal })
    expect(cancelled.record).toMatchObject({ reason: 'aborted', detail: 'the call was cancelled before it started' })
    const late = await via(fetchImpl, { deadlineMs: 0 })
    expect(late.record).toMatchObject({ reason: 'deadline', detail: 'the deadline had passed before the call' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('round 1, M2 + S5: a damaged stored choice denies with no_provider and the row keeps the chosen id, never Jev', async () => {
    const { fetchImpl } = network()
    setConfig({ enabled: true, providers: ALL, defaultProviderId: UNREADABLE_JUDGE_CHOICE, laneProviders: {} })
    const damaged = await via(fetchImpl)
    expect(damaged.record).toMatchObject({ status: 'unavailable', reason: 'no_provider', model: null, chosenProviderId: UNREADABLE_JUDGE_CHOICE })
    expect(damaged.record.provider).toBeUndefined()

    setConfig({ defaultProviderId: 'typesafe', laneProviders: { smart_zip: 'deleted-judge' } })
    const gone = await via(fetchImpl, { featureId: 'smart_zip' })
    expect(gone.record).toMatchObject({ reason: 'no_provider', chosenProviderId: 'deleted-judge' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
