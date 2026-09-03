import { afterEach, describe, expect, it } from 'vitest'
import { env } from '$env/dynamic/private'
import {
  CACHE_FORENSICS_MAX_SEGMENTS,
  CacheForensicsCaptureError,
  __resetCacheForensicsKeyForTests,
  buildComparisonId,
  canonicalSerialize,
  fingerprintSegments,
  pseudonymizeId,
  resolveCacheForensicsKey,
  type CacheForensicsSegmentInput,
} from '$lib/server/services/cacheForensics/fingerprint'
import {
  analyzeDivergence,
  isEligibleBaseline,
  selectBaselineRecord,
} from '$lib/server/services/cacheForensics/divergence'
import {
  applyBaselineComparison,
  captureCacheForensicsRecord,
} from '$lib/server/services/cacheForensics/record'
import type { CacheForensicsRecord } from '$lib/types/cacheForensics'
import { buildInterruptedReasoningRecovery } from '$lib/utils/reasoningRecovery'

const TEST_KEY = Buffer.alloc(32, 7)
const OTHER_KEY = Buffer.alloc(32, 9)

const HEX_64 = /^[0-9a-f]{64}$/

function segmentInputs(
  contents: Array<{ label: string; content: unknown }>,
): CacheForensicsSegmentInput[] {
  return contents.map(({ label, content }) => ({
    type: 'request-block',
    label,
    content,
  }))
}

