import { describe, expect, it } from 'vitest'
import { calculateZipActivation } from './zipActivation'
import { liveSnapshotFromFact, liveSnapshotTokens, snapshotCompressesCopy, snapshotHasSize, withLiveSnapshotSize } from './zipLiveSnapshot'

describe('zipLiveSnapshot (SA-137 P4)', () => {
  it('takes a snapshot from a refreshed fact only', () => {
    expect(liveSnapshotFromFact({ status: 'refreshed', promptTokens: 17_000, delivery: 'issued' })).toEqual({
      delivery: 'issued',
      promptTokens: 17_000
    })
    expect(liveSnapshotFromFact({ status: 'static', reason: 'file-unreadable', delivery: 'issued' })).toBeNull()
    expect(liveSnapshotFromFact(null)).toBeNull()
    expect(liveSnapshotFromFact(undefined)).toBeNull()
  })

  it('hands activation the snapshot size in every field it reads, and the stored zip data back untouched without one', () => {
    const stored = { tokens: 40, promptTokens: 40, metadata: { tokens: 40, toolName: 'read_file', tokenBasis: 'ai_expanded' } }
    expect(withLiveSnapshotSize(stored, null)).toBe(stored)
    const sized = withLiveSnapshotSize(stored, { delivery: 'prepared', promptTokens: 17_000 })
    expect(sized).toEqual({
      tokens: 17_000,
      promptTokens: 17_000,
      aiTokens: 17_000,
      metadata: { tokens: 17_000, promptTokens: 17_000, aiTokens: 17_000, toolName: 'read_file', tokenBasis: 'ai_expanded' }
    })
    // The stored copy is never rewritten.
    expect(stored.tokens).toBe(40)
    expect(stored.metadata.tokens).toBe(40)
    expect(withLiveSnapshotSize(null, { delivery: 'issued', promptTokens: 12 })).toMatchObject({ tokens: 12, metadata: { promptTokens: 12 } })
  })

  it('makes the size guard judge the size the newest reply saw (large at 10,000, too large at 25,000)', () => {
    const stored = { type: 'cool_tool', tokens: 40, metadata: { toolName: 'read_file', tokens: 40, promptTokens: 40 } }
    const base = { zipType: 'cool_tool', messagesFromEnd: 0, toolName: 'read_file', fallbackTokens: 40 }
    expect(calculateZipActivation({ ...base, zipData: stored }).sizeGuard).toBeNull()

    const large = calculateZipActivation({
      ...base,
      zipData: withLiveSnapshotSize(stored, { delivery: 'issued', promptTokens: 17_000 }),
      fallbackTokens: 17_000
    })
    expect(large).toMatchObject({ sizeGuard: 'large', shouldCompress: true, tokens: 17_000 })

    const tooLarge = calculateZipActivation({
      ...base,
      zipData: withLiveSnapshotSize(stored, { delivery: 'issued', promptTokens: 30_000 }),
      fallbackTokens: 30_000
    })
    expect(tooLarge).toMatchObject({ sizeGuard: 'too_large', shouldCompress: true, tokens: 30_000 })
  })
})

describe('an unknown copy (SA-137 P4 review M1)', () => {
  it('is an unknown snapshot that keeps the stored size', () => {
    const snapshot = liveSnapshotFromFact({ status: 'unknown', delivery: null })
    expect(snapshot).toEqual({ delivery: 'unknown' })
    const stored = { tokens: 40, metadata: { promptTokens: 40 } }
    expect(withLiveSnapshotSize(stored, snapshot)).toBe(stored)
    expect(liveSnapshotTokens(snapshot)).toBeUndefined()
    expect(liveSnapshotTokens({ delivery: 'issued', promptTokens: 9 })).toBe(9)
  })
})

describe('a copy the newest reply did not refresh (SA-137 Round 2, strict freshness)', () => {
  const stat = (extra: Record<string, unknown> = {}) =>
    ({ status: 'static', reason: 'not-readable', delivery: 'issued', ...extra }) as Parameters<typeof liveSnapshotFromFact>[0]

  it('is a not-refreshed snapshot only from a static fact of a current, strict receipt', () => {
    expect(liveSnapshotFromFact(stat({ strict: true }))).toEqual({ delivery: 'not-refreshed', reason: 'not-readable' })
    // Prepared (no model request seen) is still a current receipt.
    expect(liveSnapshotFromFact(stat({ strict: true, delivery: 'prepared' }))).toEqual({ delivery: 'not-refreshed', reason: 'not-readable' })
  })

  it('is nothing from a static fact without strict (today\'s behavior: the stored state)', () => {
    expect(liveSnapshotFromFact(stat())).toBeNull()
    expect(liveSnapshotFromFact(stat({ strict: false }))).toBeNull()
  })

  it('is nothing when the receipt is not current, even if strict were claimed', () => {
    expect(liveSnapshotFromFact(stat({ strict: true, delivery: null }))).toBeNull()
  })

  it('never makes a refreshed or unknown fact not-refreshed', () => {
    expect(liveSnapshotFromFact({ status: 'refreshed', promptTokens: 9, delivery: 'issued', strict: true })).toEqual({ delivery: 'issued', promptTokens: 9 })
    expect(liveSnapshotFromFact({ status: 'unknown', delivery: null, strict: true })).toEqual({ delivery: 'unknown' })
  })

  it('compresses the copy whatever its buffer, hold or Off says, and only this kind does', () => {
    expect(snapshotCompressesCopy({ delivery: 'not-refreshed', reason: 'deadline' })).toBe(true)
    expect(snapshotCompressesCopy({ delivery: 'issued', promptTokens: 9 })).toBe(false)
    expect(snapshotCompressesCopy({ delivery: 'unknown' })).toBe(false)
    expect(snapshotCompressesCopy(null)).toBe(false)
    expect(snapshotCompressesCopy(undefined)).toBe(false)
  })

  it('carries no size: activation keeps the stored zip data and the badge has no snapshot tokens', () => {
    const snapshot = liveSnapshotFromFact(stat({ strict: true }))
    const stored = { tokens: 40, metadata: { promptTokens: 40 } }
    expect(withLiveSnapshotSize(stored, snapshot)).toBe(stored)
    expect(liveSnapshotTokens(snapshot)).toBeUndefined()
    expect(snapshotHasSize(snapshot)).toBe(false)
    expect(snapshotHasSize({ delivery: 'prepared', promptTokens: 5 })).toBe(true)
  })
})
