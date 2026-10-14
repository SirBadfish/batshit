import { describe, expect, it } from 'vitest'
import {
  collectTrustedClipIdsFromMetadata,
  collectTrustedZipIdsFromMetadata,
  extractTrustedZipIdsFromContent,
  extractZipIdFromReference,
  extractTrustedClipIdsFromContent,
  isConcreteClipId,
  isConcreteZipId,
  isTrustedZipReferenceId,
  neutralizeAllClipReferenceSyntax,
  neutralizeAllZipReferenceSyntax,
  neutralizeFinishedReplyReferences,
  neutralizeUntrustedClipReferenceSyntax,
  neutralizeUntrustedZipReferenceSyntax,
  replaceClipReferences,
  replaceLegacyClipReferences,
  replaceLooseZipReferences,
  replaceZipReferences,
  scanClipReferences,
  scanDeletionSweepZipReferences,
  scanLegacyClipReferences,
  scanLooseClipReferences,
  scanLooseZipReferences,
  scanZipReferences,
  stripTrustedClipReferenceSyntax,
  zipBelongsToAnotherChat
} from './zipReferenceSafety'
import { unclosedReferenceReplies } from '$lib/test-utils/unclosedReferenceReplies'
import {
  REFERENCE_SCAN_HAND_CASES,
  generateReferenceScanTexts
} from '$lib/test-utils/referenceScanTexts'

