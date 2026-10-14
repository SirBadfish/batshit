import { describe, expect, it } from 'vitest'
import { calculateZipActivation, type ZipActivationOptions } from './zipActivation'

const normal = { buffer_size_read_file: 8, zip_threshold_read_file: 0, auto_zip_read_file: false }
const run = (tokens: number, options: Partial<ZipActivationOptions> = {}) => calculateZipActivation({
  zipType: 'cool_tool', messagesFromEnd: 0,
  zipData: { tokens, metadata: { operationKind: 'read_file', promptTokens: tokens } },
  agentSettings: normal, ...options
})

describe('BL-494 size guard precedence', () => {
  it.each([9999, 10000, 24999, 25000])('pins the boundary at %i prompt tokens', (tokens) => {
    expect(run(tokens)).toMatchObject({
      shouldCompress: tokens >= 10000,
      sizeGuard: tokens >= 25000 ? 'too_large' : tokens >= 10000 ? 'large' : null
    })
  })

  it('row 1: too large beats Off, all Hold sources, rezip, dead copy and recovery', () => {
    for (const isUnzipped of [false, true]) {
      for (const isInferredUnzipped of [false, true]) {
        expect(run(25000, {
          agentSettings: { ...normal, zip_disabled_read_file: true },
          isUnzipped, isInferredUnzipped, isUserUnzipped: true, isRezipped: true,
          recoveryHold: true, deadCopy: { reason: 'stale', repliesUntilDead: 0 }
        })).toMatchObject({ shouldCompress: true, sizeGuard: 'too_large', deadCopy: null })
      }
    }
  })

  it('row 2: Off opens large results even with rezip or dead-copy state', () => {
    expect(run(24999, {
      agentSettings: { ...normal, zip_disabled_read_file: true },
      isRezipped: true, deadCopy: { reason: 'stale', repliesUntilDead: 0 }
    })).toMatchObject({ shouldCompress: false, sizeGuard: null, deadCopy: null })
  })

  it('row 3: a rezip beats an explicit Hold and recovery', () => {
    expect(run(9999, { isRezipped: true, isUnzipped: true, isUserUnzipped: true, recoveryHold: true }))
      .toMatchObject({ shouldCompress: true, sizeGuard: null })
  })

  it('row 4: only the user Hold opens a dead copy', () => {
    const deadCopy = { reason: 'superseded' as const, repliesUntilDead: 0 }
    expect(run(20000, { deadCopy, isUnzipped: true, isUserUnzipped: true }))
      .toMatchObject({ shouldCompress: false, sizeGuard: null })
    expect(run(20000, { deadCopy, isUnzipped: true, recoveryHold: true }))
      .toMatchObject({ shouldCompress: true, deadCopy: 'superseded' })
  })

  it('row 5: explicit user and agent Holds open large results', () => {
    for (const isUserUnzipped of [false, true]) {
      expect(run(24999, {
        isUnzipped: true, isUserUnzipped, messagesFromEnd: 100,
        agentSettings: { ...normal, auto_zip_read_file: true }
      })).toMatchObject({ shouldCompress: false, sizeGuard: null })
    }
  })

  it('row 6: large beats recovery, buffer, threshold and inferred opens', () => {
    expect(run(10000, {
      isUnzipped: true, isInferredUnzipped: true, recoveryHold: true,
      agentSettings: { ...normal, zip_threshold_read_file: 1000000 }
    })).toMatchObject({ shouldCompress: true, sizeGuard: 'large' })
    expect(run(10000, { recoveryHold: true })).toMatchObject({ shouldCompress: true, sizeGuard: 'large' })
  })

  it('row 7: ordinary recovery, Auto and Normal keep their order', () => {
    expect(run(9999, { agentSettings: { ...normal, auto_zip_read_file: true }, recoveryHold: true }).shouldCompress).toBe(false)
    expect(run(9999, { agentSettings: { ...normal, auto_zip_read_file: true } }).shouldCompress).toBe(true)
    expect(run(9999, { messagesFromEnd: 7 }).shouldCompress).toBe(false)
    expect(run(9999, { messagesFromEnd: 8 }).shouldCompress).toBe(true)
    expect(run(9999, { messagesFromEnd: 8, agentSettings: { ...normal, zip_threshold_read_file: 10000 } }).shouldCompress).toBe(false)
  })

  it('uses prompt size over storage size and ignores either old stamp value', () => {
    expect(run(0, { zipData: { tokens: 100000, metadata: { operationKind: 'read_file', promptTokens: 9999, forceCompress: true } } }))
      .toMatchObject({ shouldCompress: false, tokens: 9999, sizeGuard: null })
    expect(run(0, { zipData: { tokens: 1, metadata: { operationKind: 'read_file', promptTokens: 25000, forceCompress: false } } }))
      .toMatchObject({ shouldCompress: true, tokens: 25000, sizeGuard: 'too_large' })
  })

  it('does not reinterpret non-tool zip policies', () => {
    expect(run(50000, { zipType: 'error', agentSettings: { zip_disabled_error: true } }))
      .toMatchObject({ shouldCompress: false, sizeGuard: null })
  })

  it('reads top-level prompt estimates accepted by token enrichment', () => {
    expect(run(0, { zipData: { tokens: 1, promptTokens: 25000, metadata: { operationKind: 'read_file' } } }))
      .toMatchObject({ shouldCompress: true, tokens: 25000, sizeGuard: 'too_large' })
  })

  it('skips invalid legacy prompt estimates and recognizes metadata-only prompt basis', () => {
    expect(run(0, { zipData: { tokens: 1, promptTokens: 0, aiTokens: 25000, metadata: { operationKind: 'read_file' } } }))
      .toMatchObject({ shouldCompress: true, tokens: 25000, sizeGuard: 'too_large' })
    expect(run(0, { zipData: { metadata: { operationKind: 'read_file', tokenBasis: 'ai_expanded', tokens: 25000 } } }))
      .toMatchObject({ shouldCompress: true, tokens: 25000, sizeGuard: 'too_large' })
  })
})
