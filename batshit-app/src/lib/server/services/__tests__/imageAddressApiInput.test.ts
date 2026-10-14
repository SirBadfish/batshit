import { describe, expect, it } from 'vitest'
import { ApiImageInputCollector, readUserInputSources, steerInputSource } from '../imageAddressApiInput'
import { buildSteerInjectionText, formatSteerForModel, type SteerEntry } from '$lib/utils/steerControl'
import { sha256Hex } from '$lib/utils/sha256'
import { isTurnComplete } from '../imageAddressTurnRecord'

const systemText = 'System identity'
const systemModelMessage = { role: 'system', content: systemText, providerOptions: { vendor: { cache: true } } }

function observation(options: {
  compiledMessages?: readonly any[]
  promptMessages?: unknown
  compiledPrefixCount?: number
  initialSystem?: unknown
  toolDefinitions?: readonly any[]
  userSources?: any[]
} = {}) {
  const compiledMessages = options.compiledMessages ?? [{ role: 'user', content: 'A user message' }]
  return {
    compiledMessages,
    promptMessages: Object.hasOwn(options, 'promptMessages') ? options.promptMessages : [
      { role: 'system', content: systemText },
      ...compiledMessages
    ],
    toolDefinitions: Object.hasOwn(options, 'toolDefinitions') ? options.toolDefinitions : [],
    compiledPrefixCount: options.compiledPrefixCount ?? 0,
    initialSystem: options.initialSystem ?? [systemModelMessage],
    userSources: options.userSources ?? []
  }
}