describe('zipReferenceSafety', () => {
  it('recognizes only concrete runtime-shaped zip ids', () => {
    expect(isConcreteZipId('cool_tool_1779416324513_abcd1')).toBe(true)
    expect(isConcreteZipId('tool_read_file_1779416324513_abcd1234')).toBe(true)
    expect(isConcreteZipId('...')).toBe(false)
    expect(isConcreteZipId('zip_id')).toBe(false)
    expect(isConcreteZipId('cool_tool_fake')).toBe(false)
  })

  it('neutralizes every zip reference in user-authored text', () => {
    expect(neutralizeAllZipReferenceSyntax('Show {{batshit-zip:...}} please')).toBe(
      'Show [zip reference omitted] please'
    )
  })

  it('preserves only explicitly trusted zip refs', () => {
    const trusted = 'cool_tool_1779416324513_abcd1'
    const fake = 'cool_tool_1779416329822_fake1'
    const content = [
      `A {{batshit-zip:${trusted}:::Tool execution: read_file}}`,
      `B {{batshit-zip:${fake}:::Tool execution: read_file}}`
    ].join('\n')

    const sanitized = neutralizeUntrustedZipReferenceSyntax(content, {
      trustedZipIds: [trusted]
    })

    expect(sanitized).toContain(`{{batshit-zip:${trusted}:::Tool execution: read_file}}`)
    expect(sanitized).not.toContain(fake)
    expect(sanitized).toContain('[zip reference omitted]')
  })

  it('extracts only trusted ids for metadata fetches', () => {
    const content = [
      '{{batshit-zip:cool_tool_1779416324513_abcd1:::Tool execution: read_file}}',
      '{{batshit-zip:...}}'
    ].join('\n')

    expect(
      extractTrustedZipIdsFromContent(content, {
        allowConcreteWithoutTrustedSet: true
      })
    ).toEqual(['cool_tool_1779416324513_abcd1'])
  })

  it('collects only concrete zip ids from explicit metadata', () => {
    expect(
      collectTrustedZipIdsFromMetadata({
        zipIds: ['cool_tool_1779416324513_abcd1', null, '', 'zip_id', '...'],
        zip_ids: ['image_1779416324513_wxyz9'],
        zipReferences: [
          '{{batshit-zip:terminal_1779416324513_term1:::Terminal output}}',
          { reference: '{{batshit-zip:cool_tool_fake:::Tool execution}}' }
        ]
      })
    ).toEqual([
      'cool_tool_1779416324513_abcd1',
      'image_1779416324513_wxyz9',
      'terminal_1779416324513_term1'
    ])
  })

  it('recognizes only concrete runtime-shaped clip ids', () => {
    expect(isConcreteClipId('clip_1779416324513_abcd1234')).toBe(true)
    expect(isConcreteClipId('clip_1779416324513_abcd1234_0')).toBe(true)
    expect(isConcreteClipId('clip_550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isConcreteClipId('clip_id')).toBe(false)
    expect(isConcreteClipId('clip_fake')).toBe(false)
    expect(isConcreteClipId('...')).toBe(false)
  })

  it('neutralizes every new and legacy clip reference in user-authored text', () => {
    const content = [
      'Show {{batshit-clip:clip_1779416324513_abcd1234:::notes.md}} please',
      '{{batshit-clip|id:clip_1779416324513_legacy|name:notes.md}}hidden{{/batshit-clip}}'
    ].join('\n')

    expect(neutralizeAllClipReferenceSyntax(content)).toBe(
      'Show [clip reference omitted] please\n[clip reference omitted]'
    )
  })

  it('preserves only explicitly trusted clip refs', () => {
    const trusted = 'clip_1779416324513_abcd1234'
    const fake = 'clip_1779416329822_fake1234'
    const content = [
      `A {{batshit-clip:${trusted}:::notes.md}}`,
      `B {{batshit-clip:${fake}:::secret.pdf}}`
    ].join('\n')

    const sanitized = neutralizeUntrustedClipReferenceSyntax(content, {
      trustedClipIds: [trusted]
    })

    expect(sanitized).toContain(`{{batshit-clip:${trusted}:::notes.md}}`)
    expect(sanitized).not.toContain(fake)
    expect(sanitized).toContain('[clip reference omitted]')
  })

  it('extracts only trusted clip ids for attachment lookups', () => {
    const trusted = 'clip_1779416324513_abcd1234'
    const content = [
      `{{batshit-clip:${trusted}:::notes.md}}`,
      '{{batshit-clip:clip_1779416329822_fake1234:::secret.pdf}}'
    ].join('\n')

    expect(
      extractTrustedClipIdsFromContent(content, {
        trustedClipIds: [trusted]
      })
    ).toEqual([trusted])
  })

  it('collects trusted clip ids from message metadata shapes', () => {
    expect(
      collectTrustedClipIdsFromMetadata({
        clipId: 'clip_1779416324513_primary',
        clipIds: ['clip_1779416324513_array1', 'clip_id', 'not_a_runtime_clip_id'],
        clippedItems: [{ clipId: 'clip_1779416324513_item1_0' }],
        clipReferences: [{ reference: '{{batshit-clip:clip_1779416324513_ref01:::notes.md}}' }]
      })
    ).toEqual([
      'clip_1779416324513_primary',
      'clip_1779416324513_array1',
      'clip_1779416324513_item1_0',
      'clip_1779416324513_ref01'
    ])
  })
})

describe('BL-490: a zip reference is neutralized whole, once, and by one pattern', () => {
  const own = 'cool_tool_1779416324513_abcd1'
  const foreign = 'cool_tool_1779416324999_zzzz9'

  it('catches a reference the model echoed across two chunks, which the per-chunk pass cannot', () => {
    const chunks = ['Here it is: {{batshit-zip:' + foreign, ':::Tool execution: read}} done']
    // What `emitTextChunk` does to each chunk on its own: neither half is a reference.
    const streamed = chunks.map((chunk) => neutralizeAllZipReferenceSyntax(chunk)).join('')
    expect(streamed).toContain('{{batshit-zip:' + foreign + ':::Tool execution: read}}')
    // The finalize pass reads the whole reply and keeps only the reply's own zips.
    const ownRef = '{{batshit-zip:' + own + ':::Tool execution: bash}}'
    const finished = neutralizeFinishedReplyReferences(streamed + ' ' + ownRef, [own])
    expect(finished).toBe('Here it is: [zip reference omitted] done ' + ownRef)
    expect(extractTrustedZipIdsFromContent(finished, { allowConcreteWithoutTrustedSet: true })).toEqual([own])
  })

  it('neutralizes clip syntax in a finished reply', () => {
    expect(neutralizeFinishedReplyReferences('see {{batshit-clip:clip_1779416324513_ref01}}', [])).toBe(
      'see [clip reference omitted]'
    )
  })

  it('neutralizes a spaced reference that the chat page used to read as a concrete zip', () => {
    const spaced = '{{batshit-zip:' + foreign + ' :::x}}'
    expect(neutralizeAllZipReferenceSyntax(spaced)).toBe('[zip reference omitted]')
    expect(neutralizeUntrustedZipReferenceSyntax(spaced, { trustedZipIds: [foreign] })).toBe(
      '[zip reference omitted]'
    )
    expect(neutralizeFinishedReplyReferences(spaced, [foreign])).toBe('[zip reference omitted]')
    expect(isConcreteZipId(foreign + ' ')).toBe(false)
    expect(isConcreteZipId(' ' + foreign)).toBe(false)
    expect(extractTrustedZipIdsFromContent(spaced, { allowConcreteWithoutTrustedSet: true })).toEqual([])
  })

  it('keeps prose that opens a reference and closes braces later, on a later line or the same one', () => {
    const multiLine = 'The `{{batshit-zip:` prefix opens a reference.\nLater, `}}` closes one.'
    expect(neutralizeAllZipReferenceSyntax(multiLine)).toBe(multiLine)
    const sameLine = 'the `{{batshit-zip:` prefix opens a reference and `{{x}}` closes it'
    expect(neutralizeAllZipReferenceSyntax(sameLine)).toBe(sameLine)
    const long = '{{batshit-zip:' + 'a'.repeat(200) + '}}'
    expect(neutralizeAllZipReferenceSyntax(long)).toBe(long)
    // A spaced id on one line is still neutralized.
    expect(neutralizeAllZipReferenceSyntax('see {{batshit-zip:' + foreign + ' :::x}} here')).toBe(
      'see [zip reference omitted] here'
    )
  })

  it('knows a zip that belongs to another chat or another user', () => {
    const owner = { sessionId: 'session_a', userId: 'user_1' }
    expect(zipBelongsToAnotherChat({ metadata: { sessionId: 'session_b', userId: 'user_1' } }, owner)).toBe(true)
    expect(zipBelongsToAnotherChat({ metadata: { sessionId: 'session_a', userId: 'user_2' } }, owner)).toBe(true)
    expect(zipBelongsToAnotherChat({ session_id: 'session_b' }, owner)).toBe(true)
    expect(zipBelongsToAnotherChat({ metadata: { sessionId: 'session_a', userId: 'user_1' } }, owner)).toBe(false)
    // A zip that names neither is left to the other rules, as read-time trust repair does.
    expect(zipBelongsToAnotherChat({ metadata: {} }, owner)).toBe(false)
    expect(zipBelongsToAnotherChat(null, owner)).toBe(false)
  })
})

/**
 * The lazy pattern the legacy clip scan replaced, kept here only as the oracle: the scan must find
 * exactly its blocks, ids, and positions. Its cost was (unclosed openers) x (text length).
 */
const OLD_LEGACY_CLIP_REFERENCE_REGEX =
  /\{\{batshit-clip\|[^}]*\bid:([^|}\s]+)[^}]*\}\}[\s\S]*?\{\{\/batshit-clip\}\}/g

