import { describe, expect, it } from 'vitest'
import { createReference, extractAllReferences } from './universalResolver'
import { unclosedReferenceReplies } from '$lib/test-utils/unclosedReferenceReplies'

/**
 * The literal pattern `extractAllReferences` used, kept here only as the oracle: the scan must
 * find exactly its references, types, ids, and contents, in order. Its lazy id and `[^}]+`
 * content searched the rest of the text again from every opener.
 */
const OLD_UNIVERSAL_REGEX = /\{\{(batshit-zip|batshit-clip):([^:]+?)(?::::([^}]+))?\}\}/g

function oldExtractAllReferences(text: string) {
  return Array.from(text.matchAll(OLD_UNIVERSAL_REGEX), (match) => {
    const [fullMatch, fullTypeStr, id, optionalContent] = match
    return {
      fullMatch,
      type: fullTypeStr.replace('batshit-', '') as 'zip' | 'clip',
      id,
      optionalContent: optionalContent || undefined
    }
  })
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
  '{{batshit-zip:', '{{batshit-zip:', '{{batshit-clip:', '{{batshit-clip:', '{{batshit-', '{{batshit-zap:',
  '{{batshit-zip', ':::', ':::', '::', ':', '}}', '}}', '}', '}}}', '{', '{{', 'zip_1', 'clip_1',
  'cool_tool_1779416324513_abcd1', ' ', '\n', '\r\n', 'a', 'desc words', 'q'.repeat(170),
  '{{batshit-clip|id:c}}x{{/batshit-clip}}'
]

function generateTokenTexts(count: number, seed: number): string[] {
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

/** References built part by part, so most are a reference or one rule short of one. */
function generateReferenceTexts(count: number, seed: number): string[] {
  const random = seededRandom(seed)
  const pick = (list: string[]) => list[Math.floor(random() * list.length)]
  const idParts = ['zip_1', 'clip_1', 'a', ' ', '\n', '{', '}', '}}', '|', 'q'.repeat(80)]
  const contentParts = ['desc', ' ', '\n', '{', '}', ':::', ':', '{{batshit-zip:b}}', 'x'.repeat(60)]
  const closers = ['}}', '}}', '}}', '}', '} }', '}}}', '']
  const texts: string[] = []
  for (let i = 0; i < count; i++) {
    const segments = 1 + Math.floor(random() * 4)
    let text = ''
    for (let j = 0; j < segments; j++) {
      if (random() < 0.2) {
        text += pick(TOKENS)
        continue
      }
      text += random() < 0.5 ? '{{batshit-zip:' : '{{batshit-clip:'
      const idLength = Math.floor(random() * 4)
      for (let k = 0; k < idLength; k++) text += pick(idParts)
      if (random() < 0.5) {
        text += pick([':::', ':::', '::', ':'])
        const contentLength = Math.floor(random() * 4)
        for (let k = 0; k < contentLength; k++) text += pick(contentParts)
      }
      text += pick(closers)
    }
    texts.push(text)
  }
  return texts
}

const CASES = [
  '{{batshit-zip:zip_1}} and {{batshit-clip:clip_1:::a.png}}',
  '{{batshit-zip:}}',
  '{{batshit-zip:}}}',
  '{{batshit-zip:a}b}}',
  '{{batshit-zip:a\nb {{c}}',
  '{{batshit-zip:a:::}}',
  '{{batshit-zip:a::::x}}',
  '{{batshit-zip:a:::x}y}}',
  '{{batshit-zip:a::b}}',
  '{{batshit-zip::::x}}',
  '{{batshit-zip:a b:::c d}}',
  '{{batshit-zip:a {{batshit-clip:b}}',
  '{{batshit-zip:' + 'a'.repeat(500) + ':::' + 'b'.repeat(500) + '}}',
  '{{{batshit-zip:a}}',
  '{{batshit-zap:a}} {{batshit-zip:b}}',
  ''
]

describe('extractAllReferences', () => {
  it('finds exactly the references the literal old pattern found', () => {
    const texts = [...CASES, ...generateTokenTexts(3_000, 17), ...generateReferenceTexts(6_000, 2172)]
    let withReferences = 0
    let openersOnly = 0
    for (const text of texts) {
      const expected = oldExtractAllReferences(text)
      expect(extractAllReferences(text), JSON.stringify(text)).toEqual(expected)
      if (expected.length > 0) withReferences++
      else if (text.includes('{{batshit-zip:') || text.includes('{{batshit-clip:')) openersOnly++
    }
    expect(withReferences).toBeGreaterThan(1_000)
    expect(openersOnly).toBeGreaterThan(1_000)
  })

  it('reads 1 MB of 20,000 openers that never close in well under 200 ms', () => {
    const replies = { ...unclosedReferenceReplies('zip'), ...unclosedReferenceReplies('clip') }
    for (const [shape, text] of Object.entries(replies)) {
      const started = performance.now()
      expect(extractAllReferences(text), shape).toEqual([])
      expect(performance.now() - started, shape).toBeLessThan(200)
    }
  })

  it('reads what createReference writes', () => {
    const text = `${createReference('zip', 'zip_1')} ${createReference('clip', 'clip_1', 'a.png')}`
    expect(extractAllReferences(text)).toEqual([
      { fullMatch: '{{batshit-zip:zip_1}}', type: 'zip', id: 'zip_1', optionalContent: undefined },
      { fullMatch: '{{batshit-clip:clip_1:::a.png}}', type: 'clip', id: 'clip_1', optionalContent: 'a.png' }
    ])
  })
})
