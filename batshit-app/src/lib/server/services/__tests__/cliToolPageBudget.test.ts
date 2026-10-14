import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { readSkillTextWindow } from '../skillReadWindow'
const require = createRequire(import.meta.url)
const { fitToolPagePayload, PAGE_MAX_CHARS } = require('../../../../../scripts/lib/cli-tool-page-budget.cjs')
const { buildCallToolContent } = require('../../../../../scripts/lib/cli-tool-result-content.cjs')

describe('managed helper page delivery budget', () => {
  it.each(['ASCII-', '漢字', '😀', '\u0001'])('reads every character without gaps for %j', (unit) => {
    const source = unit.repeat(9_000)
    let offset = 0
    let reconstructed = ''
    do {
      const original = {
        success: true, controlId: 'sys.zip.fetch', result: {
          found: true, zipId: 'tool_raw_test', content: source.slice(offset),
          contentLength: source.length, offset, nextOffset: null, contentTruncated: false
        }
      }
      const before = JSON.stringify(original)
      const page = fitToolPagePayload(original, 'fetch-zip', { maxUtf8Bytes: 8_000, source: 'codex-fallback' })
      const delivered = buildCallToolContent(page, []).content[0].text
      expect(Buffer.byteLength(delivered, 'utf8')).toBeLessThanOrEqual(8_000)
      expect(JSON.stringify(original)).toBe(before)
      const result = JSON.parse(delivered).result
      expect(result.content.length).toBeGreaterThan(0)
      expect(result.content).not.toMatch(/[\uD800-\uDBFF]$/)
      expect(result.content).not.toMatch(/^[\uDC00-\uDFFF]/)
      reconstructed += result.content
      expect(result.offset).toBe(offset)
      if (result.nextOffset === null) break
      expect(result.nextOffset).toBe(offset + result.content.length)
      expect(result.readMore).toContain(`offset ${result.nextOffset}`)
      offset = result.nextOffset
    } while (offset < source.length)
    expect(reconstructed).toBe(source)
  })

  it('fits skill metadata and updates the real source offset after inner JSON escaping', () => {
    const result = {
      success: true, skillId: 'skill-1', path: 'references/guide.md', action: 'read',
      content: '\u0001'.repeat(5_000), offset: 200, originalChars: 9_000,
      returnedChars: 5_000, contentTruncated: true, nextOffset: 5_200,
      readMore: 'old next offset 5200'
    }
    const page = fitToolPagePayload(result, 'skill-read', { maxUtf8Bytes: 8_000, source: 'codex-fallback' })
    expect(page.returnedChars).toBe(page.content.length)
    expect(page.nextOffset).toBe(200 + page.content.length)
    expect(page.nextOffset).toBeLessThan(5_200)
    expect(page.readMore).toContain(`offset ${page.nextOffset}`)
    expect(Buffer.byteLength(JSON.stringify(page, null, 2))).toBeLessThanOrEqual(8_000)
  })

  it('preserves a fitting page and refuses metadata that alone exceeds the limit', () => {
    const small = { found: true, zipId: 'zip-1', content: 'hello', contentLength: 5, offset: 0, nextOffset: null }
    expect(fitToolPagePayload(small, 'fetch-zip', { maxUtf8Bytes: 8_000 })).toBe(small)
    expect(fitToolPagePayload({ ...small, description: 'x'.repeat(9_000) }, 'fetch-zip', {
      maxUtf8Bytes: 8_000, source: 'codex-fallback'
    })).toEqual({ success: false, error: expect.stringContaining('metadata does not fit') })
    expect(fitToolPagePayload(small, undefined, { maxUtf8Bytes: 1 })).toBe(small)
  })

  // BL-676: the Claude lane has no byte budget. A page over the guard's limit was passed on
  // whole, the guard cut it again, and the page's own next offset then skipped text.
  it.each(['ASCII-', '"\\', '漢字', '😀'])('fits a Claude-lane page with no byte budget and reads all of %j', (unit) => {
    const source = unit.repeat(Math.ceil(300_000 / unit.length)).slice(0, 300_000)
    let offset = 0
    let reconstructed = ''
    let pages = 0
    do {
      const body = {
        auth: 'agent', success: true, controlId: 'sys.zip.fetch', result: {
          found: true, zipId: 'tool_raw_test', content: source.slice(offset, offset + 250_000),
          contentLength: source.length, offset, nextOffset: null, contentTruncated: false,
          description: 'kept copy', metadata: { sessionId: 'chat-1' }
        }
      }
      const page = fitToolPagePayload(body, 'fetch-zip', undefined)
      const delivered = buildCallToolContent(page, []).content[0].text
      pages += 1
      expect(delivered.length).toBeLessThanOrEqual(PAGE_MAX_CHARS)
      // BL-677: the guard's own 96,000-character ceiling, so a saved page is never too large.
      expect(delivered.length).toBeLessThanOrEqual(96_000)
      expect(Math.ceil(delivered.length / 4)).toBeLessThan(25_000)
      const result = JSON.parse(delivered).result
      expect(result.offset).toBe(offset)
      expect(result.content.length).toBeGreaterThan(0)
      reconstructed += result.content
      if (result.nextOffset === null) break
      expect(result.nextOffset).toBe(offset + result.content.length)
      expect(result.readMore).toContain(`offset ${result.nextOffset}`)
      expect(result.readMore).toContain(`one result (${PAGE_MAX_CHARS} characters)`)
      offset = result.nextOffset
    } while (offset < source.length)
    expect(reconstructed).toBe(source)
    expect(pages).toBeGreaterThan(3)
  })

  // Review of BL-676: with the page's details nearly filling the limit, the page never ends
  // inside a pair; it is shorter, or refused, instead.
  it.each([['pairs only', '😀'.repeat(500)], ['a letter, then pairs', `a${'😀'.repeat(500)}`]])(
    'never splits a pair when the details leave room for a character or two (%s)',
    (_label, source) => {
      const body = (description: string) => ({
        success: true, controlId: 'sys.zip.fetch', result: {
          found: true, zipId: 'tool_raw_test', content: source, contentLength: source.length,
          offset: 0, nextOffset: null, contentTruncated: false, description
        }
      })
      const fit = (length: number) => fitToolPagePayload(body('d'.repeat(length)), 'fetch-zip', undefined)
      // The shortest description whose page is refused: from there, room shrinks to nothing.
      let low = 0
      let high = PAGE_MAX_CHARS
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (fit(middle).success === false) high = middle
        else low = middle + 1
      }
      const seen = new Set<string>()
      for (let length = low - 40; length <= low + 2; length += 1) {
        const page = fit(length)
        if (page.success === false) { seen.add('refused'); continue }
        const delivered = buildCallToolContent(page, []).content[0].text
        expect(delivered.length).toBeLessThanOrEqual(PAGE_MAX_CHARS)
        const result = JSON.parse(delivered).result
        if (result.content === source) { seen.add('whole'); continue }
        expect(result.content.length).toBeGreaterThan(0)
        expect(result.content).not.toMatch(/[\uD800-\uDBFF]$/)
        expect(source.slice(result.nextOffset)).not.toMatch(/^[\uDC00-\uDFFF]/)
        expect(result.content).toBe(source.slice(0, result.content.length))
        seen.add(result.content.length <= 2 ? 'tiny page' : 'page')
      }
      expect(seen.has('refused')).toBe(true)
      expect(seen.has('tiny page')).toBe(true)
    }
  )

  it('keeps a page below the ordinary size guard even with a higher user limit', () => {
    const page = fitToolPagePayload({
      found: true, zipId: 'zip-1', content: 'x'.repeat(120_000), contentLength: 120_000, offset: 0
    }, 'fetch-zip', { maxUtf8Bytes: 300_000, source: 'codex-profile' })
    expect(JSON.stringify(page, null, 2).length).toBeLessThanOrEqual(96_000)
    expect(page.nextOffset).toBe(page.content.length)
  })

  it('does not split an emoji before the helper receives a skill page', () => {
    const text = 'a'.repeat(63) + '😀tail'
    const first = readSkillTextWindow(text, 64)
    const second = readSkillTextWindow(text, 64, first.content.length)
    expect(first.content).toBe('a'.repeat(63))
    expect(first.content + second.content).toBe(text)
  })
})
