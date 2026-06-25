import { describe, expect, it } from 'vitest'

import {
  decodeStructuredTextContent,
  escapeAttributeValue,
  escapeHtml,
  escapeStructuredTextContent
} from '../htmlEntities'

describe('htmlEntities', () => {
  it('escapes full HTML text content', () => {
    expect(escapeHtml(`Tom & "Jerry" <tag> 'x'`)).toBe(
      'Tom &amp; &quot;Jerry&quot; &lt;tag&gt; &#39;x&#39;'
    )
  })

  it('escapes structured XML-like text without changing quotes', () => {
    expect(escapeStructuredTextContent(`"quoted" & <tag>`)).toBe(
      '"quoted" &amp; &lt;tag&gt;'
    )
  })

  it('escapes structured attribute values', () => {
    expect(escapeAttributeValue(`zip "one" & <two>`)).toBe(
      'zip &quot;one&quot; &amp; &lt;two&gt;'
    )
  })

  it('decodes structured text without double-decoding escaped entities', () => {
    expect(decodeStructuredTextContent('&lt;ok&gt;<br />&quot;x&quot;&#39;y&#39;')).toBe(
      `<ok>\n"x"'y'`
    )
    expect(decodeStructuredTextContent('&amp;quot;')).toBe('&quot;')
  })
})
