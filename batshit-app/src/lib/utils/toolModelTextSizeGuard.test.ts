import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import {
  formatToolModelTextCut,
  isToolModelCutView,
  planToolModelTextCut,
  TOOL_MODEL_RAW_MAX_CHARS,
  TOOL_MODEL_TEXT_MAX_CHARS
} from './toolModelTextSizeGuard'
import { guardCutNotice } from '$lib/test-utils/guard-cut-notice'

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length
const { formatMemoryResultCut } = createRequire(import.meta.url)('../../../scripts/lib/cli-tool-memory-cut.cjs')

describe('tool model text size guard', () => {
  it('starts at the 25,000-token estimate, including the four-character boundary', () => {
    expect(planToolModelTextCut('x'.repeat(99_996)).cut).toBe(false)
    expect(planToolModelTextCut('x'.repeat(99_997)).cut).toBe(true)
    const small = formatToolModelTextCut('x'.repeat(99_996), '')
    expect(small.text).toHaveLength(99_996)
    expect(small.nextOffset).toBeNull()
  })

  // BL-677: at 100,000 characters (exactly 25,000 tokens) a first part with no line end was
  // itself too large: cut again by a second guard, never opened by Off or a Hold, and a text of
  // 99,997–100,000 characters came back longer than it went in.
  it('keeps every cut view at 96,000 characters, under the guard it came from', () => {
    expect(TOOL_MODEL_TEXT_MAX_CHARS).toBe(96_000)
    for (const [label, text] of [
      ['one long line', 'x'.repeat(99_997)],
      ['one long line at 100,000', 'x'.repeat(100_000)],
      ['CJK with no line end', '漢'.repeat(150_000)],
      ['emoji with no line end', '😀'.repeat(60_000)],
      ['very large', 'y'.repeat(3_100_000)]
    ] as const) {
      const first = formatToolModelTextCut(text, 'raw-zip-677')
      expect(first.cut, label).toBe(true)
      expect(first.text.length, label).toBeLessThanOrEqual(96_000)
      expect(first.text.length, label).toBeLessThan(text.length)
      expect(Math.ceil(first.text.length / 4), label).toBeLessThan(25_000)
      // A second guard on the same text (a helper, then the compile) leaves it alone.
      const second = formatToolModelTextCut(first.text, 'raw-zip-second-pass')
      expect(second.cut, label).toBe(false)
      expect(second.text, label).toBe(first.text)
    }
  })

  it('keeps a byte-budgeted view under the character ceiling too', () => {
    const result = formatToolModelTextCut('a'.repeat(200_000), 'raw-zip-677', undefined, {
      maxUtf8Bytes: 300_000, source: 'codex-profile'
    })
    expect(result.text.length).toBeLessThanOrEqual(96_000)
    expect(planToolModelTextCut(result.text).cut).toBe(false)
  })

  it('keeps whole lines where useful and leaves room for one actionable cut notice', () => {
    const text = `${'a'.repeat(90_000)}\n${'b'.repeat(40_000)}\n`
    const result = formatToolModelTextCut(text, 'raw-zip-1')
    expect(result.cut).toBe(true)
    expect(result.keptChars).toBe(90_001)
    expect(result.text.slice(0, result.keptChars)).toBe(text.slice(0, result.keptChars))
    expect(result.text).toContain('Call Fetch Zip with zipId raw-zip-1 and offset 90001')
    expect(result.text.match(/\[Output cut here by Batshit:/g)).toHaveLength(1)
    expect(result.text.length).toBeLessThanOrEqual(TOOL_MODEL_TEXT_MAX_CHARS)
  })

  it('keeps a useful partial long line without splitting a surrogate pair', () => {
    const text = '🎯'.repeat(65_000)
    const result = formatToolModelTextCut(text, 'raw-zip-2')
    expect(result.keptChars).toBeGreaterThan(75_000)
    expect(result.keptChars % 2).toBe(0)
    expect(result.text.charCodeAt(result.keptChars - 1)).not.toBe(0xd83c)
    expect(result.nextOffset).toBe(result.keptChars)
    expect(result.text.length).toBeLessThanOrEqual(TOOL_MODEL_TEXT_MAX_CHARS)
  })

  it('caps the raw copy and explicitly reports dropped text', () => {
    const text = `${'x'.repeat(TOOL_MODEL_RAW_MAX_CHARS)}tail`
    const plan = planToolModelTextCut(text)
    expect(plan.rawText).toHaveLength(TOOL_MODEL_RAW_MAX_CHARS)
    expect(plan.rawDroppedChars).toBe(4)
    const result = formatToolModelTextCut(text, 'raw-zip-3')
    expect(result.text).toContain('4 later characters were dropped')
    expect(result.text.length).toBeLessThanOrEqual(TOOL_MODEL_TEXT_MAX_CHARS)
  })

  it('accounts for a helper tail omitted before transport without inventing retained bytes', () => {
    const delivered = 'x'.repeat(TOOL_MODEL_RAW_MAX_CHARS)
    const originalTextChars = TOOL_MODEL_RAW_MAX_CHARS + 1_000_000
    const plan = planToolModelTextCut(delivered, originalTextChars)
    expect(plan.totalChars).toBe(originalTextChars)
    expect(plan.estimatedTokens).toBe(2_250_000)
    expect(plan.rawText).toBe(delivered)
    expect(plan.rawDroppedChars).toBe(1_000_000)
    const result = formatToolModelTextCut(delivered, 'raw-zip-4', originalTextChars)
    expect(result.text).toContain('9,000,000 characters')
    expect(result.text).toContain('1,000,000 later characters were dropped')
    expect(result.text.length).toBeLessThanOrEqual(TOOL_MODEL_TEXT_MAX_CHARS)
  })

  it.each([7, 8.5, Number.MAX_SAFE_INTEGER + 1, -1])('rejects an invalid original length %s', (length) => {
    expect(() => planToolModelTextCut('12345678', length)).toThrow('Original tool text length')
  })

  it('counts a surrogate-safe shortened transfer by the characters actually retained', () => {
    const delivered = 'x'.repeat(TOOL_MODEL_RAW_MAX_CHARS - 1)
    const plan = planToolModelTextCut(delivered, TOOL_MODEL_RAW_MAX_CHARS + 10)
    expect(plan.rawText.length).toBe(TOOL_MODEL_RAW_MAX_CHARS - 1)
    expect(plan.rawDroppedChars).toBe(11)
    const shorter = planToolModelTextCut('x'.repeat(100_000), 9_000_000)
    expect(shorter.rawDroppedChars).toBe(8_900_000)
  })

  it('requires a safe server-created zip id only when a cut is needed', () => {
    expect(formatToolModelTextCut('short', '').text).toBe('short')
    expect(() => formatToolModelTextCut('x'.repeat(100_000), 'bad\nzip')).toThrow()
  })

  it('keeps legacy output byte-identical when no lane byte budget is supplied', () => {
    const text = 'x'.repeat(100_000)
    const baseline = formatToolModelTextCut(text, 'raw-zip')
    expect(formatToolModelTextCut(text, 'raw-zip', undefined, {})).toEqual(baseline)
    expect(baseline.text).not.toContain('UTF-8 bytes')
  })

  it('cuts ASCII below 25,000 tokens at the actual model lane byte cap', () => {
    const text = 'x'.repeat(20_000)
    const budget = { maxUtf8Bytes: 8_000, source: 'codex-profile' }
    expect(planToolModelTextCut(text, undefined, budget).cut).toBe(true)
    const result = formatToolModelTextCut(text, 'raw-zip', undefined, budget)
    expect(result.text).toContain('codex-profile model-facing result budget is 8,000 UTF-8 bytes')
    expect(result.text).toContain(`Call Fetch Zip with zipId raw-zip and offset ${result.keptChars}`)
    expect(result.text.slice(0, result.keptChars)).toBe(text.slice(0, result.keptChars))
    expect(result.nextOffset).toBe(result.keptChars)
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(8_000)
    expect(result.text.length).toBeLessThanOrEqual(TOOL_MODEL_TEXT_MAX_CHARS)
  })

  it('counts CJK, emoji, CRLF and control bytes without splitting a surrogate or changing the offset unit', () => {
    const text = ('漢🙂\r\n\u001b[31m行').repeat(2_000)
    const budget = { maxUtf8Bytes: 6_000, source: 'codex-fallback' }
    const result = formatToolModelTextCut(text, 'unicode-zip', undefined, budget)
    expect(result.cut).toBe(true)
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(6_000)
    expect(result.text.slice(0, result.keptChars)).toBe(text.slice(0, result.keptChars))
    expect(result.nextOffset).toBe(result.keptChars)
    expect(result.text.charCodeAt(result.keptChars - 1)).not.toBe(0xd83d)
    expect(result.text).toContain(`offset ${result.keptChars}`)
  })

  it('uses decoded UTF-8 byte equality without cutting an otherwise small result', () => {
    const text = '漢'.repeat(1_000)
    expect(utf8Bytes(text)).toBe(3_000)
    expect(planToolModelTextCut(text, undefined, { maxUtf8Bytes: 3_000 }).cut).toBe(false)
    expect(formatToolModelTextCut(text, '', undefined, { maxUtf8Bytes: 3_000 }).text).toBe(text)
    expect(planToolModelTextCut(text, undefined, { maxUtf8Bytes: 2_999 }).cut).toBe(true)
  })

  it('falls back to a bounded refusal when its full notice cannot fit, with no prefix or id', () => {
    const text = 'x'.repeat(10_000)
    for (const limit of [1, 3, 12, 40, 100]) {
      const result = formatToolModelTextCut(text, 'must-not-leak', undefined, {
        maxUtf8Bytes: limit, source: 'codex-profile'
      })
      expect(utf8Bytes(result.text)).toBeLessThanOrEqual(limit)
      expect(result.keptChars).toBe(0)
      expect(result.nextOffset).toBeNull()
      expect(result.text).not.toContain('must-not-leak')
      expect(result.text).not.toContain('offset')
      expect(result.text).not.toContain('xxxxx')
    }
    expect(formatToolModelTextCut(text, 'id', undefined, { maxUtf8Bytes: 12 }).text).toBe('[Output cut]')
    expect(formatToolModelTextCut(text, 'id', undefined, { maxUtf8Bytes: 3 }).text).toBe('CUT')
  })

  it('sanitizes a budget source and preserves the raw 8M cap and dropped count', () => {
    const text = `${'x'.repeat(TOOL_MODEL_RAW_MAX_CHARS)}tail`
    const result = formatToolModelTextCut(text, 'raw-zip', undefined, {
      maxUtf8Bytes: 10_000, source: 'Codex]\nforged'
    })
    expect(result.rawText.length).toBe(TOOL_MODEL_RAW_MAX_CHARS)
    expect(result.rawDroppedChars).toBe(4)
    expect(result.text).toContain('model lane model-facing result budget is 10,000 UTF-8 bytes')
    expect(result.text).toContain('4 later characters were dropped')
    expect(result.text).not.toContain('forged')
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(10_000)
  })

  it('gives memory an exact retry path without a raw copy or Fetch Zip claim', () => {
    const text = 'm'.repeat(TOOL_MODEL_RAW_MAX_CHARS + 5)
    const result = formatToolModelTextCut(text, { kind: 'memory' }, undefined, { maxUtf8Bytes: 5_000 })
    expect(result.rawDroppedChars).toBe(5)
    expect(result.nextOffset).toBeNull()
    expect(result.text).toContain('Search again with a narrower query or a smaller limit, or recall one memory by its id.')
    expect(result.text).not.toContain('Fetch Zip')
    expect(result.text).not.toContain('raw copy')
    expect(result.text).not.toContain('later characters were dropped')
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(5_000)
  })

  it('honors an authenticated zero-byte budget without delivering a prefix, id, or offset', () => {
    const budget = { maxUtf8Bytes: 0, source: 'codex-profile' }
    expect(planToolModelTextCut('abc', undefined, budget).cut).toBe(true)
    const result = formatToolModelTextCut('abc', 'raw-zip', undefined, budget)
    expect(result.text).toBe('')
    expect(result.keptChars).toBe(0)
    expect(result.nextOffset).toBeNull()
    expect(result.rawText).toBe('abc')
    expect(formatToolModelTextCut('', 'raw-zip', undefined, budget).text).toBe('')
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid byte budget %s', (limit) => {
    expect(() => planToolModelTextCut('abc', undefined, { maxUtf8Bytes: limit })).toThrow('non-negative safe integer')
  })
})

// BL-678: the words of the notice anywhere in a text made a generic cut card (a Read of this
// file, a search of Batshit's code). Only the guard's own notice, at the very end, is a cut.
describe('recognizing a guard cut view', () => {
  const big = `line\n${'x'.repeat(150_000)}`
  const views = {
    fetchable: formatToolModelTextCut(big, 'tool_raw_1790000000000_abcd').text,
    'no Fetch Zip': formatToolModelTextCut(big, { kind: 'unavailable' }).text,
    'group chat, not this run': formatToolModelTextCut(big, { kind: 'group-unreadable' }).text,
    'not kept': formatToolModelTextCut(big, { kind: 'not-retained' }).text,
    memory: formatToolModelTextCut(big, { kind: 'memory' }).text,
    'byte budget': formatToolModelTextCut(big, 'tool_raw_2', undefined, { maxUtf8Bytes: 8_000, source: 'codex-fallback' }).text,
    'dropped tail': formatToolModelTextCut('z'.repeat(TOOL_MODEL_RAW_MAX_CHARS + 9), 'tool_raw_3').text,
    'no prefix': formatToolModelTextCut('q'.repeat(200_000), 'tool_raw_4', undefined, { maxUtf8Bytes: 400, source: 'codex-profile' }).text,
    'helper memory cut': formatMemoryResultCut(big, big.length)
  }

  it.each(Object.entries(views))('knows a real %s cut view', (_label, view) => {
    expect(view).toContain('[Output cut here by Batshit: this result is about ')
    expect(isToolModelCutView(view)).toBe(true)
  })

  it('agrees with the test helper that writes the notice for fixtures', () => {
    const view = formatToolModelTextCut(`${'k'.repeat(5_000)}\n${'x'.repeat(200_000)}`, 'raw_1', undefined, {
      maxUtf8Bytes: 5_600, source: 'codex-fallback'
    })
    expect(isToolModelCutView(`body\n${guardCutNotice(7_900, 'raw_1')}`)).toBe(true)
    expect(guardCutNotice(view.keptChars, 'raw_1', 205_001)).toBe(
      view.text.slice(view.text.lastIndexOf('[Output cut here by Batshit')).replace(' The codex-fallback model-facing result budget is 5,600 UTF-8 bytes.', '')
    )
  })

  it('reads the words anywhere else as ordinary text', () => {
    const notice = views.fetchable.slice(views.fetchable.lastIndexOf('\n') + 1)
    for (const [label, text] of [
      ['source that prints the words', "return `[Output cut here by Batshit: this result is about ${tokens} tokens`\nmore code"],
      ['a real notice mid-text', `before\n${notice}\nafter`],
      ['a real notice with text after it', `${views.fetchable}\n`],
      ['a notice not on its own line', `abc${notice}`],
      ['a runner stream cut', 'out\n[Output cut here by Batshit: the command printed more than 1,000 characters.]'],
      ['a loose look-alike', 'out\n[Output cut here by Batshit; fetch the next page.]'],
      ['a changed sentence', views['no Fetch Zip'].replace('Run the tool again', 'Try again')],
      ['over the ceiling', `${'x'.repeat(96_000)}\n${notice}`]
    ] as const) {
      expect(isToolModelCutView(text), label).toBe(false)
    }
  })
})
