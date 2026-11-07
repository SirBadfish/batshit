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
    // History cache blocks (2026-10-21): direct Anthropic sends the compiled chat as one text
    // block per history turn plus a tail block. Joined back, it segments exactly as one block.
    it('segments a history split into blocks exactly as the one block it joins back to', () => {
      const history = '<conversation>\n<user time="Mon">\nA\n</user>\n\n<assistant>\nB\n</assistant>'
      const turn2 = '\n\n<user time="Mon">\nC\n</user>\n\n<assistant>\nD\n</assistant>'
      const tail = '\n</conversation>\n\n<user time="Tue">\nE\n</user>\n\n<dynamic_info>\nx\n</dynamic_info>'
      const whole = { model: 'm', system: [{ type: 'text', text: 'S' }], messages: [{ role: 'user', content: [{ type: 'text', text: history + turn2 + tail }] }] }
      const split = {
        model: 'm',
        system: [{ type: 'text', text: 'S' }],
        messages: [{ role: 'user', content: [
          { type: 'text', text: history },
          { type: 'text', text: turn2, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: tail }
        ] }]
      }
      const a = segmentProviderRequestBody(whole).segments
      const b = segmentProviderRequestBody(split).segments
      expect(b).toEqual(a)
      // OpenRouter's first call also marks the tail block (BL-1976's step-start marker): same segments.
      const tailMarked = structuredClone(split)
      ;(tailMarked.messages[0].content[2] as Record<string, unknown>).cache_control = { type: 'ephemeral' }
      expect(segmentProviderRequestBody(tailMarked).segments).toEqual(a)
      expect(a.filter((segment) => segment.label.includes('history')).length).toBeGreaterThan(1)
    })

    // BL-1991: direct OpenAI (GPT-5.6+) sends the same parts as Responses `input_text`, the last two
    // history parts carrying `prompt_cache_breakpoint`. Joined back, they segment as the one part.
    it('segments an OpenAI Responses history split exactly as the one input_text it joins back to', () => {
      const history = '<conversation>\n<user time="Mon">\nA\n</user>\n\n<assistant>\nB\n</assistant>'
      const turn2 = '\n\n<user time="Mon">\nC\n</user>\n\n<assistant>\nD\n</assistant>'
      const tail = '\n</conversation>\n\n<user time="Tue">\nE\n</user>\n\n<dynamic_info>\nx\n</dynamic_info>'
      const developer = { role: 'developer', content: 'S' }
      const whole = { model: 'gpt-6.1-sol', input: [developer, { role: 'user', content: [{ type: 'input_text', text: history + turn2 + tail }] }] }
      const split = {
        model: 'gpt-6.1-sol',
        input: [developer, { role: 'user', content: [
          { type: 'input_text', text: history, prompt_cache_breakpoint: { mode: 'explicit' } },
          { type: 'input_text', text: turn2, prompt_cache_breakpoint: { mode: 'explicit' } },
          { type: 'input_text', text: tail }
        ] }]
      }
      const a = segmentProviderRequestBody(whole).segments
      expect(segmentProviderRequestBody(split).segments).toEqual(a)
      expect(a.filter((segment) => segment.label.includes('history')).length).toBeGreaterThan(1)
    })

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
              { type: 'text', text: '<awareness_media>\n- portrait.png — image\n</awareness_media>' },
              { type: 'image', source: { type: 'base64', data: 'AAAA' } },
              { type: 'text', text: '<user time="9:00 AM">\nhello\n</user>' }
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
    it.each(['vllm', 'sglang', 'lmstudio'])(
      'uses each %s response raw usage for per-call cache evidence', (providerId) => {
        const records = buildApiCacheForensicsRecords({
          providerId,
          steps: [undefined, null, 0, 64].map((cached) => step(ANTHROPIC_BODY, {
            inputTokens: 100, outputTokens: 5, cachedInputTokens: 0,
            raw: {
              prompt_tokens: 100,
              ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
            },
          })),
          agentId: 'agent-1', connectionId: 'opaque-connection-id',
          modelId: 'Qwen3-VL-4B-Instruct', messageId: 'msg-local',
        })
        expect(records.map((record) => record.providerCacheUsage?.cachedInputTokens))
          .toEqual([undefined, undefined, 0, 64])
        expect(records.every((record) => record.providerCacheUsage?.inputTokens === 100))
          .toBe(true)
      },
    )

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
