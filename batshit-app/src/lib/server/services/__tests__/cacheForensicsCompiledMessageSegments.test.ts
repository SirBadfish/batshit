import { describe, expect, it } from 'vitest'
import {
  COMPILED_HISTORY_SEGMENT_CAP,
  COMPILED_TEXT_PART_TYPES,
  compiledTextPartValue,
  isCompiledHistorySegment,
  segmentCompiledUserMessage,
  splitCompiledUserMessageContent,
} from '$lib/server/services/cacheForensics/compiledMessageSegments'
import { segmentProviderRequestBody } from '$lib/server/services/cacheForensics/apiAdapter'
import { segmentCompiledMessages } from '$lib/server/services/cacheForensics/cliAdapter'
import { analyzeDivergence } from '$lib/server/services/cacheForensics/divergence'
import {
  fingerprintSegments,
  resolveCacheForensicsKey,
} from '$lib/server/services/cacheForensics/fingerprint'

/**
 * SA-108: Batshit compiles the whole conversation into ONE user message. These
 * fixtures mirror exactly what `buildFormattedChatInput` emits so the splitter
 * is pinned to the real compiled shape, not a guess at it.
 */
function compiled(historyMessages: string[], current: string, zipAppend?: string): string {
  const parts: string[] = []
  if (historyMessages.length > 0) {
    const history = historyMessages.join('\n\n---\n\n').trim()
    const withZips = zipAppend ? `${history}\n\n${zipAppend}` : history
    parts.push(`==== PREVIOUS CONVERSATION ====\n\n${withZips}`)
  }
  parts.push(`==== CURRENT USER MESSAGE ====\n\n${current}`)
  return parts.join('\n\n')
}

const TURN_1_USER = '**October 3, 2026 at 9:14 AM**\nU: first question'
const TURN_1_ASSISTANT = 'Assistant: first answer'
const TURN_2_USER = '**9:15 AM**\nU: second question'
const TURN_2_ASSISTANT = 'Assistant: second answer'

