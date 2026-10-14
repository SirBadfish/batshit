import { beforeEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  DEFAULT_TYPESAFE_CONFIG,
  getTypesafeConfig,
  normalizeStoredTypesafeConfig,
  setTypesafeConfig,
  TypesafeConfigValidationError,
  validateTypesafeConfigInput
} from '../typesafeConfig'
import { resolveJudgeProviderForLane, UNREADABLE_JUDGE_CHOICE } from '$lib/utils/judgeProviders'
import {
  TYPESAFE_CONFIG_KEY,
  TYPESAFE_DEFAULT_IN_CHAT_WAIT_MS,
  TYPESAFE_IN_CHAT_WAIT_MAX_MS,
  TYPESAFE_IN_CHAT_WAIT_MIN_MS
} from '../typesafe.constants'

/**
 * SA-120 P0 — the instance config record. Read side is tolerant (a corrupt stored
 * value can never throw into a send); write side is strict (DL-120-08: pinned ids only).
 * Real RedisJSON under `npm run test:redis`, the in-memory fake under plain `npm test`.
 */

useRedisTestServer()

describe('normalizeStoredTypesafeConfig', () => {
  it('reads the defaults when nothing is stored: master OFF, pinned model, 5 s attempt timeout', () => {
    expect(normalizeStoredTypesafeConfig(null)).toEqual(DEFAULT_TYPESAFE_CONFIG)
    expect(DEFAULT_TYPESAFE_CONFIG.enabled).toBe(false)
  })

  it('falls back per field when a stored value is invalid, without touching valid siblings', () => {
    const config = normalizeStoredTypesafeConfig({
      enabled: true,
      modelId: 'jev-latest',
      attemptTimeoutMs: 0,
      updatedAt: '2026-09-16T00:00:00.000Z'
    })
    expect(config).toEqual({
      enabled: true,
      modelId: DEFAULT_TYPESAFE_CONFIG.modelId,
      attemptTimeoutMs: DEFAULT_TYPESAFE_CONFIG.attemptTimeoutMs,
      inChatWaitMs: DEFAULT_TYPESAFE_CONFIG.inChatWaitMs,
      screenIncomingText: false,
      providers: [],
      defaultProviderId: 'typesafe',
      laneProviders: {},
      updatedAt: '2026-09-16T00:00:00.000Z'
    })
  })

  it('SA-120 P8 (LS-059): the In-Chat Wait Limit defaults to the 750 ms the lanes always had, and a record from before P8 reads the same', () => {
    expect(TYPESAFE_DEFAULT_IN_CHAT_WAIT_MS).toBe(750)
    expect(DEFAULT_TYPESAFE_CONFIG.inChatWaitMs).toBe(750)
    expect(normalizeStoredTypesafeConfig({ enabled: true, attemptTimeoutMs: 5000 }).inChatWaitMs).toBe(750)
    expect(normalizeStoredTypesafeConfig({ inChatWaitMs: 5000 }).inChatWaitMs).toBe(5000)
    // Invalid stored values read as the default and never touch their siblings (a send can never throw on config).
    for (const value of ['5000', 199, 30001, 750.5, null, {}]) {
      const config = normalizeStoredTypesafeConfig({ enabled: true, attemptTimeoutMs: 1500, inChatWaitMs: value })
      expect(config.inChatWaitMs).toBe(750)
      expect(config).toMatchObject({ enabled: true, attemptTimeoutMs: 1500 })
    }
    // The bounds themselves are valid, at the boundary.
    expect(normalizeStoredTypesafeConfig({ inChatWaitMs: TYPESAFE_IN_CHAT_WAIT_MIN_MS }).inChatWaitMs).toBe(200)
    expect(normalizeStoredTypesafeConfig({ inChatWaitMs: TYPESAFE_IN_CHAT_WAIT_MAX_MS }).inChatWaitMs).toBe(30000)
  })

  it('reads the P7 switch as ON only for a stored `true` (LS-057); a record from before P7 reads OFF', () => {
    expect(DEFAULT_TYPESAFE_CONFIG.screenIncomingText).toBe(false)
    expect(normalizeStoredTypesafeConfig({ enabled: true }).screenIncomingText).toBe(false)
    expect(normalizeStoredTypesafeConfig({ screenIncomingText: true }).screenIncomingText).toBe(true)
    for (const value of ['true', 1, {}, null]) {
      expect(normalizeStoredTypesafeConfig({ screenIncomingText: value }).screenIncomingText).toBe(false)
    }
    // The feature switch can never turn the master switch on by itself.
    expect(normalizeStoredTypesafeConfig({ screenIncomingText: true }).enabled).toBe(false)
  })

  it('never reads a non-boolean enabled as ON', () => {
    expect(normalizeStoredTypesafeConfig({ enabled: 'true' }).enabled).toBe(false)
    expect(normalizeStoredTypesafeConfig({ enabled: 1 }).enabled).toBe(false)
  })
})

