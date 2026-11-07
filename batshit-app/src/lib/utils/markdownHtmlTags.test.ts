import { describe, expect, it } from 'vitest'
import { escapeNonHtmlTags, isHtmlElementName } from './markdownHtmlTags'

describe('escapeNonHtmlTags (BL-812)', () => {
  it('escapes a tag that is not an HTML element and keeps HTML elements', () => {
    expect(escapeNonHtmlTags('<error>')).toBe('&lt;error&gt;')
    expect(escapeNonHtmlTags('</batshit-memory>')).toBe('&lt;/batshit-memory&gt;')
    expect(escapeNonHtmlTags('<image src="a.png" />')).toBe('&lt;image src=&quot;a.png&quot; /&gt;')
    for (const tag of ['<strong>', '</strong>', '<br/>', '<a href="x">', '<KBD>', '<script>', '<img src=x>']) {
      expect(escapeNonHtmlTags(tag)).toBe(tag)
    }
  })

  it('escapes only the non-HTML tags of a block of raw HTML', () => {
    expect(escapeNonHtmlTags('<div>\n<error>x</error>\n</div>')).toBe('<div>\n&lt;error&gt;x&lt;/error&gt;\n</div>')
  })

  it('keeps the reasoning tags of thinking models on the old path, in any case', () => {
    for (const tag of ['<think>', '</think>', '<Thinking>', '</thinking>', '<reasoning>', '</REASONING>']) {
      expect(escapeNonHtmlTags(tag)).toBe(tag)
    }
  })

  it('keeps inline SVG and MathML whole, and type names that are plain words as words', () => {
    for (const html of ['<svg viewBox="0 0 1 1"><circle r="1"/><linearGradient id="g"/></svg>', '<math><mrow><mn>1</mn></mrow></math>']) {
      expect(escapeNonHtmlTags(html)).toBe(html)
    }
    for (const tag of ['<Set>', '<Path>', '<Text>', '<G>', '<Mi>']) {
      expect(escapeNonHtmlTags(tag)).not.toBe(tag)
    }
    expect(isHtmlElementName('image')).toBe(false)
  })

  it('leaves comments, declarations, and a lone < alone', () => {
    for (const text of ['<!-- hi -->', '<!DOCTYPE html>', 'a < b', '<?xml version="1.0"?>']) {
      expect(escapeNonHtmlTags(text)).toBe(text)
    }
  })

  it('knows the HTML element names case-insensitively, and not Batshit tags', () => {
    expect(isHtmlElementName('DIV')).toBe(true)
    expect(isHtmlElementName('image')).toBe(false)
    expect(isHtmlElementName('error')).toBe(false)
    expect(isHtmlElementName('terminal')).toBe(false)
  })

  it('stays linear on many unfinished tags with open quotes', () => {
    const text = '<x a="'.repeat(50000)
    const started = performance.now()
    expect(escapeNonHtmlTags(text)).toBe(text)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