function oldLegacyBlocks(text: string) {
  return Array.from(text.matchAll(OLD_LEGACY_CLIP_REFERENCE_REGEX), (match) => ({
    start: match.index ?? -1,
    end: (match.index ?? -1) + match[0].length,
    match: match[0],
    clipId: match[1]
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

const LEGACY_SCAN_TOKENS = [
  '{{batshit-clip|', '{{batshit-clip|', '{{batshit-clip|', '{{/batshit-clip}}', '{{/batshit-clip}}',
  '}}', '}}', '}', '}}}', '{', '{{', 'id:', 'id:', '|id:', ' id:', 'xid:', '_id:', '-id:', '9id:',
  'ID:', 'id: ', 'id:id:', 'name:', '|name:', 'clip_1', 'clip_1779416324513_abcd1234', 'a', 'b',
  ' ', '\n', '\t', '\r\n', '\u00a0', '\u2028', '\ufeff', '|', ':', '\u00e9', '\ud83d\ude00',
  '{{batshit-zip:zip_1}}', '{{batshit-zip:', '{{batshit-clip:clip_2:::x}}', '{{batshit-clip:',
  '{{/batshit-clip}', '/batshit-clip}}', '{{/batshit-clip', 'batshit-clip|', '{{batshit-clip',
  'x'.repeat(300), 'id:' + 'q'.repeat(300), 'word '.repeat(40)
]

function generateLegacyScanTexts(count: number, seed: number): string[] {
  const random = seededRandom(seed)
  const texts: string[] = []
  for (let i = 0; i < count; i++) {
    const length = 1 + Math.floor(random() * 24)
    let text = ''
    for (let j = 0; j < length; j++) {
      text += LEGACY_SCAN_TOKENS[Math.floor(random() * LEGACY_SCAN_TOKENS.length)]
    }
    texts.push(text)
  }
  return texts
}

/** Texts built block by block, so most carry a block or come one rule short of one. */
function generateLegacyBlockTexts(count: number, seed: number): string[] {
  const random = seededRandom(seed)
  const pick = (list: string[]) => list[Math.floor(random() * list.length)]
  const nbsp = String.fromCharCode(0xa0)
  const headerParts = [
    'id:', 'id:', '|id:', ' id:', 'xid:', '_id:', 'name:', '|name:', 'clip_1', 'clip_1779416324513_abcd1234',
    'a', ' ', '\n', nbsp, '|', ':', '{', '{{batshit-clip|', 'q'.repeat(200)
  ]
  const headerEnds = ['}}', '}}', '}}', '}', '} }', '}}}', '']
  const bodyParts = [
    'body', ' ', '\n', '{{/batshit-clip}}', '{{batshit-clip|id:b}}', '{{batshit-clip:clip_2:::x}}',
    '{{batshit-zip:zip_1}}', '}}', '{{/batshit-clip}', 'x'.repeat(100)
  ]
  const closers = ['{{/batshit-clip}}', '{{/batshit-clip}}', '', '{{/batshit-clip}']
  const texts: string[] = []
  for (let i = 0; i < count; i++) {
    const segments = 1 + Math.floor(random() * 4)
    let text = ''
    for (let j = 0; j < segments; j++) {
      if (random() < 0.2) {
        text += pick(LEGACY_SCAN_TOKENS)
        continue
      }
      text += '{{batshit-clip|'
      const headerLength = Math.floor(random() * 5)
      for (let k = 0; k < headerLength; k++) text += pick(headerParts)
      text += pick(headerEnds)
      const bodyLength = Math.floor(random() * 3)
      for (let k = 0; k < bodyLength; k++) text += pick(bodyParts)
      text += pick(closers)
    }
    texts.push(text)
  }
  return texts
}

const LEGACY_SCAN_CASES = [
  'a {{batshit-clip|id:clip_old|name:legacy.md}}body{{/batshit-clip}} b',
  '{{batshit-clip|id:a}}x{{batshit-clip|id:b}}y{{/batshit-clip}}z{{/batshit-clip}}',
  '{{batshit-clip|id:a|id:b}}body{{/batshit-clip}}',
  '{{batshit-clip|xid:a|id:b}}body{{/batshit-clip}}',
  '{{batshit-clip|id:a xid:b}}body{{/batshit-clip}}',
  '{{batshit-clip|id: a}}body{{/batshit-clip}}',
  '{{batshit-clip|id:}}body{{/batshit-clip}}',
  '{{batshit-clip|id:a} }body{{/batshit-clip}}',
  '{{batshit-clip|name:x\nid:a}}body{{/batshit-clip}}',
  '{{batshit-clip|{{batshit-clip|id:a}}body{{/batshit-clip}}',
  '{{batshit-clip|id:a}}{{/batshit-clip}}',
  '{{batshit-clip|id:a {{/batshit-clip}}{{/batshit-clip}}',
  '{{batshit-clip|id:a {{/batshit-clip}}',
  '{{batshit-clip|id:a}}}{{/batshit-clip}}}',
  '{{batshit-clip|id:a\u00a0b}}body{{/batshit-clip}}',
  '{{batshit-clip|id:a\u2028b}}body{{/batshit-clip}}',
  '{{batshit-clip|id:\ud83d\ude00}}body{{/batshit-clip}}',
  '{{batshit-clip|id:a}} {{batshit-clip|id:b}}{{/batshit-clip}}',
  '{{batshit-clip|id:a} then }} {{batshit-clip|id:b}}x{{/batshit-clip}}',
  '{{batshit-clip|name:a}} {{batshit-clip|id:b}}x{{/batshit-clip}}',
  '{{batshit-clip|id:a}}x{{/batshit-clip}}{{batshit-clip|id:b}}y{{/batshit-clip}}',
  '{{batshit-clip|name:a {{batshit-clip|name:b {{batshit-clip|id:c}}x{{/batshit-clip}}',
  '{{batshit-clip|id:' + 'z'.repeat(5000) + '}}x{{/batshit-clip}}',
  '{{batshit-clip|ID:a}}x{{/batshit-clip}}',
  '{{batshit-zip:zip_1:::x}} {{batshit-clip:clip_2:::y}} {{batshit-clip|id:c}}z{{/batshit-clip}}',
  ''
]

describe('legacy clip reference scan', () => {
  it('finds exactly the blocks, ids, and positions the old lazy pattern found', () => {
    const texts = [
      ...LEGACY_SCAN_CASES,
      ...generateLegacyScanTexts(3_000, 20260927),
      ...generateLegacyBlockTexts(6_000, 543)
    ]
    let withBlocks = 0
    let openersWithoutBlocks = 0
    for (const text of texts) {
      const expected = oldLegacyBlocks(text)
      expect(scanLegacyClipReferences(text), JSON.stringify(text)).toEqual(expected)
      const tag = (match: string, clipId: string) => `<${clipId}|${match.length}>`
      expect(replaceLegacyClipReferences(text, tag), JSON.stringify(text)).toBe(
        text.replace(OLD_LEGACY_CLIP_REFERENCE_REGEX, tag)
      )
      if (expected.length > 0) withBlocks++
      else if (text.includes('{{batshit-clip|')) openersWithoutBlocks++
    }
    // The comparison covers both answers, not only texts with nothing to find.
    expect(withBlocks).toBeGreaterThan(1_000)
    expect(openersWithoutBlocks).toBeGreaterThan(1_000)
  })

  it('keeps what each reader does with a block', () => {
    const trusted = 'clip_1779416324513_abcd1234'
    const text =
      `A {{batshit-clip|id:${trusted}|name:a.md}}one{{/batshit-clip}} ` +
      'B {{batshit-clip|id:clip_1779416329822_fake1234}}two{{/batshit-clip}} C'
    expect(neutralizeAllClipReferenceSyntax(text)).toBe(
      'A [clip reference omitted] B [clip reference omitted] C'
    )
    expect(neutralizeUntrustedClipReferenceSyntax(text, { trustedClipIds: [trusted] })).toBe(
      `A {{batshit-clip|id:${trusted}|name:a.md}}one{{/batshit-clip}} B [clip reference omitted] C`
    )
    expect(stripTrustedClipReferenceSyntax(text, { trustedClipIds: [trusted] })).toBe(
      'A  B {{batshit-clip|id:clip_1779416329822_fake1234}}two{{/batshit-clip}} C'
    )
    expect(extractTrustedClipIdsFromContent(text, { allowConcreteWithoutTrustedSet: true })).toEqual([
      trusted,
      'clip_1779416329822_fake1234'
    ])
    expect(neutralizeFinishedReplyReferences(text, [])).toBe(
      'A [clip reference omitted] B [clip reference omitted] C'
    )
  })
})

/**
 * The two shared patterns the reference scan replaced, kept here only as oracles: the scan must
 * find exactly their references, ids, descriptions, and positions. Their description part cost
 * (openers) x (text length) when no `}}` closed it.
 */
const OLD_ZIP_REFERENCE_REGEX = /\{\{batshit-zip:([^:{}\r\n]{1,160})(?::::([^}]*))?\}\}/g
const OLD_CLIP_REFERENCE_REGEX = /\{\{batshit-clip:([^:}\s]+)(?::::([^}]*))?\}\}/g

function oldReferences(regex: RegExp, text: string) {
  return Array.from(text.matchAll(regex), (match) => ({
    start: match.index ?? -1,
    end: (match.index ?? -1) + match[0].length,
    match: match[0],
    id: match[1],
    description: match[2]
  }))
}

const NBSP = String.fromCharCode(0xa0)
const LINE_SEPARATOR = String.fromCharCode(0x2028)

const REFERENCE_SCAN_TOKENS = [
  '{{batshit-zip:', '{{batshit-zip:', '{{batshit-zip:', '{{batshit-clip:', '{{batshit-clip:',
  '{{batshit-clip:', ':::', ':::', '::', ':', '}}', '}}', '}', '}}}', '{', '{{', 'zip_1', 'clip_1',
  'cool_tool_1779416324513_abcd1', 'clip_1779416324513_abcd1234', 'id ', ' ', '\n', '\r', '\r\n',
  '\t', NBSP, LINE_SEPARATOR, 'a', 'desc words', '|', 'q'.repeat(40), 'q'.repeat(80),
  'q'.repeat(159), 'q'.repeat(160), 'q'.repeat(161), '{{batshit-clip|id:c}}x{{/batshit-clip}}',
  '{{/batshit-clip}}'
]

/** References built part by part, so most are a reference or one rule short of one. */
function generateReferenceTexts(count: number, seed: number): string[] {
  const random = seededRandom(seed)
  const pick = (list: string[]) => list[Math.floor(random() * list.length)]
  const idParts = [
    'zip_1', 'clip_1', 'cool_tool_1779416324513_abcd1', 'a', ' ', 'id ', '\n', '\r', '{', '|', NBSP,
    LINE_SEPARATOR, 'q'.repeat(50), 'q'.repeat(100), 'q'.repeat(160)
  ]
  const descriptionParts = [
    'desc', ' ', '\n', '{', '}', ':::', '{{batshit-zip:b}}', '{{batshit-clip:c}}', 'x'.repeat(60)
  ]
  const closers = ['}}', '}}', '}}', '}', '} }', '}}}', '']
  const texts: string[] = []
  for (let i = 0; i < count; i++) {
    const segments = 1 + Math.floor(random() * 4)
    let text = ''
    for (let j = 0; j < segments; j++) {
      if (random() < 0.2) {
        text += pick(REFERENCE_SCAN_TOKENS)
        continue
      }
      text += random() < 0.5 ? '{{batshit-zip:' : '{{batshit-clip:'
      const idLength = Math.floor(random() * 4)
      for (let k = 0; k < idLength; k++) text += pick(idParts)
      const tail = random()
      if (tail < 0.5) {
        text += pick([':::', ':::', '::', ':'])
        const descriptionLength = Math.floor(random() * 4)
        for (let k = 0; k < descriptionLength; k++) text += pick(descriptionParts)
      }
      text += pick(closers)
    }
    texts.push(text)
  }
  return texts
}

function generateTokenTexts(count: number, seed: number): string[] {
  const random = seededRandom(seed)
  const texts: string[] = []
  for (let i = 0; i < count; i++) {
    const length = 1 + Math.floor(random() * 24)
    let text = ''
    for (let j = 0; j < length; j++) {
      text += REFERENCE_SCAN_TOKENS[Math.floor(random() * REFERENCE_SCAN_TOKENS.length)]
    }
    texts.push(text)
  }
  return texts
}

const REFERENCE_SCAN_CASES = [
  // BL-490: the id stays on one line, holds no brace, is at most 160 characters; spaced ids match
  '{{batshit-zip:a\nb}}',
  '{{batshit-zip:a\r\nb:::x}}',
  '{{batshit-zip:a' + LINE_SEPARATOR + 'b}}',
  '{{batshit-zip:cool_tool_1779416324513_abcd1 :::Tool execution: read}}',
  '{{batshit-zip: cool_tool_1779416324513_abcd1}}',
  '{{batshit-zip:id :::x}} and {{batshit-zip:id}}',
  '{{batshit-zip:' + 'a'.repeat(160) + '}}',
  '{{batshit-zip:' + 'a'.repeat(161) + '}}',
  '{{batshit-zip:' + 'a'.repeat(160) + ':::x}}',
  '{{batshit-zip:' + 'a'.repeat(161) + ':::x}}',
  '{{batshit-zip:a{b}}',
  '{{batshit-zip:a{{batshit-zip:b}}',
  // a `}` inside the description
  '{{batshit-zip:a:::x}y}}',
  '{{batshit-zip:a:::x}y}} {{batshit-zip:b:::z}}',
  '{{batshit-zip:a:::x}}}',
  '{{batshit-zip:a:::}}',
  '{{batshit-zip:a::::x}}',
  '{{batshit-zip:a:::x {{batshit-zip:b}}',
  '{{batshit-zip:a:::line one\nline two}}',
  '{{batshit-zip:a::b}} {{batshit-zip:a:}} {{batshit-zip::::x}} {{batshit-zip:}}',
  'The `{{batshit-zip:` prefix opens a reference.\nLater, `}}` closes one.',
  'the `{{batshit-zip:` prefix opens a reference and `{{x}}` closes it',
  '{{batshit-clip:a b}}',
  '{{batshit-clip:a{b}}',
  '{{batshit-clip:a' + NBSP + 'b}}',
  '{{batshit-clip:' + 'z'.repeat(5000) + ':::x}}',
  '{{batshit-clip:a:::x}y}}',
  '{{batshit-clip:a{{batshit-clip:b}}',
  '{{batshit-clip:clip_1779416324513_abcd1234:::notes.md}} {{batshit-clip:clip_2}}',
  '{{batshit-clip|id:c}}x{{/batshit-clip}} {{batshit-clip:clip_2:::y}} {{batshit-zip:zip_1:::z}}',
  ''
]

describe('zip and clip reference scan', () => {
  const trustedZipIds = ['cool_tool_1779416324513_abcd1', 'zip_1']
  const omitted = '[clip reference omitted]'
  // What the reply-end neutralizer did with the old patterns.
  const oldFinishedReply = (text: string) => {
    let next = text
    if (next.includes('{{batshit-zip:')) {
      next = next.replace(OLD_ZIP_REFERENCE_REGEX, (match, zipId) =>
        isTrustedZipReferenceId(zipId, trustedZipIds) ? match : '[zip reference omitted]'
      )
    }
    if (next.includes('{{batshit-clip')) {
      next = next
        .replace(OLD_LEGACY_CLIP_REFERENCE_REGEX, omitted)
        .replace(OLD_CLIP_REFERENCE_REGEX, omitted)
    }
    return next
  }
  const tag = (match: string, id: string, description: string | undefined) =>
    `<${id}|${description === undefined ? '-' : 'd:' + description}|${match.length}>`

  it('finds exactly the references, ids, descriptions, and positions the old patterns found', () => {
    const texts = [
      ...REFERENCE_SCAN_CASES,
      ...generateTokenTexts(3_000, 490),
      ...generateReferenceTexts(6_000, 20260927)
    ]
    const counts = { zip: 0, zipOpenersOnly: 0, clip: 0, clipOpenersOnly: 0 }
    for (const text of texts) {
      const label = JSON.stringify(text)
      const zips = oldReferences(OLD_ZIP_REFERENCE_REGEX, text)
      const clips = oldReferences(OLD_CLIP_REFERENCE_REGEX, text)
      expect(scanZipReferences(text), label).toEqual(zips)
      expect(scanClipReferences(text), label).toEqual(clips)
      expect(replaceZipReferences(text, tag), label).toBe(text.replace(OLD_ZIP_REFERENCE_REGEX, tag))
      expect(replaceClipReferences(text, tag), label).toBe(
        text.replace(OLD_CLIP_REFERENCE_REGEX, tag)
      )
      expect(neutralizeFinishedReplyReferences(text, trustedZipIds), label).toBe(
        oldFinishedReply(text)
      )
      if (zips.length > 0) counts.zip++
      else if (text.includes('{{batshit-zip:')) counts.zipOpenersOnly++
      if (clips.length > 0) counts.clip++
      else if (text.includes('{{batshit-clip:')) counts.clipOpenersOnly++
    }
    // The comparison covers both answers for both shapes, not only texts with nothing to find.
    for (const [kind, count] of Object.entries(counts)) {
      expect(count, kind).toBeGreaterThan(1_000)
    }
  })

  it('keeps the BL-490 rules: one line, no brace, at most 160 characters, spaced ids never trusted', () => {
    const concrete = 'cool_tool_1779416324513_abcd1'
    expect(scanZipReferences('{{batshit-zip:' + concrete + '\n:::x}}')).toEqual([])
    expect(scanZipReferences('{{batshit-zip:' + 'a'.repeat(161) + '}}')).toEqual([])
    expect(scanZipReferences('{{batshit-zip:' + 'a'.repeat(160) + '}}')).toHaveLength(1)
    expect(scanZipReferences('{{batshit-zip:a:::x}y}}')).toEqual([])
    const spaced = '{{batshit-zip:' + concrete + ' :::x}}'
    expect(scanZipReferences(spaced).map((reference) => reference.id)).toEqual([concrete + ' '])
    expect(neutralizeUntrustedZipReferenceSyntax(spaced, { trustedZipIds: [concrete] })).toBe(
      '[zip reference omitted]'
    )
    expect(extractTrustedZipIdsFromContent(spaced, { allowConcreteWithoutTrustedSet: true })).toEqual(
      []
    )
  })
})

describe('reference readers on 1 MB of 20,000 unclosed openers', () => {
  const zipReplies = unclosedReferenceReplies('zip')
  const clipReplies = {
    ...unclosedReferenceReplies('clip'),
    ...unclosedReferenceReplies('legacyClip')
  }
  const within200ms = <T>(label: string, read: () => T): T => {
    const started = performance.now()
    const result = read()
    expect(performance.now() - started, label).toBeLessThan(200)
    return result
  }

  it('neutralizes each at the reply end in well under 200 ms', () => {
    for (const [shape, reply] of Object.entries({ ...zipReplies, ...clipReplies })) {
      expect(reply.length, shape).toBeGreaterThanOrEqual(1_000_000)
      expect(within200ms(shape, () => neutralizeFinishedReplyReferences(reply, []))).toBe(reply)
    }
  })

  it('reads zip references (neutralize, trust, extract, and the chat page scan) in well under 200 ms', () => {
    for (const [shape, reply] of Object.entries(zipReplies)) {
      expect(within200ms(shape, () => neutralizeAllZipReferenceSyntax(reply))).toBe(reply)
      expect(
        within200ms(shape, () => neutralizeUntrustedZipReferenceSyntax(reply, { trustedZipIds: [] }))
      ).toBe(reply)
      expect(
        within200ms(shape, () =>
          extractTrustedZipIdsFromContent(reply, { allowConcreteWithoutTrustedSet: true })
        )
      ).toEqual([])
      expect(within200ms(shape, () => scanZipReferences(reply))).toEqual([])
    }
  })

  it('reads clip references (neutralize, trust, strip, extract) in well under 200 ms', () => {
    for (const [shape, reply] of Object.entries(clipReplies)) {
      expect(within200ms(shape, () => neutralizeAllClipReferenceSyntax(reply))).toBe(reply)
      expect(
        within200ms(shape, () => neutralizeUntrustedClipReferenceSyntax(reply, { trustedClipIds: [] }))
      ).toBe(reply)
      expect(
        within200ms(shape, () => stripTrustedClipReferenceSyntax(reply, { trustedClipIds: ['clip_1'] }))
      ).toBe(reply)
      expect(
        within200ms(shape, () => extractTrustedClipIdsFromContent(reply, { trustedClipIds: ['clip_1'] }))
      ).toEqual([])
    }
  })
})

/**
 * BL-707: the older reference shape several readers still keep (BL-609 moves them onto the
 * shared one): an id of any length with no `:` or `}` (so `{`, spaces, and line breaks are id
 * characters) and an optional `:::` description with no `}`. Kept here only as oracles, literally:
 * the metadata readers' and the routes' first-reference pattern, and its global form.
 */
const OLD_LOOSE_ZIP_REFERENCE_REGEX = /\{\{batshit-zip:([^:}]+)(?::::([^}]*))?\}\}/g
const OLD_LOOSE_CLIP_REFERENCE_REGEX = /\{\{batshit-clip:([^:}]+)(?::::([^}]*))?\}\}/g
const OLD_ZIP_ENTRY_REGEX = /\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/
const OLD_CLIP_ENTRY_REGEX = /\{\{batshit-clip:([^:}]+)(?::::[^}]*)?\}\}/

