import { describe, expect, it } from 'vitest'
import {
  formatToolModelTextCut,
  isToolModelCutView,
  planToolModelTextCut,
  TOOL_MODEL_RAW_MAX_CHARS,
  TOOL_MODEL_TEXT_MAX_CHARS
} from './toolModelTextSizeGuard'
import { guardCutNotice } from '$lib/test-utils/guard-cut-notice'

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

  it('gives memory an exact retry path without a raw copy or Fetch Zip claim', () => {
    const text = 'm'.repeat(TOOL_MODEL_RAW_MAX_CHARS + 5)
    const result = formatToolModelTextCut(text, { kind: 'memory' })
    expect(result.rawDroppedChars).toBe(5)
    expect(result.nextOffset).toBeNull()
    expect(result.text).toContain('Search again with a narrower query or a smaller limit, or recall one memory by its id.')
    expect(result.text).not.toContain('Fetch Zip')
    expect(result.text).not.toContain('raw copy')
    expect(result.text).not.toContain('later characters were dropped')
    expect(result.text.length).toBeLessThanOrEqual(TOOL_MODEL_TEXT_MAX_CHARS)
  })
})

// BL-678: the words of the notice anywhere in a text made a generic cut card (a Read of this
// file, a search of Batshit's code). Only the guard's own notice, at the very end, is a cut.
describe('recognizing a guard cut view', () => {
  const big = `line\n${'x'.repeat(150_000)}`
  // A notice saved before SA-139 R1 could also name a lane's model-facing byte budget.
  const savedLaneNotice = guardCutNotice(7_000, 'tool_raw_2', big.length)
    .replace(' Call Fetch Zip', ' The cli-fallback model-facing result budget is 8,000 UTF-8 bytes. Call Fetch Zip')
  const views = {
    fetchable: formatToolModelTextCut(big, 'tool_raw_1790000000000_abcd').text,
    'no Fetch Zip': formatToolModelTextCut(big, { kind: 'unavailable' }).text,
    'group chat, not this run': formatToolModelTextCut(big, { kind: 'group-unreadable' }).text,
    'not kept': formatToolModelTextCut(big, { kind: 'not-retained' }).text,
    memory: formatToolModelTextCut(big, { kind: 'memory' }).text,
    'saved lane byte budget': `${big.slice(0, 7_000)}\n${savedLaneNotice}`,
    'dropped tail': formatToolModelTextCut('z'.repeat(TOOL_MODEL_RAW_MAX_CHARS + 9), 'tool_raw_3').text,
    // SA-139 R5 removed the CLI helper's memory cut (`scripts/lib/cli-tool-memory-cut.cjs`). Its
    // output was byte-identical to the `memory` view above (checked on four inputs before the
    // removal), so a saved helper memory cut is the `memory` row.
    'saved lane byte budget, no prefix': savedLaneNotice
  }

  it.each(Object.entries(views))('knows a real %s cut view', (_label, view) => {
    expect(view).toContain('[Output cut here by Batshit: this result is about ')
    expect(isToolModelCutView(view)).toBe(true)
  })

  it('agrees with the test helper that writes the notice for fixtures', () => {
    const view = formatToolModelTextCut(`${'k'.repeat(5_000)}\n${'x'.repeat(200_000)}`, 'raw_1')
    expect(isToolModelCutView(`body\n${guardCutNotice(7_900, 'raw_1')}`)).toBe(true)
    expect(guardCutNotice(view.keptChars, 'raw_1', 205_001)).toBe(
      view.text.slice(view.text.lastIndexOf('[Output cut here by Batshit'))
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
