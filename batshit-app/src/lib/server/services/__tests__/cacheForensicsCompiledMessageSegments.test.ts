import { describe, expect, it } from 'vitest'
import {
  COMPILED_HISTORY_SEGMENT_CAP,
  isCompiledHistorySegment,
  segmentCompiledUserMessage,
  splitCompiledUserMessageContent,
} from '$lib/server/services/cacheForensics/compiledMessageSegments'
import { segmentProviderRequestBody } from '$lib/server/services/cacheForensics/apiAdapter'
import { segmentCompiledMessages } from '$lib/server/services/cacheForensics/cliAdapter'

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