describe('validateTypesafeConfigInput', () => {
  it('refuses jev-latest and any non-pinned model id', () => {
    expect(validateTypesafeConfigInput({ modelId: 'jev-latest' })).toMatchObject({ ok: false })
    expect(validateTypesafeConfigInput({ modelId: 'gpt-4' })).toMatchObject({ ok: false })
    expect(validateTypesafeConfigInput({ modelId: ' jev-1.14 ' })).toEqual({ ok: true, value: { modelId: 'jev-1.14' } })
  })

  it('refuses timeouts outside 500-30000 ms and non-integers', () => {
    expect(validateTypesafeConfigInput({ attemptTimeoutMs: 100 })).toMatchObject({ ok: false })
    expect(validateTypesafeConfigInput({ attemptTimeoutMs: 30001 })).toMatchObject({ ok: false })
    expect(validateTypesafeConfigInput({ attemptTimeoutMs: 1500.5 })).toMatchObject({ ok: false })
    expect(validateTypesafeConfigInput({ attemptTimeoutMs: 1500 })).toEqual({ ok: true, value: { attemptTimeoutMs: 1500 } })
  })

  it('refuses a non-boolean enabled and a non-object body', () => {
    expect(validateTypesafeConfigInput({ enabled: 'yes' })).toMatchObject({ ok: false })
    expect(validateTypesafeConfigInput('nope')).toMatchObject({ ok: false })
  })
})

describe('validateTypesafeConfigInput: the P8 In-Chat Wait Limit', () => {
  it('accepts a whole number of ms from 200 to 30,000, at the boundaries, and refuses the rest by the label the user sees', () => {
    expect(validateTypesafeConfigInput({ inChatWaitMs: 200 })).toEqual({ ok: true, value: { inChatWaitMs: 200 } })
    expect(validateTypesafeConfigInput({ inChatWaitMs: 30000 })).toEqual({ ok: true, value: { inChatWaitMs: 30000 } })
    expect(validateTypesafeConfigInput({ inChatWaitMs: 5000 })).toEqual({ ok: true, value: { inChatWaitMs: 5000 } })
    for (const value of [199, 30001, 750.5, '750', null, true]) {
      expect(validateTypesafeConfigInput({ inChatWaitMs: value })).toEqual({
        ok: false,
        error: '"In-Chat Wait Limit" must be a whole number of milliseconds from 200 to 30000.'
      })
    }
    // An absent field is left alone, so a client from before P8 cannot reset it by omission.
    expect(validateTypesafeConfigInput({ attemptTimeoutMs: 1500 })).toEqual({ ok: true, value: { attemptTimeoutMs: 1500 } })
  })
})