describe('cacheForensics fingerprint engine (P1)', () => {
  describe('canonicalSerialize', () => {
    it('is insensitive to object key order but sensitive to array order', () => {
      expect(canonicalSerialize({ b: 1, a: 2 })).toBe(canonicalSerialize({ a: 2, b: 1 }))
      expect(canonicalSerialize([1, 2])).not.toBe(canonicalSerialize([2, 1]))
    })

    it('omits undefined object entries and marks undefined array entries', () => {
      expect(canonicalSerialize({ a: 1, gone: undefined })).toBe(canonicalSerialize({ a: 1 }))
      expect(canonicalSerialize([undefined])).toContain('__undefined')
    })

    it('serializes nested multimodal-style values without flattening arrays', () => {
      const message = {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', image: 'https://example.test/clip.png', mediaType: 'image/png' },
        ],
      }
      const reordered = {
        role: 'user',
        content: [
          { type: 'image', image: 'https://example.test/clip.png', mediaType: 'image/png' },
          { type: 'text', text: 'look at this' },
        ],
      }
      expect(canonicalSerialize(message)).not.toBe(canonicalSerialize(reordered))
    })

    it('tags dates, bigints, and binary content deterministically', () => {
      const when = new Date('2026-08-30T05:00:00.000Z')
      expect(canonicalSerialize(when)).toContain('2026-08-30T05:00:00.000Z')
      expect(canonicalSerialize(10n)).toContain('__bigint')
      expect(canonicalSerialize(Buffer.from('abc'))).toBe(
        canonicalSerialize(new Uint8Array([97, 98, 99])),
      )
    })

    it('rejects circular references and function values loudly', () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      expect(() => canonicalSerialize(circular)).toThrowError(CacheForensicsCaptureError)
      expect(() => canonicalSerialize({ fn: () => 1 })).toThrowError(CacheForensicsCaptureError)
    })

    it('allows repeated (non-circular) references to the same object', () => {
      const shared = { id: 'x' }
      expect(() => canonicalSerialize({ a: shared, b: shared })).not.toThrow()
    })
  })

  describe('fingerprintSegments', () => {
    it('produces stable full-length HMACs for identical input and key', () => {
      const inputs = segmentInputs([{ label: 'system', content: { text: 'hello world' } }])
      const first = fingerprintSegments(TEST_KEY, inputs)
      const second = fingerprintSegments(TEST_KEY, inputs)
      expect(first.segments[0].hmac).toBe(second.segments[0].hmac)
      expect(first.segments[0].hmac).toMatch(HEX_64)
    })

    it('changes the HMAC when the key changes (dictionary-attack guard)', () => {
      const inputs = segmentInputs([{ label: 'system', content: { text: 'hello world' } }])
      const withTestKey = fingerprintSegments(TEST_KEY, inputs).segments[0].hmac
      const withOtherKey = fingerprintSegments(OTHER_KEY, inputs).segments[0].hmac
      expect(withTestKey).not.toBe(withOtherKey)
    })

    it('records order, byte/char counts, and rounded token estimates', () => {
      const result = fingerprintSegments(TEST_KEY, [
        { type: 'system-prompt', label: 'system', content: 'abc', tokensEstimate: 1.6 },
        { type: 'current-user-turn', label: 'user', content: 'defg' },
      ])
      expect(result.segments.map((segment) => segment.index)).toEqual([0, 1])
      expect(result.segments[0].bytes).toBeGreaterThan(0)
      expect(result.segments[0].chars).toBeGreaterThan(0)
      expect(result.segments[0].tokensEstimate).toBe(2)
      expect(result.segments[1].tokensEstimate).toBeUndefined()
    })

    it('bounds oversized segment lists and reports the truncation', () => {
      const inputs = segmentInputs(
        Array.from({ length: CACHE_FORENSICS_MAX_SEGMENTS + 88 }, (_, index) => ({
          label: `history[${index}]`,
          content: `message ${index}`,
        })),
      )
      const result = fingerprintSegments(TEST_KEY, inputs)
      expect(result.segments).toHaveLength(CACHE_FORENSICS_MAX_SEGMENTS)
      expect(result.truncated).toBe(88)
    })

    it('clamps oversized labels', () => {
      const result = fingerprintSegments(TEST_KEY, [
        { type: 'tool', label: `tool:${'x'.repeat(400)}`, content: {} },
      ])
      expect(result.segments[0].label.length).toBeLessThanOrEqual(160)
    })
  })

  describe('key derivation', () => {
    afterEach(() => {
      env.ENCRYPTION_KEY = 'test-encryption-key-0123456789abcdef' // gitleaks:allow -- synthetic fixture
      __resetCacheForensicsKeyForTests()
    })

    it('derives a 32-byte key from the configured ENCRYPTION_KEY', () => {
      __resetCacheForensicsKeyForTests()
      expect(resolveCacheForensicsKey()).toHaveLength(32)
    })

    it('fails loudly on a missing or placeholder key', () => {
      env.ENCRYPTION_KEY = ''
      __resetCacheForensicsKeyForTests()
      expect(() => resolveCacheForensicsKey()).toThrowError(CacheForensicsCaptureError)

      env.ENCRYPTION_KEY = 'replace-with-your-own-key-please-now'
      __resetCacheForensicsKeyForTests()
      expect(() => resolveCacheForensicsKey()).toThrowError(CacheForensicsCaptureError)
    })
  })

  describe('identity helpers', () => {
    it('builds equal comparison ids only for equal identity parts', () => {
      const base = {
        runtime: 'vercel' as const,
        boundary: 'batshit-compiled' as const,
        agentId: 'agent-1',
        connectionId: 'conn-1',
        modelId: 'model-1',
      }
      const same = buildComparisonId(TEST_KEY, base)
      expect(buildComparisonId(TEST_KEY, { ...base })).toBe(same)
      expect(buildComparisonId(TEST_KEY, { ...base, modelId: 'model-2' })).not.toBe(same)
      expect(
        buildComparisonId(TEST_KEY, { ...base, experimentGroup: 'exp-a' }),
      ).not.toBe(same)
    })

    it('pseudonymizes ids deterministically without exposing the raw value', () => {
      const pseudonym = pseudonymizeId(TEST_KEY, 'run', 'msg_very_secret_12345')
      expect(pseudonym).toMatch(HEX_64)
      expect(pseudonym).not.toContain('msg_very_secret_12345')
      expect(pseudonymizeId(TEST_KEY, 'run', 'msg_very_secret_12345')).toBe(pseudonym)
      expect(pseudonymizeId(TEST_KEY, 'session', 'msg_very_secret_12345')).not.toBe(pseudonym)
    })
  })
})

