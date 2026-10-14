import { describe, expect, it } from 'vitest'
import { applyApiPromptCachePolicy, placeToolLoopTailMarker } from '../apiPromptCachePolicy'

/**
 * BL-77 (2026-09-22): cache the API lane's tool loop.
 *
 * Measured on origin/main: a 13-step Artifact build on Claude Sonnet 5 sent 623,734 input
 * tokens and read only 19% of them from cache, because the only cache point was the system
 * prompt. Every step re-sent the whole conversation after it at full price.
 *
 * The policy now hands the per-step hook ONE extra cache point for a turn's second and later
 * steps (`stepProviderOptions`): Anthropic's request-level automatic cache point, which lands
 * on the last block, so each step reads everything the previous step sent from the cache.
 * It goes exactly where the system cache point already goes (direct Anthropic, and OpenRouter
 * with a Claude-family model), never anywhere else.
 */

const baseMessages = () =>
  [
    { role: 'system', content: 'Stable Batshit API agent prompt.' },
    { role: 'user', content: 'Build me a tip calculator artifact.' },
  ] as any[]

const anthropicDirect = {
  modelId: 'claude-sonnet-5',
  providerId: 'anthropic',
  connection: { type: 'direct', service: 'anthropic', id: 'direct:anthropic' } as any,
  userId: 'user-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
}

/** Every cache point a request carries in the anthropic/openrouter namespaces, counted the
 *  way the Anthropic API counts them: message level, part level, and tool level. */
function countExplicitCachePoints(messages: any[], tools?: Record<string, any>): number {
  const has = (options: any) =>
    ['anthropic', 'openrouter'].some(
      (key) =>
        options?.[key]?.cacheControl !== undefined || options?.[key]?.cache_control !== undefined,
    )
  let count = 0
  for (const message of messages) {
    if (has(message?.providerOptions)) count += 1
    if (Array.isArray(message?.content)) {
      for (const part of message.content) if (has(part?.providerOptions)) count += 1
    }
  }
  for (const tool of Object.values(tools ?? {})) if (has((tool as any)?.providerOptions)) count += 1
  return count
}