describe('compiled user message splitting (SA-108)', () => {
  describe('splitCompiledUserMessageContent', () => {
    it('splits history per message and keeps the current turn whole', () => {
      const text = compiled([TURN_1_USER, TURN_1_ASSISTANT], '**9:15 AM**\nU: third question\n\nDCM')
      const split = splitCompiledUserMessageContent(text)

      expect(split.matched).toBe(true)
      expect(split.historyMessages).toEqual([TURN_1_USER, TURN_1_ASSISTANT])
      expect(split.zipAppend).toBeNull()
      expect(split.current).toBe('==== CURRENT USER MESSAGE ====\n\n**9:15 AM**\nU: third question\n\nDCM')
    })

    it('hashes a history message identically whether it is last or followed by newer turns', () => {
      const turn2 = splitCompiledUserMessageContent(compiled([TURN_1_USER, TURN_1_ASSISTANT], 'q2'))
      const turn3 = splitCompiledUserMessageContent(
        compiled([TURN_1_USER, TURN_1_ASSISTANT, TURN_2_USER, TURN_2_ASSISTANT], 'q3'),
      )

      // The pre-marker '\n\n' must not stick to the last history chunk, or a
      // healthy append would look like the last message mutated.
      expect(turn3.historyMessages.slice(0, 2)).toEqual(turn2.historyMessages)
    })

    it('treats a cold send (no history) as current-only', () => {
      const split = splitCompiledUserMessageContent(compiled([], 'first ever message'))
      expect(split.matched).toBe(true)
      expect(split.historyMessages).toEqual([])
      expect(split.current).toContain('first ever message')
    })

    it('isolates the appended agent-managed zip block from history messages', () => {
      const zipBlock =
        '==== UNZIP INDEX (chronological) ====\n1) msg | tool: read_file | zipId (use in unzip/zip): zip_1'
      const split = splitCompiledUserMessageContent(
        compiled([TURN_1_USER, TURN_1_ASSISTANT], 'next', zipBlock),
      )
      expect(split.historyMessages).toEqual([TURN_1_USER, TURN_1_ASSISTANT])
      expect(split.zipAppend).toBe(zipBlock)
    })

    it('does not touch content without Batshit compile markers', () => {
      expect(splitCompiledUserMessageContent('just a plain provider message').matched).toBe(false)
      expect(splitCompiledUserMessageContent('').matched).toBe(false)
      expect(splitCompiledUserMessageContent(null).matched).toBe(false)
      expect(splitCompiledUserMessageContent({ role: 'user' }).matched).toBe(false)
    })
  })

  describe('segmentCompiledUserMessage', () => {
    it('emits ordered history + zips + current sub-segments with code-owned labels', () => {
      const zipBlock = '==== UNZIP INDEX (chronological) ====\n1) msg'
      const segments = segmentCompiledUserMessage(
        compiled([TURN_1_USER, TURN_1_ASSISTANT], 'next', zipBlock),
        'body.messages[1]:user',
      )
      expect(segments?.map((segment) => segment.label)).toEqual([
        'body.messages[1]:user#history[0]',
        'body.messages[1]:user#history[1]',
        'body.messages[1]:user#zips',
        'body.messages[1]:user#current',
      ])
      expect(segments?.map((segment) => segment.type)).toEqual([
        'history-message',
        'history-message',
        'history-message',
        'current-user-turn',
      ])
    })

    it('folds history past the cap into one trailing segment, keeping the oldest addressable', () => {
      const many = Array.from({ length: COMPILED_HISTORY_SEGMENT_CAP + 5 }, (_, i) => `msg ${i}`)
      const segments = segmentCompiledUserMessage(compiled(many, 'next'), 'body.messages[1]:user')
      const historySegments = segments!.filter(isCompiledHistorySegment)

      expect(historySegments).toHaveLength(COMPILED_HISTORY_SEGMENT_CAP + 1)
      expect(historySegments[0].content).toBe('msg 0')
      expect(historySegments.at(-1)!.label).toBe('body.messages[1]:user#history[tail]')
      expect(historySegments.at(-1)!.content).toBe(
        many.slice(COMPILED_HISTORY_SEGMENT_CAP).join('\n\n---\n\n'),
      )
    })

    it('returns null for non-Batshit content so callers keep their single segment', () => {
      expect(segmentCompiledUserMessage('plain', 'body.messages[0]:user')).toBeNull()
    })
  })

  describe('adapter wiring', () => {
    it('sub-segments the compiled user message on the API provider-request boundary', () => {
      const { segments } = segmentProviderRequestBody({
        model: 'glm-5.3-flash',
        messages: [
          { role: 'system', content: 'compiled system prompt' },
          { role: 'user', content: compiled([TURN_1_USER, TURN_1_ASSISTANT], 'next') },
        ],
      })
      expect(segments.map((segment) => segment.label)).toEqual([
        'body.model',
        'body.messages[0]:system',
        'body.messages[1]:user#history[0]',
        'body.messages[1]:user#history[1]',
        'body.messages[1]:user#current',
      ])
    })

    it('keeps non-text content parts as their own segments (vision stays non-lossy)', () => {
      const { segments } = segmentProviderRequestBody({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: compiled([TURN_1_USER], 'next') },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      })
      expect(segments.map((segment) => segment.label)).toEqual([
        'body.messages[0]:user#history[0]',
        'body.messages[0]:user#current',
        'body.messages[0]:user#part[1]:image_url',
      ])
    })

    it('leaves ordinary provider messages as single segments', () => {
      const { segments } = segmentProviderRequestBody({
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        ],
      })
      expect(segments.map((segment) => segment.label)).toEqual([
        'body.messages[0]:user',
        'body.messages[1]:assistant',
      ])
    })

    it('sub-segments the CLI batshit-compiled boundary the same way', () => {
      const segments = segmentCompiledMessages([
        { role: 'user', content: compiled([TURN_1_USER, TURN_1_ASSISTANT], 'next') },
      ])
      expect(segments.map((segment) => segment.label)).toEqual([
        'prompt.messages[0]:user#history[0]',
        'prompt.messages[0]:user#history[1]',
        'prompt.messages[0]:user#current',
      ])
    })
  })

  describe('isCompiledHistorySegment', () => {
    it('matches only per-message history sub-segments', () => {
      expect(
        isCompiledHistorySegment({ type: 'history-message', label: 'body.messages[1]:user#history[0]' }),
      ).toBe(true)
      expect(
        isCompiledHistorySegment({ type: 'history-message', label: 'body.messages[1]:user#history[tail]' }),
      ).toBe(true)
      expect(
        isCompiledHistorySegment({ type: 'history-message', label: 'body.messages[1]:user#zips' }),
      ).toBe(false)
      expect(
        isCompiledHistorySegment({ type: 'current-user-turn', label: 'body.messages[1]:user#current' }),
      ).toBe(false)
      expect(isCompiledHistorySegment({ type: 'history-message', label: 'body.messages[0]:user' })).toBe(
        false,
      )
    })
  })
})