describe('cacheForensics divergence analysis (P1)', () => {
  function fingerprinted(contents: Array<{ label: string; content: unknown }>) {
    return fingerprintSegments(TEST_KEY, segmentInputs(contents)).segments
  }

  const CONTROL = [
    { label: 'system', content: { text: 'stable system prompt' } },
    { label: 'tool:alpha', content: { name: 'alpha', schema: { a: 1 } } },
    { label: 'history[0]:user', content: 'hi' },
    { label: 'current-user-turn', content: 'hello there' },
  ]

  it('reports no-divergence for identical runs with full prefix accounting', () => {
    const current = fingerprinted(CONTROL)
    const result = analyzeDivergence(current, fingerprinted(CONTROL))
    expect(result.state).toBe('no-divergence')
    expect(result.reusablePrefixSegments).toBe(CONTROL.length)
    expect(result.reusablePrefixBytes).toBe(
      current.reduce((sum, segment) => sum + segment.bytes, 0),
    )
  })

  it('names the first changed segment for a one-field mutation', () => {
    const mutated = [...CONTROL]
    mutated[1] = { label: 'tool:alpha', content: { name: 'alpha', schema: { a: 2 } } }
    const result = analyzeDivergence(fingerprinted(mutated), fingerprinted(CONTROL))
    expect(result.state).toBe('diverged')
    expect(result.firstDivergence).toMatchObject({
      kind: 'changed',
      index: 1,
      label: 'tool:alpha',
    })
    expect(result.reusablePrefixSegments).toBe(1)
  })

  it('classifies an inserted segment as added', () => {
    const withInsert = [
      CONTROL[0],
      { label: 'tool:new', content: { name: 'new' } },
      ...CONTROL.slice(1),
    ]
    const result = analyzeDivergence(fingerprinted(withInsert), fingerprinted(CONTROL))
    expect(result.firstDivergence).toMatchObject({ kind: 'added', index: 1, label: 'tool:new' })
  })

  it('classifies a dropped segment as removed', () => {
    const withoutTool = [CONTROL[0], ...CONTROL.slice(2)]
    const result = analyzeDivergence(fingerprinted(withoutTool), fingerprinted(CONTROL))
    expect(result.firstDivergence).toMatchObject({
      kind: 'removed',
      index: 1,
      label: 'tool:alpha',
    })
  })

  it('classifies swapped segments as reordered', () => {
    const swapped = [CONTROL[0], CONTROL[2], CONTROL[1], CONTROL[3]]
    const result = analyzeDivergence(fingerprinted(swapped), fingerprinted(CONTROL))
    expect(result.firstDivergence?.kind).toBe('reordered')
    expect(result.firstDivergence?.index).toBe(1)
  })

  it('reports tail additions past a fully shared prefix', () => {
    const extended = [...CONTROL, { label: 'runtime-addendum', content: 'group context' }]
    const result = analyzeDivergence(fingerprinted(extended), fingerprinted(CONTROL))
    expect(result.firstDivergence).toMatchObject({ kind: 'added', index: CONTROL.length })
    expect(result.reusablePrefixSegments).toBe(CONTROL.length)
  })

  it('detects provider-option changes as ordinary segment divergence', () => {
    const withOptions = [
      ...CONTROL,
      { label: 'provider-options', content: { openai: { promptCacheKey: 'bs-pc-v1-aaa' } } },
    ]
    const withChangedOptions = [
      ...CONTROL,
      { label: 'provider-options', content: { openai: { promptCacheKey: 'bs-pc-v1-bbb' } } },
    ]
    const result = analyzeDivergence(
      fingerprinted(withChangedOptions),
      fingerprinted(withOptions),
    )
    expect(result.firstDivergence).toMatchObject({
      kind: 'changed',
      label: 'provider-options',
    })
  })
})