describe('BL-77 tool-loop cache point (apiPromptCachePolicy)', () => {
  it('gives direct Anthropic one request-level cache point for the tool loop, and keeps the system one', () => {
    const result = applyApiPromptCachePolicy({ ...anthropicDirect, messages: baseMessages() })

    expect(result.stepProviderOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    })
    // The FIRST step's call options are untouched: the tail point is the hook's to add from
    // step two on, so a one-step reply never pays for a cache write nobody reads.
    expect(result.providerOptions?.anthropic?.cacheControl).toBeUndefined()
    expect((result.messages[0] as any).providerOptions.anthropic.cacheControl).toEqual({
      type: 'ephemeral',
    })
    expect(result.metadata.applied).toContain('anthropic.cacheControl')
    expect(result.metadata.applied).toContain('anthropic.toolLoop.cacheControl.fromStep2')
  })

  it('does not move, copy, or reorder a single message to do it', () => {
    const messages = baseMessages()
    const before = JSON.stringify(messages)
    const result = applyApiPromptCachePolicy({ ...anthropicDirect, messages })

    // Input untouched, and the output differs from it only by the one system marker.
    expect(JSON.stringify(messages)).toBe(before)
    const stripped = result.messages.map((message: any) => {
      const { providerOptions: _drop, ...rest } = message
      return rest
    })
    expect(JSON.stringify(stripped)).toBe(before)
  })

  it('gives OpenRouter a tail point only for a Claude-family model, in the openrouter namespace', () => {
    const claude = applyApiPromptCachePolicy({
      modelId: 'anthropic/claude-sonnet-5',
      providerId: 'openrouter',
      connection: { type: 'openrouter', id: 'openrouter' } as any,
      messages: baseMessages(),
    })
    const other = applyApiPromptCachePolicy({
      modelId: 'openai/gpt-5.5',
      providerId: 'openrouter',
      connection: { type: 'openrouter', id: 'openrouter' } as any,
      messages: baseMessages(),
    })

    // BL-185: on OpenRouter the tail is a marker the hook moves to the last message, never the
    // request-level field (OpenRouter's Bedrock route accepts that field and ignores it).
    expect(claude.stepProviderOptions).toBeUndefined()
    expect(claude.toolLoopTailMarker).toEqual({
      namespace: 'openrouter',
      cacheControl: { type: 'ephemeral' },
    })
    expect(claude.metadata.applied).toContain('openrouter.toolLoop.cache_control.lastMessage.fromStep2')
    expect(other.stepProviderOptions).toBeUndefined()
    expect(other.toolLoopTailMarker).toBeUndefined()
  })

  it('adds no tail when no connection names the lane, and keeps the system point', () => {
    // A connection-less request is classified from its model name or a default provider id
    // (`getProviderName` falls back to 'anthropic'), and whatever serves it may not take a
    // request-level cache point. The system point is unchanged from before BL-77.
    const inferred = applyApiPromptCachePolicy({
      modelId: 'claude-sonnet-5',
      providerId: 'anthropic',
      connection: null,
      messages: baseMessages(),
    })

    expect(inferred.metadata.provider).toBe('anthropic')
    expect(inferred.stepProviderOptions).toBeUndefined()
    expect((inferred.messages[0] as any).providerOptions.anthropic.cacheControl).toEqual({
      type: 'ephemeral',
    })

    // The same rule for OpenRouter: a provider id alone does not name the connection.
    const inferredRouter = applyApiPromptCachePolicy({
      modelId: 'anthropic/claude-sonnet-5',
      providerId: 'openrouter',
      connection: null,
      messages: baseMessages(),
    })

    expect(inferredRouter.metadata.provider).toBe('openrouter')
    expect(inferredRouter.stepProviderOptions).toBeUndefined()
    expect((inferredRouter.messages[0] as any).providerOptions.openrouter.cacheControl).toEqual({
      type: 'ephemeral',
    })
  })

  it('adds nothing for any provider that does not take Anthropic cache control', () => {
    const lanes = [
      { modelId: 'gpt-5.5', providerId: 'openai', connection: { type: 'direct', service: 'openai' } },
      { modelId: 'gemini-3.5-flash', providerId: 'google', connection: { type: 'direct', service: 'google' } },
      // Vercel AI Gateway's own `caching: 'auto'` already marks the last message.
      { modelId: 'anthropic/claude-sonnet-5', providerId: 'vercel-gateway', connection: { type: 'vercel-gateway', id: 'vercel-gateway' } },
      { modelId: 'grok-4.20', providerId: 'xai', connection: { type: 'direct', service: 'xai' } },
      { modelId: 'deepseek-chat', providerId: 'deepseek', connection: { type: 'direct', service: 'deepseek' } },
      // A Claude-NAMED model on a local runtime is still not Anthropic (SA-102 / SA-107).
      { modelId: 'claude-distill-8b', providerId: 'lmstudio', connection: { type: 'direct', service: 'lmstudio' } },
    ]
    for (const lane of lanes) {
      const result = applyApiPromptCachePolicy({ ...lane, connection: lane.connection as any, messages: baseMessages() })
      expect(result.stepProviderOptions, lane.providerId).toBeUndefined()
      expect(result.metadata.applied.some((entry) => entry.includes('toolLoop')), lane.providerId).toBe(false)
    }
  })

  describe("a preset's Prompt cache TTL adds to the system cache point instead of replacing it", () => {
    const withPreset = (ttl: '5m' | '1h', messages = baseMessages()) =>
      applyApiPromptCachePolicy({
        ...anthropicDirect,
        messages,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl } } },
      })

    it('keeps the system cache point, on the preset TTL, and keeps the preset request-level point', () => {
      const result = withPreset('1h')

      expect((result.messages[0] as any).providerOptions.anthropic.cacheControl).toEqual({
        type: 'ephemeral',
        ttl: '1h',
      })
      // The preset's own request-level (automatic) cache point is still sent on every step.
      expect(result.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' })
      expect(result.metadata.applied).toContain('anthropic.cacheControl')
      expect(result.metadata.preserved).toContain('anthropic.cacheControl.automatic')
    })

    it('adds no second tail point: the preset request-level point already covers every step', () => {
      const result = withPreset('5m')
      expect(result.stepProviderOptions).toBeUndefined()
    })

    it('puts the standing Awareness media point on the preset TTL too (longer TTLs must come first)', () => {
      const result = withPreset('1h', [
        { role: 'system', content: 'stable system' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '<awareness_media>\n- portrait.png — image\n</awareness_media>' },
            { type: 'image', image: 'data:image/png;base64,AAAA' },
            { type: 'text', text: '<user time="9:00 AM">\nhello\n</user>' },
          ],
        },
      ] as any)

      expect((result.messages[1] as any).content[1].providerOptions.anthropic.cacheControl).toEqual({
        type: 'ephemeral',
        ttl: '1h',
      })
    })
  })

  describe('never more cache points than Anthropic allows (4, the automatic one included)', () => {
    it('counts system + standing media + the tail as three', () => {
      const messages = [
        { role: 'system', content: 'stable system' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '<awareness_media>\n- a.png — image\n</awareness_media>' },
            { type: 'image', image: 'data:image/png;base64,AAAA' },
            { type: 'text', text: '<user time="9:00 AM">\nhello\n</user>' },
          ],
        },
      ] as any[]
      const result = applyApiPromptCachePolicy({ ...anthropicDirect, messages })

      expect(countExplicitCachePoints(result.messages)).toBe(2)
      expect(result.stepProviderOptions).toBeDefined()
      expect(countExplicitCachePoints(result.messages) + 1).toBeLessThanOrEqual(4)
    })

    it('still adds the tail when three explicit points already exist', () => {
      const marker = { anthropic: { cacheControl: { type: 'ephemeral' } } }
      const messages = [
        { role: 'system', content: 'stable system', providerOptions: marker },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'one', providerOptions: marker },
            { type: 'text', text: 'two', providerOptions: marker },
            { type: 'text', text: 'three' },
          ],
        },
      ] as any[]
      const result = applyApiPromptCachePolicy({ ...anthropicDirect, messages })

      expect(countExplicitCachePoints(result.messages)).toBe(3)
      expect(result.stepProviderOptions).toBeDefined()
    })

    it('adds no tail when four explicit points already exist, and says why', () => {
      const marker = { anthropic: { cacheControl: { type: 'ephemeral' } } }
      const messages = [
        { role: 'system', content: 'stable system', providerOptions: marker },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'one', providerOptions: marker },
            { type: 'text', text: 'two', providerOptions: marker },
            { type: 'text', text: 'three' },
          ],
        },
      ] as any[]
      const tools = {
        cached_tool: { description: 'a tool', inputSchema: { type: 'object' }, providerOptions: marker },
      }
      const result = applyApiPromptCachePolicy({ ...anthropicDirect, messages, tools })

      expect(countExplicitCachePoints(result.messages, tools)).toBe(4)
      expect(result.stepProviderOptions).toBeUndefined()
      expect(result.metadata.omitted.map((entry) => entry.option)).toContain(
        'anthropic.toolLoop.cacheControl.fromStep2',
      )
    })
  })
})