/** `collectTrustedZipIdsFromMetadata` as it was, with its old pattern. */
function oldCollectTrustedZipIdsFromMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return []
  const ids = new Set<string>()
  const record = metadata as Record<string, any>
  const add = (value: unknown) => {
    if (typeof value === 'string' && isConcreteZipId(value)) ids.add(value.trim())
  }
  const addArray = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(add)
  }
  addArray(record.zipIds)
  addArray(record.zip_ids)
  if (Array.isArray(record.zipReferences)) {
    for (const entry of record.zipReferences) {
      if (typeof entry === 'string') {
        const match = entry.match(OLD_ZIP_ENTRY_REGEX)
        add(match?.[1] ?? entry)
      } else if (entry && typeof entry === 'object') {
        add(entry.zipId)
        add(entry.zip_id)
        add(entry.id)
        if (typeof entry.reference === 'string') add(entry.reference.match(OLD_ZIP_ENTRY_REGEX)?.[1])
      }
    }
  }
  return Array.from(ids)
}

/** `collectTrustedClipIdsFromMetadata` as it was, with its old pattern. */
function oldCollectTrustedClipIdsFromMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return []
  const ids = new Set<string>()
  const record = metadata as Record<string, any>
  const add = (value: unknown) => {
    if (typeof value === 'string' && isConcreteClipId(value)) ids.add(value.trim())
  }
  const addArray = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(add)
  }
  add(record.clipId)
  add(record.clip_id)
  addArray(record.clipIds)
  addArray(record.clip_ids)
  if (Array.isArray(record.clippedItems)) {
    for (const item of record.clippedItems) {
      add(item?.clipId)
      add(item?.clip_id)
      add(item?.id)
    }
  }
  if (Array.isArray(record.clipReferences)) {
    for (const entry of record.clipReferences) {
      if (typeof entry === 'string') {
        const match = entry.match(OLD_CLIP_ENTRY_REGEX)
        add(match?.[1] ?? entry)
      } else if (entry && typeof entry === 'object') {
        add(entry.clipId)
        add(entry.clip_id)
        add(entry.id)
        if (typeof entry.reference === 'string') add(entry.reference.match(OLD_CLIP_ENTRY_REGEX)?.[1])
      }
    }
  }
  return Array.from(ids)
}

