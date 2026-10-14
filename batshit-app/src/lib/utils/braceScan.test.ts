import { describe, expect, it } from 'vitest'
import { createNextIndexFinder, replaceBracedTokens, scanBracedTokens } from './braceScan'
import { unclosedReferenceReplies } from '$lib/test-utils/unclosedReferenceReplies'

/**
 * The literal patterns `saveMessage`'s `dedupeZipRefs` (`$lib/server/redis.ts`) used, kept here
 * only as oracles: the scan must find exactly their tokens and positions. Their `[^}]+` searched
 * to the first `}` again from every opener.
 */
const OLD_ZIP_TOKEN_REGEX = /\{\{batshit-zip:[^}]+\}\}/g
const OLD_TOOL_LOADING_PLACEHOLDER_REGEX = /\{\{TOOL_LOADING_PLACEHOLDER:[^}]+\}\}/g

function oldTokens(regex: RegExp, text: string) {
  return Array.from(text.matchAll(regex), (match) => ({
    start: match.index ?? -1,
    end: (match.index ?? -1) + match[0].length,
    match: match[0]
  }))
}

/** Deterministic, so a failure names a text that reproduces. */
function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOKENS = [
  '{{batshit-zip:', '{{batshit-zip:', '{{batshit-zip:', '{{TOOL_LOADING_PLACEHOLDER:',
  '{{TOOL_LOADING_PLACEHOLDER:', '}}', '}}', '}', '}}}', '{', '{{', ':', ':::', 'zip_1', 'tool_1',
  'cool_tool_1779416324513_abcd1', ' ', '\n', '\n\n\n', '\r\n', 'a', 'desc words', 'q'.repeat(170),
  '{{batshit-zip:zip_1}}', '{{batshit-zip:zip_1:::x}}', '{{batshit-clip:clip_1}}'
]

function generateTexts(count: number, seed: number): string[] {
  const random = seededRandom(seed)
  const texts: string[] = []
  for (let i = 0; i < count; i++) {
    const length = 1 + Math.floor(random() * 20)
    let text = ''
    for (let j = 0; j < length; j++) text += TOKENS[Math.floor(random() * TOKENS.length)]
    texts.push(text)
  }
  return texts
}

const CASES = [
  '{{batshit-zip:zip_1}} {{batshit-zip:zip_1}}',
  '{{batshit-zip:}}',
  '{{batshit-zip:}}}',
  '{{batshit-zip:a}}}',
  '{{batshit-zip:a} }}',
  '{{batshit-zip:a\nb {{ c :::d}}',
  '{{batshit-zip:' + 'a'.repeat(500) + '}}',
  '{{batshit-zip:a {{batshit-zip:b}}',
  '{{batshit-zip:a{{batshit-zip:b}} {{batshit-zip:a{{batshit-zip:b}}',
  '{{TOOL_LOADING_PLACEHOLDER:x}}{{batshit-zip:y}}',
  '{{TOOL_LOADING_PLACEHOLDER:}}',
  ''
]

describe('scanBracedTokens', () => {
  it('finds exactly the tokens and positions the literal old patterns found', () => {
    const texts = [...CASES, ...generateTexts(8_000, 990)]
    let zipTexts = 0
    let zipOpenersOnly = 0
    for (const text of texts) {
      const label = JSON.stringify(text)
      for (const [open, regex] of [
        ['{{batshit-zip:', OLD_ZIP_TOKEN_REGEX],
        ['{{TOOL_LOADING_PLACEHOLDER:', OLD_TOOL_LOADING_PLACEHOLDER_REGEX]
      ] as const) {
        expect(scanBracedTokens(text, open), label).toEqual(oldTokens(regex, text))
        const tag = (match: string) => `<${match.length}>`
        expect(replaceBracedTokens(text, open, tag), label).toBe(text.replace(regex, tag))
      }
      if (oldTokens(OLD_ZIP_TOKEN_REGEX, text).length > 0) zipTexts++
      else if (text.includes('{{batshit-zip:')) zipOpenersOnly++
    }
    expect(zipTexts).toBeGreaterThan(1_000)
    expect(zipOpenersOnly).toBeGreaterThan(1_000)
  })

  it('reads 1 MB of 20,000 openers that never close in well under 200 ms', () => {
    const replies = {
      ...unclosedReferenceReplies('zip'),
      ...unclosedReferenceReplies('toolLoadingPlaceholder')
    }
    for (const [shape, text] of Object.entries(replies)) {
      for (const open of ['{{batshit-zip:', '{{TOOL_LOADING_PLACEHOLDER:']) {
        const started = performance.now()
        expect(scanBracedTokens(text, open), shape).toEqual([])
        expect(performance.now() - started, shape).toBeLessThan(200)
      }
    }
  })
})

describe('createNextIndexFinder', () => {
  it('answers like indexOf, forward and backward, and content.length when there is none', () => {
    const text = 'a}b}}c}'
    const find = createNextIndexFinder(text, '}')
    for (const position of [0, 1, 2, 3, 5, 6, 7, 2, 0, 7, 4]) {
      const expected = text.indexOf('}', position)
      expect(find(position), String(position)).toBe(expected < 0 ? text.length : expected)
    }
  })
})