describe('validateTypesafeConfigInput: the P7 switch', () => {
  it('accepts a boolean and refuses anything else, naming the switch the user sees', () => {
    expect(validateTypesafeConfigInput({ screenIncomingText: true })).toEqual({
      ok: true,
      value: { screenIncomingText: true }
    })
    expect(validateTypesafeConfigInput({ screenIncomingText: false })).toEqual({
      ok: true,
      value: { screenIncomingText: false }
    })
    expect(validateTypesafeConfigInput({ screenIncomingText: 'yes' })).toEqual({
      ok: false,
      error: '"Screen Incoming Text" must be true or false.'
    })
    // An absent field is left alone, so an old client cannot switch it off by omission.
    expect(validateTypesafeConfigInput({ enabled: true })).toEqual({ ok: true, value: { enabled: true } })
  })
})

describe('get/setTypesafeConfig', () => {
  it('keeps the P7 switch when another field is patched, and the master switch when it is', async () => {
    await setTypesafeConfig({ enabled: true, screenIncomingText: true })
    await setTypesafeConfig({ attemptTimeoutMs: 1500 })
    expect(await getTypesafeConfig()).toMatchObject({ enabled: true, screenIncomingText: true, attemptTimeoutMs: 1500 })
    await setTypesafeConfig({ screenIncomingText: false })
    expect(await getTypesafeConfig()).toMatchObject({ enabled: true, screenIncomingText: false })
    const stored = (await redis.json.get(TYPESAFE_CONFIG_KEY)) as Record<string, unknown>
    expect(stored.screenIncomingText).toBe(false)
  })

  it('SA-120 P8: stores the In-Chat Wait Limit, keeps it across other patches, and refuses an out-of-range one loudly', async () => {
    await setTypesafeConfig({ enabled: true, inChatWaitMs: 5000 })
    await setTypesafeConfig({ attemptTimeoutMs: 1500 })
    expect(await getTypesafeConfig()).toMatchObject({ enabled: true, inChatWaitMs: 5000, attemptTimeoutMs: 1500 })
    const stored = (await redis.json.get(TYPESAFE_CONFIG_KEY)) as Record<string, unknown>
    expect(stored.inChatWaitMs).toBe(5000)
    await expect(setTypesafeConfig({ inChatWaitMs: 100 })).rejects.toThrow(/In-Chat Wait Limit/)
    expect((await getTypesafeConfig()).inChatWaitMs).toBe(5000)
  })

  beforeEach(async () => {
    await redis.del(TYPESAFE_CONFIG_KEY)
  })

  it('round-trips a patch and stamps updatedAt', async () => {
    await expect(getTypesafeConfig()).resolves.toEqual(DEFAULT_TYPESAFE_CONFIG)
    const saved = await setTypesafeConfig({ enabled: true, attemptTimeoutMs: 2000 })
    expect(saved).toMatchObject({ enabled: true, modelId: DEFAULT_TYPESAFE_CONFIG.modelId, attemptTimeoutMs: 2000 })
    expect(typeof saved.updatedAt).toBe('string')
    await expect(getTypesafeConfig()).resolves.toEqual(saved)
  })

  it('refuses an invalid patch and leaves the stored record alone', async () => {
    await setTypesafeConfig({ enabled: true })
    await expect(setTypesafeConfig({ modelId: 'jev-latest' })).rejects.toThrow(/pinned/)
    await expect(getTypesafeConfig()).resolves.toMatchObject({ enabled: true, modelId: DEFAULT_TYPESAFE_CONFIG.modelId })
  })
})

/**
 * SA-120 P10a (DL-120-18) — judge providers on the same record. The record-shape tolerance case is FIRST and named
 * for the reviewer: a record written before P10a reads as the built-in TypeSafe judge only, with nothing to save.
 */