describe('BL-707: the older reference shape, read once', () => {
  const tag = (match: string, id: string, description: string | undefined) =>
    `<${id}|${description === undefined ? '-' : 'd:' + description}|${match.length}>`
  const texts = [
    ...REFERENCE_SCAN_HAND_CASES,
    ...REFERENCE_SCAN_CASES,
    ...generateReferenceScanTexts(6_000, 707),
    ...generateTokenTexts(1_500, 7_070),
    ...generateReferenceTexts(1_500, 70_707)
  ]

  it('finds exactly the references, ids, descriptions, and positions the old patterns found', () => {
    const counts = { zip: 0, zipOpenersOnly: 0, clip: 0, clipOpenersOnly: 0, zipWithSpaceOrBreak: 0 }
    for (const text of texts) {
      const label = JSON.stringify(text)
      const zips = oldReferences(OLD_LOOSE_ZIP_REFERENCE_REGEX, text)
      const clips = oldReferences(OLD_LOOSE_CLIP_REFERENCE_REGEX, text)
      expect(scanLooseZipReferences(text), label).toEqual(zips)
      expect(scanLooseClipReferences(text), label).toEqual(clips)
      expect(extractZipIdFromReference(text), label).toBe(text.match(OLD_ZIP_ENTRY_REGEX)?.[1] ?? null)
      expect(replaceLooseZipReferences(text, tag), label).toBe(
        text.replace(OLD_LOOSE_ZIP_REFERENCE_REGEX, tag)
      )
      if (zips.length > 0) counts.zip++
      else if (text.includes('{{batshit-zip:')) counts.zipOpenersOnly++
      if (clips.length > 0) counts.clip++
      else if (text.includes('{{batshit-clip:')) counts.clipOpenersOnly++
      if (zips.some((zip) => /[\s{]/.test(zip.id))) counts.zipWithSpaceOrBreak++
    }
    // Both answers for both shapes, and ids the shared shape would refuse (a space, a break, a `{`).
    for (const [kind, count] of Object.entries(counts)) {
      expect(count, kind).toBeGreaterThan(1_000)
    }
  })

  it('the metadata readers trust exactly the ids they trusted', () => {
    const counts = { zip: 0, clip: 0 }
    for (const text of texts) {
      const label = JSON.stringify(text)
      const zipMetadata = {
        zipIds: ['zip_1779416324513_meta1', text],
        zipReferences: [text, { reference: text }, { zipId: text }, { id: text, reference: 7 }, 42, null]
      }
      const clipMetadata = {
        clipId: text,
        clipIds: [text],
        clippedItems: [{ clipId: text }, null],
        clipReferences: [text, { reference: text }, { clip_id: text }, 42, null]
      }
      const zipIds = oldCollectTrustedZipIdsFromMetadata(zipMetadata)
      const clipIds = oldCollectTrustedClipIdsFromMetadata(clipMetadata)
      expect(collectTrustedZipIdsFromMetadata(zipMetadata), label).toEqual(zipIds)
      expect(collectTrustedClipIdsFromMetadata(clipMetadata), label).toEqual(clipIds)
      // An id read from inside a reference (not the metadata's own zip id or the whole text).
      if (zipIds.some((id) => id !== 'zip_1779416324513_meta1' && id !== text.trim())) counts.zip++
      if (clipIds.some((id) => id !== text.trim())) counts.clip++
    }
    for (const [kind, count] of Object.entries(counts)) {
      expect(count, kind).toBeGreaterThan(500)
    }
  })
})

describe('BL-707: readers of the older shape on 1 MB of 20,000 unclosed openers', () => {
  const within200ms = <T>(label: string, read: () => T): T => {
    const started = performance.now()
    const result = read()
    expect(performance.now() - started, label).toBeLessThan(200)
    return result
  }

  it('scan, read one posted reference, and trust metadata entries in well under 200 ms', () => {
    for (const [shape, reply] of Object.entries(unclosedReferenceReplies('zip'))) {
      expect(within200ms(shape, () => scanLooseZipReferences(reply))).toEqual([])
      expect(within200ms(shape, () => extractZipIdFromReference(reply))).toBeNull()
      expect(
        within200ms(shape, () =>
          collectTrustedZipIdsFromMetadata({ zipReferences: [reply, { reference: reply }] })
        )
      ).toEqual([])
    }
    for (const [shape, reply] of Object.entries(unclosedReferenceReplies('clip'))) {
      expect(within200ms(shape, () => scanLooseClipReferences(reply))).toEqual([])
      expect(
        within200ms(shape, () =>
          collectTrustedClipIdsFromMetadata({ clipReferences: [reply, { reference: reply }] })
        )
      ).toEqual([])
    }
  })
})

/**
 * BL-707: the chat deletion sweep's own shape (`redis.deleteSession`), kept here only as the
 * oracle: an id with no whitespace, and a description of at least one character.
 */
const OLD_DELETION_SWEEP_ZIP_REGEX = /\{\{batshit-zip:([^:}\s]+)(?::::[^}]+)?\}\}/g

