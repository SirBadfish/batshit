import { describe, expect, it } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import { buildCliCacheForensicsRecord } from '$lib/server/services/cacheForensics/cliAdapter'
import { analyzeDivergence } from '$lib/server/services/cacheForensics/divergence'

const CANARY_PROMPT = 'BATSHIT-CANARY-cli-prompt-text'

const MESSAGES = [
  { role: 'system', content: 'stable compiled system prompt' },
  { role: 'user', content: 'earlier question' },
  { role: 'assistant', content: 'earlier answer' },
  { role: 'user', content: CANARY_PROMPT },
]

const TOOLS = {
  batshit_tool_search: tool({
    description: 'search tools',
    inputSchema: z.object({ query: z.string() }),
  }),
  batshit_tool_use: tool({
    description: 'use one tool',
    inputSchema: z.object({ ref: z.string() }),
  }),
}

function build(overrides: Partial<Parameters<typeof buildCliCacheForensicsRecord>[0]> = {}) {
  return buildCliCacheForensicsRecord({
    runtime: 'claude',
    messages: MESSAGES,
    images: [{ url: 'data:image/png;base64,QkFUU0hJVA==', alt: 'screenshot' }],
    tools: TOOLS as any,
    usage: {
      inputTokens: 52000,
      outputTokens: 900,
      cachedInputTokens: 48000,
      cacheCreationInputTokens: 1200,
    },
    agentId: 'agent-1',
    connectionId: 'conn-claude',
    modelId: 'claude-sonnet-4-6',
    messageId: 'msg-cli-1',
    capturedAt: '2026-08-30T05:00:00.000Z',
    ...overrides,
  })
}

describe('cacheForensics CLI adapter (P4)', () => {
  it('fingerprints the batshit-compiled boundary in delivery order', () => {
    const record = build()

    expect(record.runtime).toBe('claude')
    expect(record.boundary).toBe('batshit-compiled')
    expect(record.confidence).toBe('exact')
    expect(record.callIndex).toBeUndefined()

    const labels = record.segments.map((segment) => segment.label)
    expect(labels).toEqual([
      'prompt.messages[0]:system',
      'prompt.messages[1]:user',
      'prompt.messages[2]:assistant',
      'prompt.messages[3]:user',
      'prompt.images[0]',
      'tool:batshit_tool_search',
      'tool:batshit_tool_use',
    ])
    expect(record.segments[0].type).toBe('system-prompt')
    expect(record.segments[1].type).toBe('history-message')
    expect(record.segments[3].type).toBe('current-user-turn')
    expect(record.segments[4].type).toBe('attachment')
    expect(record.segments[5].type).toBe('tool')
  })

  it('marks the compiled prompt exact and the tool contract near', () => {
    const record = build()
    expect(record.segments[0].confidence).toBe('exact')
    expect(record.segments[3].confidence).toBe('exact')
    expect(record.segments[5].confidence).toBe('near')
    expect(record.segments[6].confidence).toBe('near')
  })

  it('carries runtime-reported cache usage and hidden-boundary notes', () => {
    const record = build()
    expect(record.providerCacheUsage).toEqual({
      source: 'runtime',
      inputTokens: 52000,
      cachedInputTokens: 48000,
      cacheCreationInputTokens: 1200,
    })
    expect(record.notes?.join(' ')).toContain('unavailable to Batshit')
    expect(record.notes?.join(' ')).toContain('no per-call breakdown')
  })

  it('omits provider cache usage when the runtime reported nothing', () => {
    const record = build({ usage: null })
    expect(record.providerCacheUsage).toBeUndefined()
  })

  it('never stores raw prompt, image, tool, or id content (DL-093-05/06)', () => {
    const record = build()
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain(CANARY_PROMPT)
    expect(serialized).not.toContain('stable compiled system prompt')
    expect(serialized).not.toContain('QkFUU0hJVA')
    expect(serialized).not.toContain('search tools')
    expect(serialized).not.toContain('msg-cli-1')
    expect(serialized).not.toContain('agent-1')
    expect(serialized).not.toContain('conn-claude')
    // The plain model id is deliberate grouping metadata.
    expect(record.modelId).toBe('claude-sonnet-4-6')
  })

  it('localizes divergence to the changed message between two runs', () => {
    const baseline = build()
    const changed = build({
      messages: [
        MESSAGES[0],
        MESSAGES[1],
        { role: 'assistant', content: 'a DIFFERENT earlier answer' },
        MESSAGES[3],
      ],
      messageId: 'msg-cli-2',
    })

    const divergence = analyzeDivergence(changed.segments, baseline.segments)
    expect(divergence.state).toBe('diverged')
    expect(divergence.firstDivergence?.kind).toBe('changed')
    expect(divergence.firstDivergence?.label).toBe('prompt.messages[2]:assistant')
    expect(divergence.reusablePrefixSegments).toBe(2)
  })

  it('separates codex and claude comparison identities', () => {
    const claude = build()
    const codex = build({ runtime: 'codex' })
    expect(codex.runtime).toBe('codex')
    expect(codex.comparisonId).not.toBe(claude.comparisonId)
  })
})