describe('cacheForensics history stability (SA-108)', () => {
  /**
   * Batshit compiles the whole conversation into ONE user message, so
   * `firstDivergence` lands at the newly appended turn on every healthy
   * multi-turn send. `historyStability` is the field that answers whether an
   * already-written history message stayed byte-stable.
   */
  function history(messages: string[], current: string) {
    const inputs: CacheForensicsSegmentInput[] = [
      { type: 'system-prompt', label: 'body.messages[0]:system', content: 'stable system' },
      ...messages.map((content, index) => ({
        type: 'history-message' as const,
        label: `body.messages[1]:user#history[${index}]`,
        content,
      })),
      {
        type: 'current-user-turn' as const,
        label: 'body.messages[1]:user#current',
        content: current,
      },
    ]
    return fingerprintSegments(TEST_KEY, inputs).segments
  }

  it('reports append-only when the conversation simply grew', () => {
    const result = analyzeDivergence(
      history(['u1', 'a1', 'u2', 'a2'], 'turn 3'),
      history(['u1', 'a1'], 'turn 2'),
    )
    expect(result.divergence ?? result.historyStability).toBeDefined()
    expect(result.historyStability).toMatchObject({
      state: 'append-only',
      baselineSegments: 2,
      currentSegments: 4,
    })
    expect(result.historyStability?.firstChangedIndex).toBeUndefined()
    // The reusable prefix now covers the surviving history, not just the system.
    expect(result.reusablePrefixSegments).toBe(3)
  })

  it('bounds interruption recovery to one insert mutation and one expiry mutation', () => {
    const recovery = buildInterruptedReasoningRecovery({
      agentId: 'agent-a',
      reasoningSummary: 'Unfinished reasoning remains byte-stable.',
      planSummary: '- Continue the same check',
    })
    expect(recovery).not.toBeNull()

    const interruptedWithoutRecovery = 'A1: partial answer'
    const interruptedWithRecovery = `${interruptedWithoutRecovery}\n\n${recovery?.renderedBlock}`

    const inserted = analyzeDivergence(
      history(['u1', interruptedWithRecovery], 'continue'),
      history(['u1', interruptedWithoutRecovery], 'interrupt'),
    )
    expect(inserted.historyStability).toMatchObject({
      state: 'mutated',
      firstChangedIndex: 1,
    })

    const retained = analyzeDivergence(
      history(['u1', interruptedWithRecovery, 'u2', 'A1: failed retry'], 'continue again'),
      history(['u1', interruptedWithRecovery], 'continue'),
    )
    expect(retained.historyStability).toMatchObject({ state: 'append-only' })

    const expired = analyzeDivergence(
      history(
        ['u1', interruptedWithoutRecovery, 'u2', 'A1: failed retry', 'u3', 'A1: success'],
        'next task',
      ),
      history(['u1', interruptedWithRecovery, 'u2', 'A1: failed retry'], 'continue again'),
    )
    expect(expired.historyStability).toMatchObject({
      state: 'mutated',
      firstChangedIndex: 1,
    })

    const afterExpiry = analyzeDivergence(
      history(
        [
          'u1',
          interruptedWithoutRecovery,
          'u2',
          'A1: failed retry',
          'u3',
          'A1: success',
          'u4',
          'A1: ordinary next response',
        ],
        'keep going',
      ),
      history(
        ['u1', interruptedWithoutRecovery, 'u2', 'A1: failed retry', 'u3', 'A1: success'],
        'next task',
      ),
    )
    expect(afterExpiry.historyStability).toMatchObject({ state: 'append-only' })
  })

  it('reports mutated and names the index when an already-written message changed', () => {
    const result = analyzeDivergence(
      history(['u1', 'a1-EDITED', 'u2', 'a2'], 'turn 3'),
      history(['u1', 'a1'], 'turn 2'),
    )
    expect(result.historyStability).toMatchObject({
      state: 'mutated',
      firstChangedIndex: 1,
      firstChangedLabel: 'body.messages[1]:user#history[1]',
    })
  })

  it('reports shortened when history segments disappeared', () => {
    const result = analyzeDivergence(
      history(['u1'], 'turn 3'),
      history(['u1', 'a1', 'u2'], 'turn 2'),
    )
    expect(result.historyStability).toMatchObject({ state: 'shortened', firstChangedIndex: 1 })
  })

  it('reports reordered when a baseline message moved later', () => {
    const result = analyzeDivergence(
      history(['u1', 'u2', 'a1', 'a2'], 'turn 3'),
      history(['u1', 'a1'], 'turn 2'),
    )
    expect(result.historyStability).toMatchObject({ state: 'reordered', firstChangedIndex: 1 })
  })

  it('reports not-applicable when either side carried no compiled history', () => {
    const cold = analyzeDivergence(history(['u1', 'a1'], 'turn 2'), history([], 'cold turn'))
    expect(cold.historyStability).toMatchObject({
      state: 'not-applicable',
      baselineSegments: 0,
      currentSegments: 2,
    })

    const plain = fingerprintSegments(
      TEST_KEY,
      segmentInputs([{ label: 'body.messages[0]:user', content: 'plain provider message' }]),
    ).segments
    expect(analyzeDivergence(plain, plain).historyStability).toMatchObject({
      state: 'not-applicable',
    })
  })
})