/**
 * DQ-D-028 (splitter v3): Responses-shaped wire bodies.
 *
 * Batshit builds xAI with `createXai`, whose DEFAULT model is the Responses
 * model, and direct OpenAI runs in Responses mode too. Those requests are a
 * `body.input[]` item list, not a `messages` array: text parts are typed
 * `input_text`, images `input_image`, tool results are `function_call_output`
 * items, and `instructions` is the system-instruction field.
 *
 * These fixtures mirror the installed converters — `convertToXaiResponsesInput`
 * (@ai-sdk/xai 4.0.50) and `convert-to-openai-responses-input` (@ai-sdk/openai)
 * — so the splitter is pinned to the real wire shape, not a guess at it.
 */
describe('Responses-shaped request bodies (DQ-D-028, splitter v3)', () => {
  const SYSTEM_PROMPT = 'compiled system prompt'

  /** xAI: system as a plain string item, user content as `input_text` parts. */
  function xaiBody(historyMessages: string[], current: string) {
    return {
      model: 'grok-4.20-non-reasoning',
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [{ type: 'input_text', text: compiled(historyMessages, current) }],
        },
      ],
      max_output_tokens: 4096,
      temperature: 0.7,
    }
  }

  /** OpenAI Responses: `developer` role, an attached image, and a tool loop. */
  const OPENAI_RESPONSES_BODY = {
    model: 'gpt-5.5',
    input: [
      { role: 'developer', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: compiled([TURN_1_USER, TURN_1_ASSISTANT], 'next') },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
        ],
      },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'native_batshit_tool_use',
        arguments: '{}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'screenshot captured' },
          { type: 'input_image', image_url: 'data:image/png;base64,BBBB' },
        ],
      },
    ],
    instructions: 'provider-option instructions',
    tools: [{ type: 'function', name: 'native_batshit_tool_use', parameters: {} }],
    max_output_tokens: 4096,
  }

  it('recognises the text-part types Batshit providers actually emit', () => {
    expect([...COMPILED_TEXT_PART_TYPES]).toEqual(['text', 'input_text'])
    expect(compiledTextPartValue({ type: 'input_text', text: 'hi' })).toBe('hi')
    expect(compiledTextPartValue({ type: 'text', text: 'hi' })).toBe('hi')
    // A recognised type whose `text` is not a string keeps its own segment.
    expect(compiledTextPartValue({ type: 'input_text', text: 12 })).toBeNull()
    // Never a heuristic: an unlisted part type is left alone even with `.text`.
    expect(compiledTextPartValue({ type: 'output_text', text: 'hi' })).toBeNull()
    expect(compiledTextPartValue({ type: 'input_image', image_url: 'x' })).toBeNull()
    expect(compiledTextPartValue(null)).toBeNull()
  })

  it('sub-segments the compiled user message inside an xAI `input_text` part', () => {
    const { segments } = segmentProviderRequestBody(
      xaiBody([TURN_1_USER, TURN_1_ASSISTANT], 'next'),
    )
    expect(segments.map((segment) => segment.label)).toEqual([
      'body.model',
      'body.input[0]:system',
      'body.input[1]:user#history[0]',
      'body.input[1]:user#history[1]',
      'body.input[1]:user#current',
      'body.max_output_tokens',
      'body.temperature',
    ])
    expect(segments[1].type).toBe('history-message')
    expect(segments.filter((segment) => segment.type === 'current-user-turn')).toHaveLength(1)
  })

  it('labels Responses items by type, keeps images and tool results addressable', () => {
    const { segments } = segmentProviderRequestBody(OPENAI_RESPONSES_BODY)
    expect(segments.map((segment) => segment.label)).toEqual([
      'body.model',
      'body.input[0]:developer',
      'body.input[1]:user#history[0]',
      'body.input[1]:user#history[1]',
      'body.input[1]:user#current',
      'body.input[1]:user#part[1]:input_image',
      'body.input[2]:function_call:native_batshit_tool_use',
      'body.input[3]:function_call_output',
      'body.instructions',
      'body.tools[0]:native_batshit_tool_use',
      'body.max_output_tokens',
    ])
    // `instructions` is the Responses API's system-instruction field.
    expect(segments.find((segment) => segment.label === 'body.instructions')?.type).toBe(
      'system-prompt',
    )
    // The image and the tool result stay separately addressable.
    expect(
      segments.find((segment) => segment.label === 'body.input[1]:user#part[1]:input_image')?.type,
    ).toBe('attachment')
  })

  it('is deterministic: the same Responses body fingerprints identically twice', () => {
    const key = resolveCacheForensicsKey()
    const once = fingerprintSegments(
      key,
      segmentProviderRequestBody(OPENAI_RESPONSES_BODY).segments,
    ).segments.map((segment) => segment.hmac)
    const twice = fingerprintSegments(
      key,
      segmentProviderRequestBody(JSON.stringify(OPENAI_RESPONSES_BODY)).segments,
    ).segments.map((segment) => segment.hmac)
    expect(twice).toEqual(once)
  })

  it('reports a real historyStability verdict and a growing prefix across turns', () => {
    const key = resolveCacheForensicsKey()
    const fingerprint = (body: unknown) =>
      fingerprintSegments(key, segmentProviderRequestBody(body).segments).segments

    const turn2 = fingerprint(xaiBody([TURN_1_USER, TURN_1_ASSISTANT], 'q2'))
    const turn3 = fingerprint(
      xaiBody([TURN_1_USER, TURN_1_ASSISTANT, TURN_2_USER, TURN_2_ASSISTANT], 'q3'),
    )

    const divergence = analyzeDivergence(turn3, turn2)
    // Before v3 this read `not-applicable (0->0)` on every xAI/OpenAI-Responses
    // send, because the compiled message never split.
    expect(divergence.historyStability).toMatchObject({
      state: 'append-only',
      baselineSegments: 2,
      currentSegments: 4,
    })
    // And the reusable prefix was frozen at the system item; it must now grow
    // as the conversation does.
    const turn2Prefix = analyzeDivergence(
      turn2,
      fingerprint(xaiBody([], 'cold')),
    ).reusablePrefixBytes
    expect(divergence.reusablePrefixBytes).toBeGreaterThan(turn2Prefix)
  })

  it('names the offending history message when an older turn changed', () => {
    const key = resolveCacheForensicsKey()
    const fingerprint = (body: unknown) =>
      fingerprintSegments(key, segmentProviderRequestBody(body).segments).segments

    const baseline = fingerprint(xaiBody([TURN_1_USER, TURN_1_ASSISTANT], 'q2'))
    const mutated = fingerprint(
      xaiBody([TURN_1_USER, 'Assistant: first answer (rewritten)', TURN_2_USER], 'q3'),
    )

    expect(analyzeDivergence(mutated, baseline).historyStability).toMatchObject({
      state: 'mutated',
      firstChangedIndex: 1,
      firstChangedLabel: 'body.input[1]:user#history[1]',
    })
  })

  it('leaves chat-shaped bodies byte-identical (the Responses label rule stays scoped)', () => {
    const key = resolveCacheForensicsKey()
    // OpenAI CHAT tools carry `type: 'function'`. A type-first label rule would
    // relabel them; the rule is scoped to the `input` array so they must not move.
    const chatBody = {
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: compiled([TURN_1_USER], 'next') },
      ],
      tools: [{ type: 'function', function: { name: 'native_batshit_tool_use' } }],
    }
    const { segments } = segmentProviderRequestBody(chatBody)
    expect(segments.map((segment) => segment.label)).toEqual([
      'body.model',
      'body.messages[0]:system',
      'body.messages[1]:user#history[0]',
      'body.messages[1]:user#current',
      'body.tools[0]:native_batshit_tool_use',
    ])
    // Same body, same hashes, every time — no shape drift snuck in.
    expect(fingerprintSegments(key, segments).segments.map((segment) => segment.hmac)).toEqual(
      fingerprintSegments(key, segmentProviderRequestBody(chatBody).segments).segments.map(
        (segment) => segment.hmac,
      ),
    )
  })

  it('keeps the standing Awareness media rule working on the Responses shape', () => {
    const { segments } = segmentProviderRequestBody({
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '==== AWARENESS MEDIA (STANDING) ====\n- portrait.png - image',
            },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
            { type: 'input_text', text: '==== CURRENT USER MESSAGE ====\n\nhello' },
          ],
        },
      ],
    })
    expect(segments.map((segment) => segment.label)).toEqual([
      'body.input[0]:user#standing',
      'body.input[0]:user#current',
    ])
  })
})
