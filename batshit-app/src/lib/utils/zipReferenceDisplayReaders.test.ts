import { describe, expect, it } from 'vitest'
import { generateReferenceScanTexts } from '$lib/test-utils/referenceScanTexts'
import { normalizeId } from './idNormalizer'
import { parseMessageContent } from './messageFormatter'
import { namesOnlyToolZips, zipIdOfReference, zipIdsInMessageText } from './messageZipIds'
import { buildToolStreamStateFromContent, isToolZipRef } from './toolStreamState'
import { stripZipControlBlocks } from './zipControl'
import { scanZipReferences } from './zipReferenceSafety'

/**
 * BL-609: the chat view's zip reference readers read the trust reader's one shape
 * (`scanZipReferences`), so a spaced or odd id reads the same in the view as at the reply end.
 * Each reader is compared with the shape on odd references and on generated texts.
 */

const ZIP = 'cool_tool_1790500000000_abcde'
const ODD = [
  `{{batshit-zip:${ZIP}:::}}`, // an empty description: a reference
  '{{batshit-zip:a}b}}', // a `}` in the id: not one
  '{{batshit-zip:a{b:::x}}', // a `{` in the id: not one
  '{{batshit-zip:a\nb}}', // a line break in the id: not one
  `{{batshit-zip:${'a'.repeat(161)}}}`, // longer than 160: not one
  '{{batshit-zip:a b:::x}}', // a space: a reference, which trust then refuses
  `{{batshit-zip:${ZIP}:::Tool execution: read}}`
]
const TEXTS = [...ODD, ODD.join(' and '), ...generateReferenceScanTexts(1500, 609)]
const sharedIds = (text: string) => scanZipReferences(text).map((reference) => reference.id)

describe('zip reference display readers read the trust reader\'s shape (BL-609)', () => {
  it('messageFormatter: a zip card for each reference the shape reads, and no other', () => {
    for (const text of TEXTS) {
      const stripped = stripZipControlBlocks(text)
      const expected = sharedIds(stripped)
      const trusted = new Set(expected.map((id) => normalizeId(id)))
      const segments = parseMessageContent(text, 'user', undefined, [], trusted)
      expect(segments.filter((segment) => segment.zipId).map((segment) => segment.zipId), text).toEqual(expected)
    }
  })

  it('MessageContent (zipIdsInMessageText, namesOnlyToolZips): the ids the shape reads', () => {
    for (const text of TEXTS) {
      const ids = sharedIds(text)
      // The older form is read after the references, by its own unchanged rule.
      const older = Array.from(text.matchAll(/\{\{batshit\|id:([^|]+)\|[^}]+\}\}/g), (match) => match[1])
      expect(zipIdsInMessageText(text), text).toEqual([...new Set([...ids, ...older])])
      const trusted = new Set(ids.map((id) => normalizeId(id)))
      const trustedOlder = older.filter((id) => trusted.has(normalizeId(id)))
      expect(zipIdsInMessageText(text, trusted), text).toEqual([...new Set([...ids, ...trustedOlder])])
      expect(namesOnlyToolZips(text), text).toBe(ids.length > 0 && ids.every((id) => id.includes('cool_tool')))
    }
    // The older form is still read, after the references.
    expect(zipIdsInMessageText(`{{batshit|id:old_1|x}} {{batshit-zip:${ZIP}}}`)).toEqual([ZIP, 'old_1'])
    // Only trusted ids, when a trusted set is given.
    expect(zipIdsInMessageText(`{{batshit-zip:${ZIP}}} {{batshit-zip:error_1790500000000_abcde}}`, new Set([ZIP]))).toEqual([ZIP])
  })

  it('MessageContent and ImageGenerationRenderer (zipIdOfReference): the first id the shape reads', () => {
    for (const text of TEXTS) expect(zipIdOfReference(text), text).toBe(sharedIds(text)[0] ?? null)
    expect(zipIdOfReference('')).toBeNull()
  })

  it('toolStreamState: a tool card at each tool reference the shape reads, the rest as text', () => {
    for (const text of TEXTS) {
      let order = 0
      const state = buildToolStreamStateFromContent(text, () => order++)
      const tools = scanZipReferences(text).filter((reference) => isToolZipRef(reference.id, reference.description ?? ''))
      expect(state.insertions.map((insertion) => insertion.ref), text).toEqual(tools.map((reference) => reference.match))
      let rest = ''
      let from = 0
      for (const reference of tools) {
        rest += text.slice(from, reference.start)
        from = reference.end
      }
      expect(state.textBuffer, text).toBe(rest + text.slice(from))
    }
  })
})