describe('cacheForensics record + baseline selection (P2)', () => {
  function capture(
    overrides: Partial<Parameters<typeof captureCacheForensicsRecord>[0]> = {},
  ): CacheForensicsRecord {
    return captureCacheForensicsRecord({
      runtime: 'vercel',
      boundary: 'batshit-compiled',
      confidence: 'exact',
      agentId: 'agent-1',
      connectionId: 'conn-1',
      modelId: 'model-1',
      runId: 'run-raw-id-1',
      segments: segmentInputs([
        { label: 'system', content: 'stable' },
        { label: 'current-user-turn', content: 'hello' },
      ]),
      capturedAt: '2026-08-30T05:00:00.000Z',
      ...overrides,
    })
  }

  it('captures a storage-ready record with pseudonymous identifiers', () => {
    const record = capture()
    // Pinned deliberately: bumping the schema must be an explicit decision
    // (v2 = SA-108 compiled-user-message sub-segments + historyStability;
    // v3 = DQ-D-028 Responses-shaped `body.input[]` sub-segmentation).
    expect(record.schemaVersion).toBe(3)
    expect(record.comparisonId).toMatch(HEX_64)
    expect(record.runId).toMatch(HEX_64)
    expect(record.runId).not.toContain('run-raw-id-1')
    expect(record.segments).toHaveLength(2)
  })

  it('never exposes canary prompt/header/key/identity content in the stored record', () => {
    const record = capture({
      agentId: 'BATSHIT-CANARY-AGENT-93',
      connectionId: 'BATSHIT-CANARY-CONNECTION-93',
      modelId: 'model-1',
      runId: 'BATSHIT-CANARY-RUN-93',
      experimentGroup: 'BATSHIT-CANARY-EXPERIMENT-93',
      segments: segmentInputs([
        { label: 'system', content: 'BATSHIT-CANARY-PROMPT-93 secret instructions' },
        { label: 'tool:secret', content: { apiKey: 'sk-BATSHIT-CANARY-KEY-93' } }, // gitleaks:allow -- synthetic canary
        {
          label: 'request-headers',
          content: { authorization: 'Bearer BATSHIT-CANARY-TOKEN-93' },
        },
        { label: 'current-user-turn', content: 'my email is canary-user-93@example.test' },
      ]),
    })
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain('CANARY')
    expect(serialized).not.toContain('canary-user-93@example.test')
    expect(serialized).not.toContain('sk-')
    for (const segment of record.segments) {
      expect(segment.hmac).toMatch(HEX_64)
    }
  })

  it('returns a loud capture-failed record for unserializable input without throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const record = capture({
      segments: [{ type: 'request-block', label: 'system', content: circular }],
    })
    expect(record.divergence?.state).toBe('capture-failed')
    expect(record.divergence?.reason).toContain('CIRCULAR_REFERENCE')
    expect(record.segments).toHaveLength(0)
  })

  it('rejects schema-version and boundary mismatches as not eligible', () => {
    const current = capture()
    const otherSchema = {
      ...capture(),
      schemaVersion: 0 as unknown as CacheForensicsRecord['schemaVersion'],
    }
    expect(isEligibleBaseline(current, otherSchema).eligible).toBe(false)
    expect(isEligibleBaseline(current, otherSchema).reason).toContain('schema')

    const otherBoundary = capture({ boundary: 'provider-request' })
    expect(isEligibleBaseline(current, otherBoundary).eligible).toBe(false)
  })

  it('rejects a different model/agent/connection identity as not eligible', () => {
    const current = capture()
    const otherModel = capture({ modelId: 'model-2' })
    const eligibility = isEligibleBaseline(current, otherModel)
    expect(eligibility.eligible).toBe(false)
    expect(eligibility.reason).toContain('comparison identity')
  })

  it('selects the latest eligible baseline and reports reasons when none exist', () => {
    const current = capture({ runId: 'run-3' })
    const older = capture({ runId: 'run-1' })
    const newer = capture({ runId: 'run-2' })
    const foreign = capture({ runId: 'run-x', modelId: 'model-2' })

    const selected = selectBaselineRecord(current, [older, foreign, newer])
    expect(selected.baseline?.runId).toBe(newer.runId)

    const none = selectBaselineRecord(current, [foreign])
    expect(none.baseline).toBeNull()
    expect(none.reason).toBeTruthy()
  })

  it('applies baseline comparison end to end: identical control then one mutation', () => {
    const baseline = capture({ runId: 'run-1' })

    const identical = applyBaselineComparison(capture({ runId: 'run-2' }), [baseline])
    expect(identical.divergence?.state).toBe('no-divergence')
    expect(identical.baselineRunId).toBe(baseline.runId)

    const mutated = applyBaselineComparison(
      capture({
        runId: 'run-3',
        segments: segmentInputs([
          { label: 'system', content: 'stable' },
          { label: 'current-user-turn', content: 'hello CHANGED' },
        ]),
      }),
      [baseline],
    )
    expect(mutated.divergence?.state).toBe('diverged')
    expect(mutated.divergence?.firstDivergence).toMatchObject({
      kind: 'changed',
      index: 1,
      label: 'current-user-turn',
    })
  })

  it('marks runs with no comparable earlier record as not-comparable', () => {
    const result = applyBaselineComparison(capture(), [])
    expect(result.divergence?.state).toBe('not-comparable')
    expect(result.divergence?.reason).toBeTruthy()
  })

  it('never uses a capture-failed record as a baseline', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const failed = capture({
      runId: 'run-broken',
      segments: [{ type: 'request-block', label: 'system', content: circular }],
    })
    const result = applyBaselineComparison(capture({ runId: 'run-2' }), [failed])
    expect(result.divergence?.state).toBe('not-comparable')
  })
})