describe('BL-184 the policy records the lifetime of the cache points it placed', () => {
  it("is Anthropic's five-minute default when no preset sets one", () => {
    expect(applyApiPromptCachePolicy({ ...anthropicDirect, messages: baseMessages() }).metadata.cacheTtl).toBe('5m')
  })

  it("is the preset's lifetime when it sets one", () => {
    for (const ttl of ['5m', '1h'] as const) {
      const result = applyApiPromptCachePolicy({
        ...anthropicDirect,
        messages: baseMessages(),
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl } } },
      })
      expect(result.metadata.cacheTtl).toBe(ttl)
    }
  })

  it('covers OpenRouter with a Claude model, and a connection-less Claude request', () => {
    const routed = applyApiPromptCachePolicy({
      modelId: 'anthropic/claude-sonnet-5',
      providerId: 'openrouter',
      connection: { type: 'openrouter', id: 'openrouter' } as any,
      messages: baseMessages(),
    })
    const inferred = applyApiPromptCachePolicy({
      modelId: 'claude-sonnet-5',
      providerId: 'anthropic',
      connection: null,
      messages: baseMessages(),
    })
    expect(routed.metadata.cacheTtl).toBe('5m')
    expect(inferred.metadata.cacheTtl).toBe('5m')
  })

  it("is the Vercel AI Gateway's five-minute default when Batshit turned its caching on for a Claude model", () => {
    const gateway = (providerOptions?: any) =>
      applyApiPromptCachePolicy({
        modelId: 'anthropic/claude-sonnet-5',
        providerId: 'vercel-gateway',
        connection: { type: 'vercel-gateway', id: 'vercel-gateway' } as any,
        messages: baseMessages(),
        providerOptions,
      }).metadata.cacheTtl

    expect(gateway()).toBe('5m')
    // The user's own gateway caching setting, or an Anthropic cache setting riding along,
    // may change the lifetime: unknown.
    expect(gateway({ gateway: { caching: 'auto' } })).toBeNull()
    expect(gateway({ anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } })).toBeNull()
  })

  it('is unknown when a cache point Batshit did not place was kept', () => {
    const messages = [
      {
        role: 'system',
        content: 'stable system',
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
      },
      { role: 'user', content: 'hello' },
    ] as any[]
    const result = applyApiPromptCachePolicy({ ...anthropicDirect, messages })
    expect(result.metadata.preserved).toContain('anthropic.cacheControl')
    expect(result.metadata.cacheTtl).toBeNull()
  })

  it('is null for every provider that takes no Anthropic cache point', () => {
    const lanes = [
      { modelId: 'gpt-5.5', providerId: 'openai', connection: { type: 'direct', service: 'openai' } },
      { modelId: 'gemini-3.5-flash', providerId: 'google', connection: { type: 'direct', service: 'google' } },
      { modelId: 'openai/gpt-5.5', providerId: 'openrouter', connection: { type: 'openrouter', id: 'openrouter' } },
      { modelId: 'openai/gpt-5.5', providerId: 'vercel-gateway', connection: { type: 'vercel-gateway', id: 'vercel-gateway' } },
      { modelId: 'deepseek-chat', providerId: 'deepseek', connection: { type: 'direct', service: 'deepseek' } },
    ]
    for (const lane of lanes) {
      const result = applyApiPromptCachePolicy({ ...lane, connection: lane.connection as any, messages: baseMessages() })
      expect(result.metadata.cacheTtl, `${lane.providerId} ${lane.modelId}`).toBeNull()
    }
  })
})

