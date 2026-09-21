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

import { createTypesafeClient, type TypesafeFetch } from '../typesafeClient'
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
  setConfig({ enabled: false, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750 })
  retrieve.mockResolvedValue(null)
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
