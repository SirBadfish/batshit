import { describe, expect, it } from 'vitest'
import {
  buildMeasuredMessagePerformance,
  buildMessagePerformanceFromSteps,
} from '$lib/server/services/messagePerformance'
import {
  computeCacheHitRatePercent,
  computeSessionCacheAggregate,
  formatCacheHitRatePercent,
} from '$lib/utils/cacheHitRate'

describe('buildMessagePerformanceFromSteps (SA-093 P7)', () => {
  it('returns null when steps carry no performance data (honest unknown)', () => {
    expect(buildMessagePerformanceFromSteps([])).toBeNull()
    expect(buildMessagePerformanceFromSteps([{ usage: { inputTokens: 10 } }])).toBeNull()
  })

  it('extracts TTFT from the first call and tokens/sec from the final call', () => {
    const metadata = buildMessagePerformanceFromSteps([
      {
        performance: {
          timeToFirstOutputMs: 412.6,
          outputTokensPerSecond: 55.31,
          responseTimeMs: 1200,
        },
      },
      {
        performance: {
          timeToFirstOutputMs: 190,
          outputTokensPerSecond: 88.46,
          responseTimeMs: 2400,
        },
      },
    ])
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      source: 'ai-sdk',
      timeToFirstOutputMs: 413,
      outputTokensPerSecond: 88.5,
      responseTimeMs: 3600,
      modelCalls: 2,
    })
  })

  it('falls back to effective tokens/sec for non-streaming final steps', () => {
    const metadata = buildMessagePerformanceFromSteps([
      {
        performance: {
          effectiveOutputTokensPerSecond: 40.24,
          responseTimeMs: 900,
        },
      },
    ])
    expect(metadata?.outputTokensPerSecond).toBe(40.2)
    expect(metadata?.timeToFirstOutputMs).toBeUndefined()
  })
})

describe('buildMeasuredMessagePerformance (SA-093 P7, managed CLI lanes)', () => {
  it('computes TTFT, model time minus tool windows, and tokens/sec', () => {
    const metadata = buildMeasuredMessagePerformance({
      startedAt: 10_000,
      firstOutputAt: 13_400, // 3.4s to first output (includes harness startup)
      finishedAt: 40_000, // 30s total
      toolActiveMs: 6_600, // tools ran for 6.6s
      outputTokens: 1_000, // over 20s of generation → 50 t/s
    })
    expect(metadata).toEqual({
      schemaVersion: 1,
      source: 'measured',
      timeToFirstOutputMs: 3_400,
      responseTimeMs: 23_400,
      outputTokensPerSecond: 50,
    })
  })

  it('keeps metrics honest when pieces are missing', () => {
    const noFirstOutput = buildMeasuredMessagePerformance({
      startedAt: 10_000,
      firstOutputAt: null,
      finishedAt: 12_000,
      outputTokens: 500,
    })
    expect(noFirstOutput?.timeToFirstOutputMs).toBeUndefined()
    expect(noFirstOutput?.outputTokensPerSecond).toBeUndefined()
    expect(noFirstOutput?.responseTimeMs).toBe(2_000)

    const noTokens = buildMeasuredMessagePerformance({
      startedAt: 10_000,
      firstOutputAt: 10_500,
      finishedAt: 12_000,
      outputTokens: null,
    })
    expect(noTokens?.outputTokensPerSecond).toBeUndefined()
    expect(noTokens?.timeToFirstOutputMs).toBe(500)
  })

  it('returns null without start/finish marks or on impossible clocks', () => {
    expect(
      buildMeasuredMessagePerformance({
        startedAt: null,
        firstOutputAt: null,
        finishedAt: 12_000,
      }),
    ).toBeNull()
    expect(
      buildMeasuredMessagePerformance({
        startedAt: 10_000,
        firstOutputAt: null,
        finishedAt: null,
      }),
    ).toBeNull()
    expect(
      buildMeasuredMessagePerformance({
        startedAt: 12_000,
        firstOutputAt: null,
        finishedAt: 10_000,
      }),
    ).toBeNull()
  })

  it('never divides by a zero or negative generation window', () => {
    const metadata = buildMeasuredMessagePerformance({
      startedAt: 10_000,
      firstOutputAt: 11_000,
      finishedAt: 11_000,
      toolActiveMs: 500,
      outputTokens: 100,
    })
    expect(metadata?.outputTokensPerSecond).toBeUndefined()
  })
})

describe('computeCacheHitRatePercent (DL-093-14 formula)', () => {
  it('computes cachedInputTokens / inputTokens as a percent', () => {
    expect(
      computeCacheHitRatePercent({ inputTokens: 8000, cachedInputTokens: 6888 }),
    ).toBeCloseTo(86.1, 1)
  })

  it('reads the v7 nested detail shape when the flat field is absent', () => {
    expect(
      computeCacheHitRatePercent({
        inputTokens: 1000,
        inputTokenDetails: { cacheReadTokens: 250 },
      }),
    ).toBe(25)
  })

  it('returns null (unknown) when either number is missing or input is zero', () => {
    expect(computeCacheHitRatePercent(null)).toBeNull()
    expect(computeCacheHitRatePercent({ inputTokens: 1000 })).toBeNull()
    expect(computeCacheHitRatePercent({ cachedInputTokens: 100 })).toBeNull()
    expect(
      computeCacheHitRatePercent({ inputTokens: 0, cachedInputTokens: 0 }),
    ).toBeNull()
  })

  it('clamps normalization quirks so impossible percentages never render', () => {
    expect(
      computeCacheHitRatePercent({ inputTokens: 100, cachedInputTokens: 150 }),
    ).toBe(100)
    expect(
      computeCacheHitRatePercent({ inputTokens: 100, cachedInputTokens: -5 }),
    ).toBe(0)
  })

  it('formats whole-percent display values', () => {
    expect(formatCacheHitRatePercent(86.1)).toBe('86%')
    expect(formatCacheHitRatePercent(null)).toBeNull()
  })
})

describe('computeSessionCacheAggregate (whole-chat popover)', () => {
  it('token-weights the overall rate across responses', () => {
    const aggregate = computeSessionCacheAggregate([
      { inputTokens: 1000, cachedInputTokens: 0 },
      { inputTokens: 9000, cachedInputTokens: 9000 },
    ])
    expect(aggregate).toEqual({
      percent: 90,
      cachedTokens: 9000,
      inputTokens: 10000,
      responseCount: 2,
    })
  })

  it('skips responses that reported no cache usage instead of counting them as 0%', () => {
    const aggregate = computeSessionCacheAggregate([
      { inputTokens: 4000, cachedInputTokens: 3000 },
      { inputTokens: 5000 },
      null,
      { inputTokens: 0, cachedInputTokens: 0 },
    ])
    expect(aggregate).toEqual({
      percent: 75,
      cachedTokens: 3000,
      inputTokens: 4000,
      responseCount: 1,
    })
  })

  it('reads the v7 nested detail shape and clamps negative cached counts', () => {
    const aggregate = computeSessionCacheAggregate([
      { inputTokens: 1000, inputTokenDetails: { cacheReadTokens: 250 } },
      { inputTokens: 1000, cachedInputTokens: -50 },
    ])
    expect(aggregate).toEqual({
      percent: 12.5,
      cachedTokens: 250,
      inputTokens: 2000,
      responseCount: 2,
    })
  })

  it('returns null (unknown) when no response reported eligible cache usage', () => {
    expect(computeSessionCacheAggregate([])).toBeNull()
    expect(
      computeSessionCacheAggregate([{ inputTokens: 5000 }, null, undefined]),
    ).toBeNull()
  })
})
