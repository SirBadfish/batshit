import { describe, expect, it } from 'vitest'
import { findStructuredElements } from './structuredTagScan'
import { parseMessageContent } from './messageFormatter'

const errorCards = (text: string) =>
  findStructuredElements(text)
    .filter((element) => element.name === 'error' && !element.partial)
    .map((element) => text.substring(element.start, element.end))

// BL-779 (d), the page's half: the server saves an Error block by the same close rule
// (`zipDetection.ts` calls `findErrorBlockClose`), so the view never draws a card the save kept as
// words, and never ends a card early inside the block's own fence.
describe('structuredTagScan: an Error block does not end inside its own fence (BL-779 d)', () => {
  it('draws no card when the only closing tag is inside a fence that opened in the block', () => {
    expect(errorCards('<error>\n```\ncode </error> more\n```\nafter')).toEqual([])
    expect(errorCards('See <error>\n~~~\ncode </error> more\n~~~\nafter')).toEqual([])
  })

  it('ends the card at the first closing tag outside the block\'s fences', () => {
    const text = 'See <error>\n```\ncode </error> more\n```\nafter </error> tail'

    expect(errorCards(text)).toEqual(['<error>\n```\ncode </error> more\n```\nafter </error>'])
  })

  it('still ends a card at the first closing tag when the block holds no fence', () => {
    expect(errorCards('A <error>one `</error>` two</error> B')).toEqual(['<error>one `</error>'])
  })

  it('reads every later exact Error tag as words up to the next zip reference after a block that never closes', () => {
    const zip = 'cool_tool_1790500000000_abcde'
    const text = `<error>\n\`\`\`\n<error>y</error>\n\`\`\`\n{{batshit-zip:${zip}:::read}} then <error>z</error>`

    expect(errorCards(text)).toEqual(['<error>z</error>'])
  })

  it('keeps the compiled form of an Error zip closing at its own closing tag', () => {
    const zip = 'error_1790500000000_abcde'
    const text = `<error data-zip-id="${zip}" data-zip-type="error">old words\n\`\`\`\ncode</error> after`

    expect(findStructuredElements(text, (id) => id === zip).map((element) => element.name)).toEqual(['error'])
  })

  it('keeps every word of a card whose block holds a closing tag inside its fence', () => {
    const segments = parseMessageContent('Before.\n<error>\n```\ncode </error> more\n```\nafter </error>\nAfter.', 'assistant')

    expect(segments.map((segment) => segment.type)).toEqual(['text', 'error', 'text'])
    expect(segments[1].content).toContain('code </error> more')
    expect(segments[1].content).toContain('after')
    expect(segments[2].content).toBe('After.')
  })
})
