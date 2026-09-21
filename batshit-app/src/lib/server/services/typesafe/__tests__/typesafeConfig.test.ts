import { beforeEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  DEFAULT_TYPESAFE_CONFIG,
  getTypesafeConfig,
  normalizeStoredTypesafeConfig,
  setTypesafeConfig,
  validateTypesafeConfigInput
} from '../typesafeConfig'
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
