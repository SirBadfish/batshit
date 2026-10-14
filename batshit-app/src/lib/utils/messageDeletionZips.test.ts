import { describe, expect, it } from 'vitest'
import { firstJsonPathMatch, zipClaimsOfMessage, zipsOwnedOnlyByMessage } from './messageDeletionZips'

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
