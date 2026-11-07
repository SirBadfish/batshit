import { describe, expect, it } from 'vitest'
import {
  firstJsonPathMatch,
  zipCandidatesOfDeletedMessage,
  zipClaimsOfMessage,
  zipIdsNamedInText,
  zipRecordChat,
  zipsOfDeletedChat,
  zipsOwnedOnlyByMessage
} from './messageDeletionZips'
import { scanZipReferences, zipBelongsToAnotherChat } from './zipReferenceSafety'
import { REFERENCE_SCAN_HAND_CASES, generateReferenceScanTexts } from '$lib/test-utils/referenceScanTexts'
import { unclosedReferenceReplies } from '$lib/test-utils/unclosedReferenceReplies'

const Z = (n: number) => `cool_tool_17590000000${n}_abcd${n}`

describe('zipsOwnedOnlyByMessage (BL-390)', () => {
  it('takes the zips this message made in this chat that no other message claims', () => {
    expect(
      zipsOwnedOnlyByMessage({
        messageId: 'm1',
        sessionId: 's1',
        zips: [
          { zipId: 'own', messageId: 'm1', sessionId: 's1' },
          { zipId: 'shared', messageId: 'm1', sessionId: 's1' },
          { zipId: 'other', messageId: 'm2', sessionId: 's1' },
          { zipId: 'elsewhere', messageId: 'm1', sessionId: 's2' },
          { zipId: 'gone', messageId: undefined, sessionId: undefined }
        ],
        message: { metadata: { zipIds: ['own', 'shared'] } },
        otherMessageIds: ['m2', 'm3', 'm4'],
        otherMessages: [{ metadata: { zipIds: ['shared', 'other'] } }, null, { metadata: { zipIds: 'not a list' } }]
      })
    ).toEqual(['own'])
  })

  it('takes a zip it claims whose maker is already gone, but never one another message still made', () => {
    expect(
      zipsOwnedOnlyByMessage({
        messageId: 'm1',
        sessionId: 's1',
        zips: [
          { zipId: 'orphaned', messageId: 'm0', sessionId: 's1' },
          { zipId: 'makers', messageId: 'm2', sessionId: 's1' }
        ],
        message: { metadata: { zipIds: ['orphaned', 'makers'] } },
        otherMessageIds: ['m2'],
        otherMessages: [{ metadata: {} }]
      })
    ).toEqual(['orphaned'])
  })

  it('counts a claim in another message’s text, zip_ids, or zipReferences, as the rest of Batshit reads one', () => {
    const zips = [1, 2, 3, 4, 5].map((n) => ({ zipId: Z(n), messageId: 'm1', sessionId: 's1' }))
    expect(
      zipsOwnedOnlyByMessage({
        messageId: 'm1',
        sessionId: 's1',
        zips,
        message: { metadata: { zipIds: zips.map((zip) => zip.zipId) } },
        otherMessageIds: ['m2', 'm3', 'm4', 'm5'],
        otherMessages: [
          { content: `see {{batshit-zip:${Z(1)}}}`, metadata: {} },
          { content: '', metadata: { zip_ids: [Z(2)] } },
          { content: '', metadata: { zipReferences: [{ zipId: Z(3) }] } },
          { content: `old {{batshit|id:${Z(4)}|x}}`, metadata: {} }
        ]
      })
    ).toEqual([Z(5)])
  })

  it('reads a message’s claims from its text as well as its metadata', () => {
    expect(zipClaimsOfMessage({ content: `a {{batshit-zip:${Z(1)}:::desc}}`, metadata: { zipIds: [Z(2)] } }).sort()).toEqual(
      [Z(1), Z(2)].sort()
    )
    expect(zipClaimsOfMessage(null)).toEqual([])
  })

  it('counts a text reference with an empty description, as the chat view reads it', () => {
    expect(zipClaimsOfMessage({ content: `x {{batshit-zip:${Z(6)}:::}} y`, metadata: {} })).toEqual([Z(6)])
  })

  it('reads a JSON.MGET $-path answer', () => {
    expect(firstJsonPathMatch(['m1'])).toBe('m1')
    expect(firstJsonPathMatch([])).toBeUndefined()
    expect(firstJsonPathMatch(null)).toBeUndefined()
  })
})

/**
 * BL-1513, BL-609: the chat delete (`redis.deleteSession`) and a message delete read the zips a
 * message's TEXT names with one reader, the trust reader's shape plus the older
 * `{{batshit|id:…|` form, so the sweep covers every reference trust and the chat view read.
 */