function finalizable(collector: ApiImageInputCollector): boolean {
  return isTurnComplete({
    lane: 'api',
    compiled: { pieces: [], nonTextInputs: 0, unaccountedInputs: 0 },
    run: collector.run
  })
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

describe('API image input observation', () => {
  it('uses a valid integer prefix count to keep compiled input opaque and label only the replay tail (BL-1024)', () => {
    const original = 'Opaque original compiled text.'
    const replay = 'Replayed steer https://steer.example/read.png'
    const collector = new ApiImageInputCollector()
    collector.observe(observation({
      compiledMessages: [systemModelMessage, { role: 'user', content: original }, { role: 'user', content: replay }],
      promptMessages: [{ role: 'system', content: systemText }, { role: 'user', content: original }, { role: 'user', content: replay }],
      compiledPrefixCount: 2,
      userSources: [{ textHash: sha256Hex(replay), spans: [{ start: 0, end: replay.length, source: 'user' }] }]
    }))
    expect(collector.compiledObserved).toBe(true)
    expect(collector.run.pieces).toEqual([{ source: 'user', text: replay }])
    expect(finalizable(collector)).toBe(true)
  })

  it.each([
    ['missing', undefined], ['null', null], ['NaN', NaN], ['fraction', 0.5],
    ['string', '1'], ['boolean', true], ['negative', -1], ['past compiled input', 2], ['infinity', Infinity]
  ])('rejects a %s prefix count even when dispatched user content and source labels are valid (BL-1024)', (_label, count) => {
    const original = 'Source-labelled compiled content https://compiled.example/read.png'
    const value: any = observation({
      compiledMessages: [{ role: 'user', content: original }],
      promptMessages: [{ role: 'system', content: systemText }, { role: 'user', content: original }],
      userSources: [{ textHash: sha256Hex(original), spans: [{ start: 0, end: original.length, source: 'user' }] }]
    })
    if (_label === 'missing') delete value.compiledPrefixCount
    else value.compiledPrefixCount = count
    const collector = new ApiImageInputCollector()
    collector.observe(value)
    expect(collector.compiledObserved).toBe(false)
    expect(collector.run.unaccountedInputs).toBeGreaterThan(0)
    expect(finalizable(collector)).toBe(false)
  })

  it.each([null, NaN, 0.5])('a malformed prefix count %s cannot vouch a substituted compile through replay source labels (BL-1024)', (count) => {
    const replacement = 'A source-labelled replacement https://replacement.example/not-compiled.png'
    const collector = new ApiImageInputCollector()
    collector.observe({
      ...observation({
        compiledMessages: [{ role: 'user', content: 'Original compile that was never dispatched.' }],
        promptMessages: [{ role: 'system', content: systemText }, { role: 'user', content: replacement }],
        userSources: [{ textHash: sha256Hex(replacement), spans: [{ start: 0, end: replacement.length, source: 'user' }] }]
      }),
      compiledPrefixCount: count
    } as any)
    expect(collector.compiledObserved).toBe(false)
    expect(collector.run.unaccountedInputs).toBeGreaterThan(0)
    expect(finalizable(collector)).toBe(false)
  })

  it('recognizes the exact V4 system content and skips an opaque compiled role-user envelope', () => {
    const compiledEnvelope = '<compiled history> mention https://opaque.example/not-read.png </compiled history>'
    const input = observation({
      compiledMessages: [{ role: 'user', content: compiledEnvelope }],
      promptMessages: [
        { role: 'system', content: systemText },
        { role: 'user', content: compiledEnvelope }
      ],
      compiledPrefixCount: 1
    })
    const collector = new ApiImageInputCollector()

    collector.observe(input)

    expect(collector.compiledObserved).toBe(true)
    expect(collector.run).toMatchObject({ observed: true, unaccountedInputs: 0, pieces: [] })
    expect(finalizable(collector)).toBe(true)
  })

  it('treats a present undefined no-tools field as empty, while a missing callback field poisons', () => {
    const knownEmpty = new ApiImageInputCollector()
    knownEmpty.observe(observation({
      compiledMessages: [{ role: 'user', content: 'Compiled' }],
      promptMessages: [{ role: 'system', content: systemText }, { role: 'user', content: 'Compiled' }],
      compiledPrefixCount: 1,
      toolDefinitions: undefined
    }))
    expect(knownEmpty.run.unaccountedInputs).toBe(0)
    expect(finalizable(knownEmpty)).toBe(true)

    const missingFieldInput = observation({
      compiledMessages: [{ role: 'user', content: 'Compiled' }],
      promptMessages: [{ role: 'system', content: systemText }, { role: 'user', content: 'Compiled' }],
      compiledPrefixCount: 1
    })
    delete (missingFieldInput as any).toolDefinitions
    const missingField = new ApiImageInputCollector()
    missingField.observe(missingFieldInput as any)
    expect(missingField.run.unaccountedInputs).toBeGreaterThan(0)
    expect(finalizable(missingField)).toBe(false)
  })

  it('compares the dispatched user text to the frozen compiled prefix, not a replaced step list', () => {
    const original = 'Original compiled user message.'
    const replacement = 'Replacement includes https://replacement.example/unread.png'
    const collector = new ApiImageInputCollector()
    collector.observe(observation({
      compiledMessages: [{ role: 'user', content: original }],
      promptMessages: [
        { role: 'system', content: systemText },
        { role: 'user', content: replacement }
      ],
      compiledPrefixCount: 1
    }))

    expect(collector.compiledObserved).toBe(false)
    expect(collector.run.unaccountedInputs).toBeGreaterThan(0)
    expect(finalizable(collector)).toBe(false)
  })

  it.each([
    ['file', { type: 'file', data: { type: 'data', data: 'AAAA' }, mediaType: 'image/png' }],
    ['reasoning-file', { type: 'reasoning-file', data: { type: 'data', data: 'AAAA' }, mediaType: 'image/png' }],
    ['custom', { type: 'custom', kind: 'vendor.custom', value: 'https://custom.example/unread.png' }]
  ] as const)('does not call an assistant replay %s part a complete observed prompt', (_label, part) => {
    const collector = new ApiImageInputCollector()
    collector.observe(observation({
      compiledMessages: [{ role: 'user', content: 'Compiled.' }],
      promptMessages: [
        { role: 'system', content: systemText },
        { role: 'user', content: 'Compiled.' },
        { role: 'assistant', content: [part] }
      ],
      compiledPrefixCount: 1
    }))

    expect(collector.run.nonTextInputs + collector.run.unaccountedInputs).toBeGreaterThan(0)
    expect(finalizable(collector)).toBe(false)
  })

  it('does not treat assistant text or reasoning as user/tool sources', () => {
    const collector = new ApiImageInputCollector()
    collector.observe(observation({
      compiledMessages: [{ role: 'user', content: 'Compiled.' }],
      promptMessages: [
        { role: 'system', content: systemText },
        { role: 'user', content: 'Compiled.' },
        { role: 'assistant', content: [
          { type: 'text', text: 'I considered https://assistant.example/text.png' },
          { type: 'reasoning', text: 'Maybe https://assistant.example/reasoning.png' }
        ] }
      ],
      compiledPrefixCount: 1
    }))

    expect(collector.run.pieces).toEqual([])
    expect(collector.run.unaccountedInputs).toBe(0)
    expect(finalizable(collector)).toBe(true)
  })

  it('vouches actual matching V4 tool-result text, never the assistant tool-call arguments', () => {
    const resultText = 'Fetched https://actual-result.example/image.png'
    const promptMessages = [
      { role: 'system', content: systemText },
      { role: 'user', content: 'Find an image' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input: { url: 'https://argument.example/not-read.png' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'lookup', output: { type: 'text', value: resultText } }] }
    ]
    const collector = new ApiImageInputCollector()
    collector.observe(observation({
      compiledMessages: [{ role: 'user', content: 'Find an image' }],
      promptMessages,
      userSources: [{ textHash: sha256Hex('Find an image'), spans: [{ start: 0, end: 'Find an image'.length, source: 'user' }] }]
    }))

    expect(collector.run.pieces).toContainEqual({ source: 'tool_result', text: resultText })
    expect(collector.run.pieces.some((piece) => piece.text.includes('argument.example'))).toBe(false)
    expect(collector.run).toMatchObject({ unaccountedInputs: 0, nonTextInputs: 0, providerExecutedTools: 0 })
  })

  it('does not vouch a final tool result that was not present in the observed prompt', () => {
    const promptMessages = [
      { role: 'system', content: systemText },
      { role: 'user', content: 'Do the lookup' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input: { url: 'https://arg.example' } }] }
    ]
    // This represents a result available later in the run, outside the dispatch observation.
    const laterResult = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'lookup', output: { type: 'text', value: 'https://later.example/final.png' } }] }
    const collector = new ApiImageInputCollector()
    collector.observe(observation({
      compiledMessages: [{ role: 'user', content: 'Do the lookup' }],
      promptMessages
    }))

    expect(collector.run.pieces).not.toContainEqual({ source: 'tool_result', text: laterResult.content[0].output.value })
    expect(collector.run.unaccountedInputs).toBeGreaterThan(0) // the dispatched call has no matching result yet
  })

  it.each([
    ['missing promptMessages', { promptMessages: undefined }],
    ['negative compiled prefix', { compiledPrefixCount: -1 }],
    ['role-user alignment mismatch', {
      compiledMessages: [{ role: 'user', content: 'expected source' }],
      promptMessages: [{ role: 'system', content: systemText }, { role: 'user', content: 'different prompt text' }]
    }],
    ['unknown tool output', {
      compiledMessages: [{ role: 'user', content: 'lookup' }],
      promptMessages: [
        { role: 'system', content: systemText }, { role: 'user', content: 'lookup' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'lookup', input: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'lookup', output: { type: 'mystery', value: 'https://unknown.example/not-read.png' } }] }
      ]
    }],
    ['unmatched tool call', {
      compiledMessages: [{ role: 'user', content: 'lookup' }],
      promptMessages: [
        { role: 'system', content: systemText }, { role: 'user', content: 'lookup' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'orphan-call', toolName: 'lookup', input: {} }] }
      ]
    }],
    ['unmatched tool result', {
      compiledMessages: [{ role: 'user', content: 'lookup' }],
      promptMessages: [
        { role: 'system', content: systemText }, { role: 'user', content: 'lookup' },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'orphan-result', toolName: 'lookup', output: { type: 'text', value: 'https://orphan.example/not-read.png' } }] }
      ]
    }],
    ['non-text user part', {
      compiledMessages: [{ role: 'user', content: [{ type: 'text', text: 'read this' }, { type: 'image', image: new Uint8Array([1]) }] }],
      promptMessages: [{ role: 'system', content: systemText }, { role: 'user', content: [{ type: 'text', text: 'read this' }, { type: 'image', image: new Uint8Array([1]) }] }],
      userSources: [{ textHash: sha256Hex('read this'), spans: [{ start: 0, end: 9, source: 'user' }] }]
    }],
    ['provider-executed tool marker', {
      compiledMessages: [{ role: 'user', content: 'lookup' }],
      promptMessages: [
        { role: 'system', content: systemText }, { role: 'user', content: 'lookup' },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'lookup', providerExecuted: true, output: { type: 'text', value: 'https://provider.example/not-read.png' } }] }
      ]
    }],
    ['provider tool definition', { toolDefinitions: [{ type: 'provider', id: 'lookup' }] }]
  ] as const)('fails closed for %s', (_label, overrides) => {
    const input = observation(overrides as any)
    const collector = new ApiImageInputCollector()
    collector.observe(input)

    expect(finalizable(collector)).toBe(false)
    expect(collector.run.unaccountedInputs + collector.run.nonTextInputs + collector.run.providerExecutedTools).toBeGreaterThan(0)
  })

  it('records the exact dispatched function schema as tool_result and deduplicates repeat observations', () => {
    const tool = { type: 'function', function: { name: 'lookup', description: 'Look up URL', parameters: { type: 'object', properties: { url: { type: 'string' } } } } }
    const input = observation({ toolDefinitions: [tool], compiledPrefixCount: 1 })
    const collector = new ApiImageInputCollector()

    collector.observe(input)
    collector.observe(input)

    expect(collector.run.pieces).toContainEqual({ source: 'tool_result', text: JSON.stringify(tool) })
    expect(collector.run.pieces.filter((piece) => piece.text === JSON.stringify(tool))).toHaveLength(1)
    expect(collector.run.unaccountedInputs).toBe(0)
  })

  it('labels server-built user and DM steer spans, including a mixed batch', () => {
    const steers: SteerEntry[] = [
      { steerId: 's-user', source: 'user', text: 'Please use https://user.example/image.png' },
      { steerId: 's-dm', source: 'dm', agentName: 'Mira', text: 'The reference is https://dm.example/image.png' }
    ]
    const text = buildSteerInjectionText(steers)
    const collector = new ApiImageInputCollector()
    collector.observe(observation({
      compiledMessages: [{ role: 'user', content: text }],
      promptMessages: [{ role: 'system', content: systemText }, { role: 'user', content: text }],
      userSources: [steerInputSource(steers)]
    }))

    expect(collector.run.pieces).toEqual([
      { source: 'user', text: formatSteerForModel(steers[0]) },
      { source: 'agent_note', text: formatSteerForModel(steers[1]) }
    ])
    expect(collector.run.unaccountedInputs).toBe(0)
  })

  it('rejects forged, mismatched, overlapping, and incomplete-hash sidecars without user labels', () => {
    const body = 'Read https://bound.example/image.png now'
    const start = body.indexOf('Read')
    const end = body.length
    const badSidecars = [
      [{ textHash: 'f'.repeat(64), spans: [{ start, end, source: 'user' }] }],
      [{ textHash: sha256Hex(body), spans: [{ start, end, source: 'user' }, { start: end - 2, end, source: 'agent_note' }] }],
      [{ textHash: sha256Hex(body), spans: [{ start: start + 5, end, source: 'user' }] }]
    ]

    for (const userSources of badSidecars) {
      const collector = new ApiImageInputCollector()
      collector.observe(observation({
        compiledMessages: [{ role: 'user', content: body }],
        promptMessages: [{ role: 'system', content: systemText }, { role: 'user', content: body }],
        userSources: readUserInputSources(userSources)
      }))
      expect(collector.run.pieces).toEqual([])
      expect(collector.run.unaccountedInputs).toBeGreaterThan(0)
    }

    expect(readUserInputSources([
      { textHash: 'not-a-hash', spans: [] },
      { textHash: sha256Hex(body), spans: [{ start: -1, end: 2, source: 'user' }] },
      { textHash: sha256Hex(body), spans: [{ start: 0, end: 2, source: 'forged-source' }] }
    ])).toEqual([])
  })

  it('carries exact hash/span bindings through two resumed observations and deduplicates pieces', () => {
    const steers: SteerEntry[] = [
      { steerId: 'resume-user', source: 'user', text: 'Resume with https://resume-user.example/image.png' },
      { steerId: 'resume-dm', source: 'dm', agentName: 'Ari', text: 'Also see https://resume-dm.example/image.png' }
    ]
    const sidecars = steerInputSource(steers)
    const restored = readUserInputSources(JSON.parse(JSON.stringify([sidecars])))
    const text = buildSteerInjectionText(steers)
    const makeInput = () => observation({
      compiledMessages: [{ role: 'user', content: text }],
      promptMessages: [{ role: 'system', content: systemText }, { role: 'user', content: text }],
      userSources: restored
    })
    const collector = new ApiImageInputCollector()

    collector.observe(makeInput())
    collector.observe(makeInput())

    expect(collector.run.pieces).toEqual([
      { source: 'user', text: formatSteerForModel(steers[0]) },
      { source: 'agent_note', text: formatSteerForModel(steers[1]) }
    ])
    expect(collector.run.unaccountedInputs).toBe(0)
  })

  it('keeps observation poison sticky after a later valid prompt and never mutates SDK inputs', () => {
    const input = observation()
    const frozen = deepFreeze(input)
    const collector = new ApiImageInputCollector()

    collector.observe({ ...input, promptMessages: undefined })
    collector.observe(frozen)

    expect(collector.compiledObserved).toBe(true)
    expect(collector.run.unaccountedInputs).toBeGreaterThan(0)
    expect(finalizable(collector)).toBe(false)
    expect(frozen).toEqual(input)
  })

  it('treats the SDK SystemModelMessage content as equal to the V4 system prompt string', () => {
    const collector = new ApiImageInputCollector()
    collector.observe(observation({
      compiledMessages: [{ role: 'user', content: 'ordinary text' }],
      promptMessages: [{ role: 'system', content: systemText }, { role: 'user', content: 'ordinary text' }],
      userSources: [{ textHash: sha256Hex('ordinary text'), spans: [{ start: 0, end: 'ordinary text'.length, source: 'user' }] }]
    }))

    expect(collector.compiledObserved).toBe(true)
    expect(collector.run.unaccountedInputs).toBe(0)
  })
})