describe('BL-185 placeToolLoopTailMarker (OpenRouter tail marker)', () => {
  const marker = { namespace: 'openrouter' as const, cacheControl: { type: 'ephemeral' as const } }
  const compiled = () =>
    [
      {
        role: 'system',
        content: 'stable system',
        providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } },
      },
      { role: 'user', content: 'compiled chat' },
    ] as any[]
  const assistantCall = (n: number) =>
    ({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: `c${n}`, toolName: 'echo', input: {} }],
      providerOptions: { openrouter: { reasoning_details: [{ type: 'reasoning.text', text: 'r' }] } },
    }) as any
  const toolResults = (n: number, count = 1) =>
    ({
      role: 'tool',
      content: Array.from({ length: count }, (_unused, index) => ({
        type: 'tool-result',
        toolCallId: `c${n}_${index}`,
        toolName: 'echo',
        output: { type: 'json', value: { ok: true } },
      })),
    }) as any

  it('marks the last part of the last message, part level, and nothing else', () => {
    const messages = [...compiled(), assistantCall(1), toolResults(1, 3)]
    const out = placeToolLoopTailMarker(messages, 2, marker)

    expect(out[3].content.map((part: any) => part.providerOptions?.openrouter?.cacheControl ?? null)).toEqual([
      null,
      null,
      { type: 'ephemeral' },
    ])
    expect(out[3].providerOptions).toBeUndefined()
    expect(out.slice(0, 3)).toEqual(messages.slice(0, 3))
  })

  it("moves Batshit's marker: the previous tail is stripped, other provider options stay", () => {
    const first = placeToolLoopTailMarker([...compiled(), assistantCall(1), toolResults(1)], 2, marker)
    const second = placeToolLoopTailMarker([...first, assistantCall(2), toolResults(2)], 2, marker)

    expect(JSON.stringify(second[3])).not.toContain('cacheControl')
    expect(second[5].content[0].providerOptions.openrouter.cacheControl).toEqual({ type: 'ephemeral' })
    // The assistant's reasoning details (OpenRouter provider options) are untouched.
    expect(second[2].providerOptions.openrouter.reasoning_details).toHaveLength(1)
    // The system point is the compiled messages' own and is never touched.
    expect(second[0]).toBe(first[0])
    expect(second[0].providerOptions.openrouter.cacheControl).toEqual({ type: 'ephemeral' })
  })

  it('never mutates what it was given (the SDK keeps those objects as the saved response)', () => {
    const response = [assistantCall(1), toolResults(1, 2)]
    const before = JSON.stringify(response)
    placeToolLoopTailMarker([...compiled(), ...response], 2, marker)
    expect(JSON.stringify(response)).toBe(before)
  })

  it('a trailing one-text user message (a steer) is never marked: the message before it is', () => {
    // The provider sends it as a plain string unmarked and as a one-block array marked, so a
    // marker there would change more than the marker.
    for (const steer of [
      { role: 'user', content: 'steer' },
      { role: 'user', content: [{ type: 'text', text: 'steer' }] },
    ] as any[]) {
      const out = placeToolLoopTailMarker([...compiled(), assistantCall(1), toolResults(1), steer], 2, marker)
      expect(out[4]).toBe(steer)
      expect(out[3].content[0].providerOptions.openrouter.cacheControl).toEqual({ type: 'ephemeral' })
    }
    // A user message with more than one part (an injected image message) is marked as usual.
    const images = { role: 'user', content: [{ type: 'text', text: 'images' }, { type: 'image', image: 'x' }] } as any
    const out = placeToolLoopTailMarker([...compiled(), toolResults(1), images], 2, marker)
    expect(out[3].content[1].providerOptions.openrouter.cacheControl).toEqual({ type: 'ephemeral' })
    expect(JSON.stringify(out[2])).not.toContain('cacheControl')
  })

  it('an assistant message is marked at message level (the provider reads only that)', () => {
    const out = placeToolLoopTailMarker([...compiled(), assistantCall(1)], 2, marker)
    expect(out[2].providerOptions.openrouter).toEqual({
      reasoning_details: [{ type: 'reasoning.text', text: 'r' }],
      cacheControl: { type: 'ephemeral' },
    })
    expect(JSON.stringify(out[2].content)).not.toContain('cacheControl')
  })

  it('never marks a compiled message, even when the loop has not added one yet', () => {
    const messages = compiled()
    expect(placeToolLoopTailMarker(messages, 2, marker)).toEqual(messages)
  })

  it('uses the lifetime it was given', () => {
    const out = placeToolLoopTailMarker([...compiled(), toolResults(1)], 2, {
      namespace: 'openrouter',
      cacheControl: { type: 'ephemeral', ttl: '1h' },
    })
    expect(out[2].content[0].providerOptions.openrouter.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' })
  })
})