describe('the zips a message names in its text (BL-1513)', () => {
  const OLDER_FORM = /\{\{batshit\|id:([^|]+)\|/g

  it('names every reference the trust reader reads, and the older form, and nothing else', () => {
    const texts = [...REFERENCE_SCAN_HAND_CASES, ...generateReferenceScanTexts(4_000, 1_513)]
    let withReferences = 0
    for (const text of texts) {
      const shared = scanZipReferences(text).map((reference) => reference.id)
      const older = Array.from(text.matchAll(OLDER_FORM), (match) => match[1])
      const named = zipIdsNamedInText(text)
      for (const id of shared) expect(named, JSON.stringify(text)).toContain(id)
      expect([...named].sort(), JSON.stringify(text)).toEqual([...new Set([...shared, ...older])].sort())
      if (shared.length > 0) withReferences++
    }
    expect(withReferences).toBeGreaterThan(1_000)
  })

  it('reads an odd reference as the trust reader reads it', () => {
    const long = `cool_tool_${'1'.repeat(150)}_abcde`
    // An empty description (what `zipService.ts` writes for an empty one) and a spaced id are read.
    expect(zipIdsNamedInText(`A {{batshit-zip:${Z(1)}:::}} B`)).toEqual([Z(1)])
    expect(zipIdsNamedInText('{{batshit-zip:a b:::x}}')).toEqual(['a b'])
    // A `{`, a line break, or more than 160 characters in the id is no reference anywhere in
    // Batshit, and no zip Batshit writes has such an id.
    for (const odd of ['{{batshit-zip:a{b:::x}}', '{{batshit-zip:a\nb}}', `{{batshit-zip:${long}}}`]) {
      expect(zipIdsNamedInText(odd), JSON.stringify(odd)).toEqual([])
      expect(zipClaimsOfMessage({ content: odd, metadata: {} }), JSON.stringify(odd)).toEqual([])
    }
    // A reference inside the description of a spaced one is part of that one, as trust reads it.
    expect(zipIdsNamedInText(`{{batshit-zip:x :::{{batshit-zip:${Z(2)}}}`)).toEqual(['x '])
    expect(zipIdsNamedInText(`{{batshit|id:${Z(3)}|tool}}`)).toEqual([Z(3)])
  })

  it('reads 1 MB of 20,000 unclosed openers in well under 200 ms', () => {
    for (const [shape, reply] of Object.entries(unclosedReferenceReplies('zip'))) {
      const started = performance.now()
      expect(zipIdsNamedInText(reply), shape).toEqual([])
      expect(performance.now() - started, shape).toBeLessThan(200)
    }
  })
})

/**
 * BL-1798: a chat delete takes a zip only when its record names the chat, or names no chat and
 * the chat's own set lists it; a message's words and metadata alone never decide it.
 */
describe('the zips a deleted chat takes (BL-1798)', () => {
  it('takes this chat\'s zips wherever they are named, and never another chat\'s', () => {
    expect(
      zipsOfDeletedChat({
        sessionId: 's1',
        setMembers: [Z(1), Z(3), Z(5)],
        zips: [
          { zipId: Z(1), recordedSessionId: 's1' },
          { zipId: Z(2), recordedSessionId: 's1' },
          { zipId: Z(3), recordedSessionId: 's2' },
          { zipId: Z(4), recordedSessionId: 's2' },
          { zipId: Z(5), recordedSessionId: null },
          { zipId: Z(6), recordedSessionId: null }
        ]
      })
    ).toEqual([Z(1), Z(2), Z(5)])
  })

  it('reads a record\'s chat in the order the compile reads it', () => {
    const owner = 's1'
    const records: Array<Record<string, any>> = [
      { metadata: { sessionId: 's1' } },
      { metadata: { sessionId: ' s1 ' } },
      { metadata: { sessionId: 's2' } },
      { metadata: { session_id: 's2' } },
      { sessionId: 's1' },
      { session_id: 's2' },
      { metadata: { sessionId: 's1', session_id: 's2' }, sessionId: 's2' },
      { metadata: { sessionId: '', session_id: 's2' } },
      { metadata: { sessionId: null, session_id: 's2' } },
      { metadata: { sessionId: 42 } },
      { metadata: {} },
      {}
    ]
    for (const record of records) {
      const values = [record.metadata?.sessionId, record.metadata?.session_id, record.sessionId, record.session_id]
      const chat = zipRecordChat(values)
      // Another chat exactly when the compile's guard says so; this chat or none otherwise.
      expect(chat !== null && chat !== owner, JSON.stringify(record)).toBe(
        zipBelongsToAnotherChat(record, { sessionId: owner })
      )
    }
    expect(zipRecordChat([undefined, undefined, 's1', 's2'])).toBe('s1')
    expect(zipRecordChat([' ', 's2'])).toBeNull()
    expect(zipRecordChat([])).toBeNull()
  })

  it('names a message\'s claims and its page-saved zipMetadata as candidates', () => {
    const message = {
      content: `{{batshit-zip:${Z(1)}:::}} {{batshit|id:${Z(2)}|tool}}`,
      zipMetadata: [{ zipId: Z(3) }, { zipId: '' }, { zipId: 7 }, null],
      metadata: { zipIds: [Z(4)], zip_ids: [Z(5)], zipReferences: [{ zipId: Z(6) }] }
    }
    const candidates = zipCandidatesOfDeletedMessage(message)
    for (const id of zipClaimsOfMessage(message)) expect(candidates).toContain(id)
    expect([...candidates].sort()).toEqual([1, 2, 3, 4, 5, 6].map(Z).sort())
    expect(zipCandidatesOfDeletedMessage(null)).toEqual([])
  })
})
