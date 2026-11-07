import { describe, expect, it } from 'vitest'
import { createReference, extractAllReferences } from './universalResolver'
import { extractZips } from './messageCompiler'
import { isConcreteZipId, scanClipReferences, scanZipReferences } from '$lib/utils/zipReferenceSafety'
import { unclosedReferenceReplies } from '$lib/test-utils/unclosedReferenceReplies'

/**
 * BL-609: the compile's resolver reads zip and clip references with the trust reader's shapes
 * (`scanZipReferences`, `scanClipReferences`), in one left-to-right pass: a reference inside an
 * earlier reference's description is part of it. The two shared patterns joined into one are
 * the oracle here: the scan must find exactly its references, types, ids, and contents, in order.
 * (Its older pattern, `/\{\{(batshit-zip|batshit-clip):([^:]+?)(?::::([^}]+))?\}\}/g`, read an id
 * with braces and line breaks and refused an empty description.)
 */
const SHARED_REFERENCE_REGEX =
  /\{\{batshit-(?:zip:([^:{}\r\n]{1,160})|clip:([^:}\s]+))(?::::([^}]*))?\}\}/g

function sharedExtractAllReferences(text: string) {
  return Array.from(text.matchAll(SHARED_REFERENCE_REGEX), (match) => {
    const [fullMatch, zipId, clipId, optionalContent] = match
    return {
      fullMatch,
      type: (zipId !== undefined ? 'zip' : 'clip') as 'zip' | 'clip',
      id: zipId ?? clipId,
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
  it('reads an odd reference exactly as the trust reader reads one', () => {
    const ZIP = 'cool_tool_1790500000000_abcde'
    const long = `cool_tool_${'1'.repeat(150)}_abcde`
    // An empty description and a spaced id are references; a `{`, a line break, or more than 160
    // characters in a zip id are not, and a clip id holds no whitespace.
    expect(extractAllReferences(`{{batshit-zip:${ZIP}:::}}`)).toEqual([
      { fullMatch: `{{batshit-zip:${ZIP}:::}}`, type: 'zip', id: ZIP, optionalContent: undefined }
    ])
    expect(extractAllReferences('{{batshit-zip:a b:::c}}').map((ref) => ref.id)).toEqual(['a b'])
    for (const odd of ['{{batshit-zip:a{b:::c}}', '{{batshit-zip:a\nb}}', `{{batshit-zip:${long}}}`, '{{batshit-clip:a b}}']) {
      expect(extractAllReferences(odd), JSON.stringify(odd)).toEqual([])
    }
    // One pass: a clip reference inside a zip reference's description is part of it.
    const nested = `{{batshit-zip:${ZIP}:::see {{batshit-clip:clip_1}} then {{batshit-clip:clip_2}}`
    expect(extractAllReferences(nested).map((ref) => [ref.type, ref.id])).toEqual([
      ['zip', ZIP],
      ['clip', 'clip_2']
    ])
  })

  it('finds exactly the references the shared patterns find, and each one the shape reads', () => {
    const texts = [...CASES, ...generateTokenTexts(3_000, 17), ...generateReferenceTexts(6_000, 2172)]
    let withReferences = 0
    let openersOnly = 0
    for (const text of texts) {
      const expected = sharedExtractAllReferences(text)
      // With one kind only, the shape's own scan is the answer.
      if (!text.includes('{{batshit-clip:')) {
        expect(expected.map((ref) => ref.fullMatch), JSON.stringify(text)).toEqual(scanZipReferences(text).map((ref) => ref.match))
      }
      if (!text.includes('{{batshit-zip:')) {
        expect(expected.map((ref) => ref.fullMatch), JSON.stringify(text)).toEqual(scanClipReferences(text).map((ref) => ref.match))
      }
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

  it('the compile extracts each concrete zip the shape reads (extractZips)', () => {
    const ZIP = 'cool_tool_1790500000000_abcde'
    // A reference Batshit writes with an empty description (`zipService.ts`) is a zip in the
    // compile, as in the chat view; the older resolver left it in the prompt as raw text.
    expect(extractZips(`Read: {{batshit-zip:${ZIP}:::}}`).map((zip) => zip.id)).toEqual([ZIP])
    for (const text of [...CASES, ...generateTokenTexts(1_000, 609), ...generateReferenceTexts(2_000, 6_090)]) {
      if (text.includes('{{batshit-clip:')) continue
      expect(extractZips(text).map((zip) => zip.id), JSON.stringify(text)).toEqual(
        scanZipReferences(text).map((ref) => ref.id).filter((id) => isConcreteZipId(id))
      )
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