describe("BL-707: the chat deletion sweep's shape, read once", () => {
  it('finds exactly the references, ids, and positions the old pattern found', () => {
    const texts = [
      ...REFERENCE_SCAN_HAND_CASES,
      ...REFERENCE_SCAN_CASES,
      ...generateReferenceScanTexts(6_000, 7_071),
      ...generateTokenTexts(1_500, 7_072),
      ...generateReferenceTexts(1_500, 7_073)
    ]
    const counts = { found: 0, openersOnly: 0, emptyDescription: 0 }
    for (const text of texts) {
      const expected = Array.from(text.matchAll(OLD_DELETION_SWEEP_ZIP_REGEX), (match) => ({
        start: match.index ?? -1,
        end: (match.index ?? -1) + match[0].length,
        match: match[0],
        id: match[1]
      }))
      const found = scanDeletionSweepZipReferences(text).map(({ start, end, match, id }) => ({
        start,
        end,
        match,
        id
      }))
      expect(found, JSON.stringify(text)).toEqual(expected)
      if (expected.length > 0) counts.found++
      else if (text.includes('{{batshit-zip:')) counts.openersOnly++
      if (scanLooseZipReferences(text).some((reference) => reference.description === '')) {
        counts.emptyDescription++
      }
    }
    // Both answers, and texts where the one rule only this shape has (an empty description is
    // refused) is in play.
    expect(counts.found).toBeGreaterThan(1_000)
    expect(counts.openersOnly).toBeGreaterThan(1_000)
    expect(counts.emptyDescription).toBeGreaterThan(100)
  })

  it('reads 1 MB of 20,000 unclosed openers in well under 200 ms', () => {
    for (const [shape, reply] of Object.entries(unclosedReferenceReplies('zip'))) {
      const started = performance.now()
      expect(scanDeletionSweepZipReferences(reply), shape).toEqual([])
      expect(performance.now() - started, shape).toBeLessThan(200)
    }
  })
})
