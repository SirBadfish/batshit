import { describe, expect, it } from 'vitest'
import { buildManagedSubagentCacheForensicsRecord } from '$lib/server/services/cacheForensics/subagentAdapter'
import { pseudonymizeId, resolveCacheForensicsKey } from '$lib/server/services/cacheForensics/fingerprint'

const CANARY = 'BATSHIT-CANARY-subagent-task-text'

const MESSAGES = [
  { role: 'system', content: 'subagent system prompt' },
  { role: 'user', content: 'earlier memory question' },
  { role: 'assistant', content: 'earlier memory answer' },
  { role: 'user', content: CANARY },
]

function build(overrides: Partial<Parameters<typeof buildManagedSubagentCacheForensicsRecord>[0]> = {}) {
  return buildManagedSubagentCacheForensicsRecord({
    lane: 'api',
    messages: MESSAGES,
    usage: { promptTokens: 4200, completionTokens: 300, totalTokens: 4500, cachedInputTokens: 3900 },
    subagentId: 'sub-1',
    connectionId: 'conn-parent',
    modelId: 'gpt-6-mini',
    runMessageId: 'subagent-sub-1-abc',
    parentMessageId: 'msg-parent-1',
    capturedAt: '2026-08-30T05:00:00.000Z',
    ...overrides,
  })
}

describe('cacheForensics managed subagent adapter (P4)', () => {
  it('fingerprints the runner-compiled contract with subagent identity', () => {
    const record = build()

    expect(record.runtime).toBe('vercel')
    expect(record.boundary).toBe('batshit-compiled')
    expect(record.confidence).toBe('exact')
    expect(record.actor).toBe('subagent')

    const labels = record.segments.map((segment) => segment.label)
    expect(labels).toEqual([
      'prompt.messages[0]:system',
      'prompt.messages[1]:user',
      'prompt.messages[2]:assistant',
      'prompt.messages[3]:user',
    ])
    expect(record.segments[0].type).toBe('system-prompt')
    expect(record.segments[3].type).toBe('current-user-turn')
  })

  it('pseudonymizes the parent correlation id like a run id', () => {
    const record = build()
    const key = resolveCacheForensicsKey()
    expect(record.parentRunId).toBe(pseudonymizeId(key, 'run', 'msg-parent-1'))
    expect(record.parentRunId).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(record)).not.toContain('msg-parent-1')
  })

  it('normalizes ThoughtResponse-shaped API subagent usage', () => {
    const record = build()
    expect(record.providerCacheUsage).toMatchObject({
      source: 'runtime',
      inputTokens: 4200,
      cachedInputTokens: 3900,
    })
  })

  it('normalizes AI-SDK-shaped CLI subagent finish usage', () => {
    const record = build({
      lane: 'claude',
      usage: {
        inputTokens: 9000,
        outputTokens: 200,
        cachedInputTokens: 8000,
        cacheCreationInputTokens: 500,
      },
    })
    expect(record.runtime).toBe('claude')
    expect(record.providerCacheUsage).toEqual({
      source: 'runtime',
      inputTokens: 9000,
      cachedInputTokens: 8000,
      cacheCreationInputTokens: 500,
    })
  })

  it('discloses the hidden tool/provider boundaries per lane', () => {
    const api = build()
    expect(api.notes?.join(' ')).toContain('provider-request boundary is not exposed')
    expect(api.notes?.join(' ')).toContain('not fingerprinted in v1')

    const codex = build({ lane: 'codex' })
    expect(codex.runtime).toBe('codex')
    expect(codex.notes?.join(' ')).toContain('managed CLI profile')
  })

  it('never stores raw prompt or id content (DL-093-05/06)', () => {
    const record = build()
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain(CANARY)
    expect(serialized).not.toContain('subagent system prompt')
    expect(serialized).not.toContain('sub-1')
    expect(serialized).not.toContain('conn-parent')
    expect(record.modelId).toBe('gpt-6-mini')
  })

  it('separates comparison identities by subagent and model', () => {
    const base = build()
    const otherModel = build({ modelId: 'gpt-6-large' })
    const otherSubagent = build({ subagentId: 'sub-2' })
    expect(otherModel.comparisonId).not.toBe(base.comparisonId)
    expect(otherSubagent.comparisonId).not.toBe(base.comparisonId)
  })
})