describe('SA-120 P10a: judges on batshit:typesafe_config', () => {
  const OLLAMA = { id: 'ollama-mac', kind: 'ollama', label: 'Ollama on this Mac', baseUrl: 'http://127.0.0.1:11434', modelId: 'clef-flash' } as const
  const CLOUDFLARE = { id: 'cf', kind: 'cloudflare', label: 'Cloudflare', accountId: '0123456789abcdef0123456789abcdef', modelId: 'clef' } as const

  beforeEach(async () => {
    await redis.del(TYPESAFE_CONFIG_KEY)
  })

  it('RECORD-SHAPE TOLERANCE: a record written before P10a reads as TypeSafe only (no judges, default typesafe, no choices)', async () => {
    // Exactly the shape P8 wrote (every field it had), stored on the real record.
    const preP10a = {
      enabled: true,
      modelId: 'jev-1.13.0',
      attemptTimeoutMs: 5000,
      inChatWaitMs: 1250,
      screenIncomingText: true,
      updatedAt: '2026-10-01T12:00:00.000Z'
    }
    await redis.json.set(TYPESAFE_CONFIG_KEY, '$', preP10a as never)
    const read = await getTypesafeConfig()
    expect(read).toEqual({ ...preP10a, providers: [], defaultProviderId: 'typesafe', laneProviders: {} })
    // Reading wrote nothing: the stored record is byte-for-byte what P8 left.
    expect(await redis.json.get(TYPESAFE_CONFIG_KEY)).toEqual(preP10a)
  })

  it('stores the judges, the default, and the choices, and a patch naming only the master switch keeps them all', async () => {
    await setTypesafeConfig({
      providers: [OLLAMA, CLOUDFLARE] as never,
      defaultProviderId: 'ollama-mac',
      laneProviders: { untrusted_text: 'cf' }
    })
    await setTypesafeConfig({ enabled: true })
    const read = await getTypesafeConfig()
    expect(read).toMatchObject({
      enabled: true,
      providers: [OLLAMA, CLOUDFLARE],
      defaultProviderId: 'ollama-mac',
      laneProviders: { untrusted_text: 'cf' }
    })
    const stored = (await redis.json.get(TYPESAFE_CONFIG_KEY)) as Record<string, unknown>
    expect(stored.providers).toEqual([OLLAMA, CLOUDFLARE])
    // No key ever lands on this record.
    expect(JSON.stringify(stored)).not.toMatch(/apiKey|token|secret/i)
  })

  it('refuses a save whose default or feature choice names a judge it does not hold, and writes nothing', async () => {
    await setTypesafeConfig({ providers: [OLLAMA] as never, defaultProviderId: 'ollama-mac', laneProviders: { smart_zip: 'ollama-mac' } })
    const before = await redis.json.get(TYPESAFE_CONFIG_KEY)
    // Removing the judge without moving the choices that name it.
    await expect(setTypesafeConfig({ providers: [] })).rejects.toBeInstanceOf(TypesafeConfigValidationError)
    await expect(setTypesafeConfig({ providers: [] })).rejects.toThrow(/default, smart_zip/)
    await expect(setTypesafeConfig({ laneProviders: { reply_check: 'nobody' } })).rejects.toThrow(/reply_check/)
    expect(await redis.json.get(TYPESAFE_CONFIG_KEY)).toEqual(before)
    // Moving them in the same save is accepted.
    await setTypesafeConfig({ providers: [], defaultProviderId: 'typesafe', laneProviders: {} })
    expect(await getTypesafeConfig()).toMatchObject({ providers: [], defaultProviderId: 'typesafe', laneProviders: {} })
  })

  it('reads a stored invalid judge as absent and KEEPS the choice that named it (it then denies, never reroutes)', () => {
    const read = normalizeStoredTypesafeConfig({
      providers: [OLLAMA, { ...CLOUDFLARE, accountId: 'nope' }],
      defaultProviderId: 'cf',
      laneProviders: { smart_zip: 'ollama-mac', bogus: 'cf' }
    })
    expect(read.providers).toEqual([OLLAMA])
    expect(read.defaultProviderId).toBe('cf')
    expect(read.laneProviders).toEqual({ smart_zip: 'ollama-mac' })
  })

  it('round 1, M2: a PRESENT but damaged default or lane value names no judge and denies; only an absent default is TypeSafe', async () => {
    for (const damaged of [42, '', null, 'Not An Id']) {
      expect(normalizeStoredTypesafeConfig({ defaultProviderId: damaged }).defaultProviderId).toBe(UNREADABLE_JUDGE_CHOICE)
    }
    expect(normalizeStoredTypesafeConfig({ enabled: true }).defaultProviderId).toBe('typesafe')
    // A restored record whose default named a local judge with a damaged id: every lane denies, none goes to TypeSafe.
    await redis.json.set(TYPESAFE_CONFIG_KEY, '$', { enabled: true, providers: [OLLAMA], defaultProviderId: 7, laneProviders: { judge_ask: false } } as never)
    const read = await getTypesafeConfig()
    expect(read.defaultProviderId).toBe(UNREADABLE_JUDGE_CHOICE)
    expect(read.laneProviders).toEqual({ judge_ask: UNREADABLE_JUDGE_CHOICE })
    expect(resolveJudgeProviderForLane(read, 'smart_zip').provider).toBeNull()
    expect(resolveJudgeProviderForLane(read, 'judge_ask').provider).toBeNull()
  })

  it('round 1, S3: a damaged stored choice never blocks switching Judge Juice off, and still denies afterwards', async () => {
    await redis.json.set(TYPESAFE_CONFIG_KEY, '$', {
      enabled: true,
      providers: [OLLAMA],
      defaultProviderId: 'gone-judge',
      laneProviders: { smart_zip: 12 }
    } as never)
    const saved = await setTypesafeConfig({ enabled: false })
    expect(saved).toMatchObject({ enabled: false, defaultProviderId: 'gone-judge', laneProviders: { smart_zip: UNREADABLE_JUDGE_CHOICE } })
    // The card sends its whole draft back, broken choices included: still accepted, because the save creates none.
    await setTypesafeConfig({ inChatWaitMs: 900, defaultProviderId: 'gone-judge', laneProviders: { smart_zip: UNREADABLE_JUDGE_CHOICE } })
    const read = await getTypesafeConfig()
    expect(read).toMatchObject({ enabled: false, inChatWaitMs: 900 })
    expect(resolveJudgeProviderForLane(read, 'reply_check').provider).toBeNull()
    expect(resolveJudgeProviderForLane(read, 'smart_zip').provider).toBeNull()
    // Creating a NEW broken choice is still refused.
    await expect(setTypesafeConfig({ laneProviders: { smart_zip: UNREADABLE_JUDGE_CHOICE, reply_check: 'nobody' } })).rejects.toThrow(/reply_check/)
  })

  it('validates every new field on the write side', () => {
    expect(validateTypesafeConfigInput({ providers: [OLLAMA] })).toEqual({ ok: true, value: { providers: [OLLAMA] } })
    expect(validateTypesafeConfigInput({ providers: [{ ...OLLAMA, kind: 'openai' }] })).toMatchObject({ ok: false })
    expect(validateTypesafeConfigInput({ providers: {} })).toMatchObject({ ok: false, error: '`providers` must be a list.' })
    expect(validateTypesafeConfigInput({ defaultProviderId: 'ollama-mac' })).toEqual({ ok: true, value: { defaultProviderId: 'ollama-mac' } })
    expect(validateTypesafeConfigInput({ defaultProviderId: '' })).toMatchObject({ ok: false })
    expect(validateTypesafeConfigInput({ defaultProviderId: 'Not An Id' })).toMatchObject({ ok: false })
    expect(validateTypesafeConfigInput({ laneProviders: { smart_zip: 'cf', reply_check: null } })).toEqual({
      ok: true,
      value: { laneProviders: { smart_zip: 'cf' } }
    })
    expect(validateTypesafeConfigInput({ laneProviders: { not_a_lane: 'cf' } })).toMatchObject({ ok: false })
  })

  it('the default read hands out fresh lists, so changing one read never changes the next', async () => {
    const first = await getTypesafeConfig()
    first.providers.push(OLLAMA as never)
    first.laneProviders.smart_zip = 'ollama-mac'
    const second = await getTypesafeConfig()
    expect(second.providers).toEqual([])
    expect(second.laneProviders).toEqual({})
    expect(DEFAULT_TYPESAFE_CONFIG.providers).toEqual([])
  })
})
