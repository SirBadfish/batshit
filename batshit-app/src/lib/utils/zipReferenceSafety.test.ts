import { describe, expect, it } from 'vitest'
import {
  collectTrustedClipIdsFromMetadata,
  collectTrustedZipIdsFromMetadata,
  extractTrustedZipIdsFromContent,
  extractTrustedClipIdsFromContent,
  isConcreteClipId,
  isConcreteZipId,
  neutralizeAllClipReferenceSyntax,
  neutralizeAllZipReferenceSyntax,
  neutralizeUntrustedClipReferenceSyntax,
  neutralizeUntrustedZipReferenceSyntax
} from './zipReferenceSafety'

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
        clipIds: ['clip_1779416324513_array1', 'clip_id', 'batshit_guide'],
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
