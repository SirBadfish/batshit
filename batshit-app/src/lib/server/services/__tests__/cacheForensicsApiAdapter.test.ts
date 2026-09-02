import { afterEach, describe, expect, it } from 'vitest'
import { env } from '$env/dynamic/private'
import {
  buildApiCacheForensicsRecords,
  resolveCacheForensicsExperimentGroup,
  segmentProviderRequestBody,
} from '$lib/server/services/cacheForensics/apiAdapter'
import { analyzeDivergence } from '$lib/server/services/cacheForensics/divergence'
import { resolveCacheForensicsKey, fingerprintSegments } from '$lib/server/services/cacheForensics/fingerprint'

/** Representative Anthropic-shaped wire body (SA-098 pinned system[]+cache_control shape). */
const ANTHROPIC_BODY = {
  model: 'claude-sonnet-4-6',
  system: [
    {
      type: 'text',
      text: 'stable compiled system prompt',
      cache_control: { type: 'ephemeral' },
    },
  ],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
  ],
  tools: [
    { name: 'native_batshit_tool_search', input_schema: { type: 'object' } },
    { name: 'native_batshit_tool_use', input_schema: { type: 'object' } },
  ],
  max_tokens: 4096,
}

function step(body: unknown, usage?: unknown): Record<string, unknown> {
  return {
    request: body === undefined ? {} : { body },
    ...(usage ? { usage } : {}),
  }
}

describe('cacheForensics API adapter (P4)', () => {
  afterEach(() => {
    delete (env as Record<string, string | undefined>).BATSHIT_CACHE_FORENSICS_EXPERIMENT
  })

  describe('segmentProviderRequestBody', () => {
    it('expands arrays per element in wire order with name/role suffixes', () => {
      const { segments, parsed } = segmentProviderRequestBody(ANTHROPIC_BODY)
      expect(parsed).toBe(true)
      const labels = segments.map((segment) => segment.label)
      expect(labels).toEqual([
        'body.model',
        'body.system[0]:text',
        'body.messages[0]:user',
        'body.tools[0]:native_batshit_tool_search',
        'body.tools[1]:native_batshit_tool_use',
        'body.max_tokens',
      ])
      expect(segments[1].type).toBe('system-prompt')
      expect(segments[2].type).toBe('history-message')
      expect(segments[3].type).toBe('tool')
    })

    it('parses JSON string bodies identically to object bodies', () => {
      const fromObject = segmentProviderRequestBody(ANTHROPIC_BODY)
      const fromString = segmentProviderRequestBody(JSON.stringify(ANTHROPIC_BODY))
      const key = resolveCacheForensicsKey()
      const objectHashes = fingerprintSegments(key, fromObject.segments).segments.map(
        (segment) => segment.hmac,
      )
      const stringHashes = fingerprintSegments(key, fromString.segments).segments.map(
        (segment) => segment.hmac,
      )
      expect(stringHashes).toEqual(objectHashes)
    })

    it('falls back to one opaque block for unparseable bodies', () => {
      const { segments, parsed } = segmentProviderRequestBody('not json at all {')
      expect(parsed).toBe(false)
      expect(segments).toHaveLength(1)
      expect(segments[0].label).toBe('body.raw')
    })

    it('fingerprints leading standing Awareness media as one stable #standing segment', () => {
      const { segments } = segmentProviderRequestBody({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '==== AWARENESS MEDIA (STANDING) ====\n- portrait.png — image' },
              { type: 'image', source: { type: 'base64', data: 'AAAA' } },
              { type: 'text', text: '==== CURRENT USER MESSAGE ====\n\nhello' }
            ]
          }
        ]
      })
      expect(segments.map((segment) => segment.label)).toEqual([
        'body.messages[0]:user#standing',
        'body.messages[0]:user#current'
      ])
    })
  })

  describe('buildApiCacheForensicsRecords', () => {
    it('builds one exact record per model call with per-call cache usage', () => {
      const records = buildApiCacheForensicsRecords({
        steps: [
          step(ANTHROPIC_BODY, {
            inputTokens: 7000,
            outputTokens: 50,
            totalTokens: 7050,
            cachedInputTokens: 6888,
          }),
          step(
            {
              ...ANTHROPIC_BODY,
              messages: [
                ...ANTHROPIC_BODY.messages,
                { role: 'assistant', content: [{ type: 'tool_use', name: 'alpha' }] },
                { role: 'tool', content: [{ type: 'tool_result', text: 'ok' }] },
              ],
            },
            { inputTokens: 7400, outputTokens: 80, totalTokens: 7480 },
          ),
        ],
        agentId: 'agent-1',
        connectionId: 'conn-1',
        modelId: 'claude-sonnet-4-6',
        messageId: 'msg-raw-1',
        capturedAt: '2026-08-30T05:00:00.000Z',
      })

      expect(records).toHaveLength(2)
      expect(records[0].boundary).toBe('provider-request')
      expect(records[0].confidence).toBe('exact')
      expect(records[0].callIndex).toBe(1)
      expect(records[1].callIndex).toBe(2)
      expect(records[0].providerCacheUsage).toMatchObject({
        inputTokens: 7000,
        cachedInputTokens: 6888,
      })
      expect(records[0].runId).not.toContain('msg-raw-1')

      // The two calls share the prefix up to the messages delta — exactly the
      // intra-loop reuse evidence the divergence engine should surface.
      const divergence = analyzeDivergence(records[1].segments, records[0].segments)
      expect(divergence.state).toBe('diverged')
      expect(divergence.firstDivergence?.kind).toBe('added')
      expect(divergence.firstDivergence?.label).toBe('body.messages[1]:assistant')
    })

    it('marks calls without a request body as provider-evidence-unavailable', () => {
      const records = buildApiCacheForensicsRecords({
        steps: [step(undefined, { inputTokens: 10, outputTokens: 5 })],
        agentId: 'agent-1',
        connectionId: 'conn-1',
        modelId: 'model-1',
        messageId: 'msg-raw-1',
        capturedAt: '2026-08-30T05:00:00.000Z',
      })
      expect(records[0].segments).toHaveLength(0)
      expect(records[0].divergence?.state).toBe('provider-evidence-unavailable')
    })

    it('pseudonymizes the experiment group from the env knob', () => {
      expect(resolveCacheForensicsExperimentGroup()).toBeNull()
      ;(env as Record<string, string | undefined>).BATSHIT_CACHE_FORENSICS_EXPERIMENT =
        'exp-alpha'
      expect(resolveCacheForensicsExperimentGroup()).toBe('exp-alpha')

      const records = buildApiCacheForensicsRecords({
        steps: [step(ANTHROPIC_BODY)],
        agentId: 'agent-1',
        connectionId: 'conn-1',
        modelId: 'model-1',
        messageId: 'msg-raw-1',
        experimentGroup: 'exp-alpha',
        capturedAt: '2026-08-30T05:00:00.000Z',
      })
      expect(records[0].experimentGroup).toMatch(/^[0-9a-f]{64}$/)
      expect(records[0].experimentGroup).not.toContain('exp-alpha')
    })
  })
})
