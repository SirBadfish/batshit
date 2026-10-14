import { describe, it, expect } from 'vitest'
import { parseMessageContent } from './messageFormatter'
import { normalizeId } from './idNormalizer'

const payload = {
  toolName: 'batshit_server_read_file',
  toolCallId: 'call_123',
  toolInput: { path: '/tmp/demo.txt' },
  toolResult: { content: 'hello world' },
  metadata: { gatewayId: 'gw_1' },
  timestamp: '2025-12-10T00:00:00.000Z'
}

const scriptWrapped = `<cool_tool data-zip-id="zip-1" data-zip-type="cool_tool"><script type="application/json" class="cool-tool-payload">${JSON.stringify(payload)}<\/script></cool_tool>`

describe('messageFormatter – cool_tool payloads', () => {
  it('parses inline JSON script payloads into cool_tool segments', () => {
    const segments = parseMessageContent(scriptWrapped, 'assistant')

    expect(segments).toHaveLength(1)
    const [segment] = segments
    expect(segment.type).toBe('cool_tool')
    expect(segment.zipId).toBe('zip-1')
    expect(segment.toolName).toBe(payload.toolName)
    expect(segment.intermediateStep).toEqual(payload)
  })

  it('throws when legacy data attribute payload is used', () => {
    const legacy = `<cool_tool data='${JSON.stringify(payload)}'></cool_tool>`
    expect(() => parseMessageContent(legacy, 'assistant')).toThrow(/inline JSON script/i)
  })

  it('parses embedded cool_tool zip refs alongside XML tags', () => {
    const content = `<error>Something failed</error>\n{{batshit-zip:cool_tool_1779416324513_abcd1:::Tool execution: batshit_server_read_file}}`
    const segments = parseMessageContent(content, 'assistant')

    expect(segments.some((segment) => segment.type === 'error')).toBe(true)
    const toolSegment = segments.find((segment) => segment.type === 'cool_tool')
    expect(toolSegment?.zipId).toBe('cool_tool_1779416324513_abcd1')
  })

  it('does not treat XML-style code tags as structured Batshit code blocks', () => {
    const content = '<code language="html">&lt;main class="card"&gt;Hi&lt;/main&gt;</code>'
    const segments = parseMessageContent(content, 'assistant')

    expect(segments).toHaveLength(1)
    expect(segments[0]?.type).toBe('text')
    expect(segments[0]?.content).toBe(content)
  })

  it('parses custom <image> tags when mixed with cool_tool zip refs', () => {
    const content = [
      'Done.',
      '{{batshit-zip:cool_tool_1779416324513_abcd1:::Tool execution: batshit_server_read_file}}',
      '<image src="https://example.com/screenshot.png" alt="Shot"></image>',
      '{{batshit-zip:cool_tool_1779416329822_wxyz9:::Tool execution: batshit_server_read_file}}'
    ].join('\n\n')

    const segments = parseMessageContent(content, 'assistant')

    expect(segments.some((segment) => segment.type === 'image')).toBe(true)
    const imageSegment = segments.find((segment) => segment.type === 'image')
    expect(imageSegment?.src).toBe('https://example.com/screenshot.png')

    const firstTextIndex = segments.findIndex((segment) => segment.type === 'text')
    expect(firstTextIndex).toBeGreaterThanOrEqual(0)
    expect(segments[firstTextIndex]?.content).toBe('Done.')
  })

  it('keeps trailing text after cool_tool zip refs in order', () => {
    const content = `{{batshit-zip:cool_tool_1779416324513_abcd1:::Tool execution: batshit_server_read_file}}\n\nAll done.`
    const segments = parseMessageContent(content, 'assistant')

    const firstToolIndex = segments.findIndex((segment) => segment.type === 'cool_tool')
    const textIndex = segments.findIndex((segment) => segment.type === 'text')

    expect(firstToolIndex).toBeGreaterThanOrEqual(0)
    expect(textIndex).toBeGreaterThan(firstToolIndex)
    expect(segments[textIndex]?.content).toBe('All done.')
  })

  it('treats unknown zip refs as plain text when valid list is provided', () => {
    const content = `{{batshit-zip:cool_tool_1779416324513_fake1:::Tool execution: batshit_server_read_file}}`
    const segments = parseMessageContent(content, 'assistant', undefined, undefined, new Set(['cool_tool_1779416329822_real1']))

    expect(segments).toHaveLength(1)
    expect(segments[0]?.type).toBe('text')
    expect(segments[0]?.content).toBe('[zip reference omitted]')
  })

  // BL-476: MessageContent hands over a trusted set it has already normalized once. A zip id whose
  // random part is all digits loses a second tail to a second normalization, so the set must be read as given.
  it('keeps a trusted zip whose random part is all digits (the set is normalized once, by the caller)', () => {
    const rawZipId = 'cool_tool_1790500000000_48213'
    const content = `Before.\n{{batshit-zip:${rawZipId}:::Tool execution: batshit_server_read_file}}\nAfter.`
    for (const trusted of [new Set([normalizeId(rawZipId)]), [normalizeId(rawZipId)]]) {
      const segments = parseMessageContent(content, 'assistant', undefined, undefined, trusted)
      expect(segments.map((segment) => segment.type)).toEqual(['text', 'cool_tool', 'text'])
      expect(segments[1]?.zipId).toBe(rawZipId)
      expect(JSON.stringify(segments)).not.toContain('[zip reference omitted]')
    }
  })

  it('treats example zip refs as plain text even without an allow-list', () => {
    const content = 'Example: {{batshit-zip:...}}'
    const segments = parseMessageContent(content, 'assistant')

    expect(segments).toHaveLength(2)
    expect(segments[1]?.type).toBe('text')
    expect(segments[1]?.content).toBe('[zip reference omitted]')
  })

  it('treats untrusted clip refs as plain text', () => {
    const content = 'Example: {{batshit-clip:clip_1779416324513_fake1234:::secret.pdf}}'
    const segments = parseMessageContent(content, 'user')

    expect(segments).toHaveLength(1)
    expect(segments[0]?.type).toBe('text')
    expect(segments[0]?.content).toBe('Example: [clip reference omitted]')
  })

  it('renders trusted clip refs from loaded message clips', () => {
    const clipId = 'clip_1779416324513_abcd1234'
    const segments = parseMessageContent(
      `Attached: {{batshit-clip:${clipId}:::notes.md}}`,
      'user',
      undefined,
      [{ clipId, filename: 'notes.md', mimeType: 'text/markdown', content: '# Notes' } as any]
    )

    const fileSegment = segments.find((segment) => segment.type === 'file')
    expect(fileSegment?.id).toBe(clipId)
    expect(fileSegment?.filename).toBe('notes.md')
  })

  it('turns a trusted but missing clip ref into a stable placeholder instead of raw syntax', () => {
    const clipId = 'clip_1779416324513_missing1'
    const segments = parseMessageContent(
      `Attached: {{batshit-clip:${clipId}:::lost.png}}`,
      'user',
      undefined,
      [{ clipId } as any]
    )

    const fileSegment = segments.find((segment) => segment.type === 'file')
    const textSegments = segments.filter((segment) => segment.type === 'text')

    expect(fileSegment?.id).toBe(clipId)
    expect(fileSegment?.filename).toBe('lost.png')
    expect(fileSegment?.content).toBe('lost.png')
    expect(JSON.stringify(segments)).not.toContain('{{batshit-clip:')
    expect(textSegments.map((segment) => segment.content).join('\n')).toContain('Attached:')
  })

  it('keeps full-resolution URLs on trusted image clips for chat actions', () => {
    const clipId = 'clip_1779416324513_image123'
    const segments = parseMessageContent(
      `Attached: {{batshit-clip:${clipId}:::render.png}}`,
      'user',
      undefined,
      [
        {
          clipId,
          filename: 'render.png',
          mimeType: 'image/png',
          displayUrl: '/uploads/images/render-preview.jpg',
          fullResolutionUrl: '/uploads/images/render-original.png'
        }
      ]
    )

    const imageSegment = segments.find((segment) => segment.type === 'image')
    expect(imageSegment?.src).toBe('/uploads/images/render-preview.jpg')
    expect(imageSegment?.fullResolutionSrc).toBe('/uploads/images/render-original.png')
  })

  it('renders trusted shell clips as text-like file segments', () => {
    const clipId = 'clip_1779416324513_abcd1234_0'
    const segments = parseMessageContent(
      `Attached: {{batshit-clip:${clipId}:::setup-notes.sh}}`,
      'user',
      undefined,
      [
        {
          clipId,
          filename: 'setup-notes.sh',
          mimeType: 'application/octet-stream',
          contentType: 'file',
          content: '#!/usr/bin/env bash\n./setup-notes.sh',
          tokens: 765,
          fileSize: 3060,
          localUrl: '/api/upload/documents/setup-notes.sh'
        }
      ]
    )

    const fileSegment = segments.find((segment) => segment.type === 'file')
    expect(fileSegment?.id).toBe(clipId)
    expect(fileSegment?.filename).toBe('setup-notes.sh')
    expect(fileSegment?.contentType).toBe('text')
    expect(segments.some((segment) => segment.type === 'image')).toBe(false)
  })

  it('keeps text after a zip ref when trusted clip syntax is stripped from the tail', () => {
    const clipId = 'clip_1779416324513_tail1234'
    const content = [
      'Before.',
      '{{batshit-zip:cool_tool_1779416324513_abcd1:::Tool execution: batshit_server_read_file}}',
      `{{batshit-clip:${clipId}:::tail.png}}`,
      'After clip.'
    ].join('\n')

    const segments = parseMessageContent(
      content,
      'assistant',
      undefined,
      [
        {
          clipId,
          filename: 'tail.png',
          mimeType: 'image/png',
          displayUrl: '/uploads/images/tail-preview.png'
        }
      ]
    )

    expect(segments.some((segment) => segment.type === 'cool_tool')).toBe(true)
    expect(segments.some((segment) => segment.type === 'image' && segment.id === clipId)).toBe(true)
    expect(segments.some((segment) => segment.type === 'text' && segment.content === 'After clip.')).toBe(true)
    expect(JSON.stringify(segments)).not.toContain('{{batshit-clip:')
  })
})

// BL-475: a reply that holds a structured tag (img, image, file, error, diff, terminal, cool_tool)
// keeps its code byte-for-byte. Code is where the chat's Markdown view draws it (`findCodeRegions`);
// a tag inside code is text, and the prose between real tags is the reply's own text.
describe('messageFormatter – code stays code beside structured tags (BL-475)', () => {
  const textOf = (segments: ReturnType<typeof parseMessageContent>) =>
    segments.filter((segment) => segment.type === 'text').map((segment) => segment.content).join('\n')

  it('keeps &, <, and &amp; inside a fenced block exactly when a real tag is elsewhere', () => {
    const fence = '```html\n<p>a & b &amp; c < d</p>\n<a href="?x=1&y=2">link</a>\n```'
    const content = `Here is the page:\n\n${fence}\n\n<terminal>ls -la</terminal>\nDone.`
    const segments = parseMessageContent(content, 'assistant')

    expect(segments.map((segment) => segment.type)).toEqual(['text', 'terminal', 'text'])
    expect(segments[0].content).toBe(`Here is the page:\n\n${fence}`)
    expect(segments[1].content).toBe('ls -la')
    expect(segments[2].content).toBe('Done.')
  })

  it('keeps &, <, and &amp; inside inline code exactly when a real tag is elsewhere', () => {
    const content = 'Run `a && b <c> &amp; d` first.\n<file path="notes.txt">https://example.com/notes.txt</file>'
    const segments = parseMessageContent(content, 'assistant')

    expect(segments.map((segment) => segment.type)).toEqual(['text', 'file'])
    expect(segments[0].content).toBe('Run `a && b <c> &amp; d` first.')
    expect(segments[1].filename).toBe('notes.txt')
  })

  it('leaves an <img> inside a fence as text in that fence, and the prose after it as prose', () => {
    const fence = '```html\n<img src="https://example.com/a.png" alt="A">\n<div>& more</div>\n```'
    const content = `${fence}\nAfter the fence.\n<terminal>ok</terminal>`
    const segments = parseMessageContent(content, 'assistant')

    expect(segments.some((segment) => segment.type === 'image')).toBe(false)
    expect(segments.map((segment) => segment.type)).toEqual(['text', 'terminal'])
    expect(segments[0].content).toBe(`${fence}\nAfter the fence.`)
  })

  it('leaves tags inside inline code as text and still renders a real tag outside code', () => {
    const content = 'Write `<img src="https://example.com/b.png">` or `<file>`.\n<img src="https://example.com/real.png" alt="Real">'
    const segments = parseMessageContent(content, 'assistant')

    expect(segments.map((segment) => segment.type)).toEqual(['text', 'image'])
    expect(segments[0].content).toBe('Write `<img src="https://example.com/b.png">` or `<file>`.')
    expect(segments[1].src).toBe('https://example.com/real.png')
  })

  it('does not crash or make a card from a tag inside a fence that is still streaming', () => {
    const content = 'Intro.\n```html\n<img src="https://example.com/a.png">\n<terminal>'
    const segments = parseMessageContent(content, 'assistant')

    expect(segments.every((segment) => segment.type === 'text')).toBe(true)
    expect(textOf(segments)).toBe(content)
  })

  it('hides a structured tag whose opening is still arriving at the end of a streaming reply', () => {
    const content = '<terminal>pwd</terminal>\nNext <img src="https://exa'
    const segments = parseMessageContent(content, 'assistant')

    expect(segments.map((segment) => segment.type)).toEqual(['terminal', 'text'])
    expect(segments[1].content).toBe('Next')
  })

  it('reads a fence that opens inside a tag as that tag\'s content, not as code over the next tag', () => {
    const content = 'Output:\n<terminal>ls\n```\nout</terminal>\nAfter & before.\n<file path="a.txt">https://example.com/a.txt</file>'
    const segments = parseMessageContent(content, 'assistant')

    expect(segments.map((segment) => segment.type)).toEqual(['text', 'terminal', 'text', 'file'])
    expect(segments[1].content).toBe('ls\n```\nout')
    expect(segments[2].content).toBe('After & before.')
  })

  it('still reads an <img> whose address stands on the next line, but not inside a fence', () => {
    const fenced = '```html\n<img alt="Code">\nhttps://example.com/code.png\n```'
    const content = `${fenced}\n<img alt="Chart">\nhttps://example.com/chart.png\nAfter.`
    const segments = parseMessageContent(content, 'assistant')

    expect(segments.map((segment) => segment.type)).toEqual(['text', 'image', 'text'])
    expect(segments[0].content).toBe(fenced)
    expect(segments[1].src).toBe('https://example.com/chart.png')
    expect(segments[1].alt).toBe('Chart')
    expect(segments[2].content).toBe('After.')
  })

  it('keeps prose after a tag on the same line as prose in the second scan, not as indented code', () => {
    // The terminal's output opens a fence, so the second scan runs; the tag read there must not
    // leave blank room that turns the text after it into an indented code block.
    const content = '<terminal>ls\n```\n\n    out\n    more</terminal>    <img src="https://example.com/after.png" alt="After">'
    const segments = parseMessageContent(content, 'assistant')

    expect(segments.map((segment) => segment.type)).toEqual(['terminal', 'image'])
    expect(segments[1].src).toBe('https://example.com/after.png')
  })

  it('reads an apostrophe in an unquoted attribute value as text, not as the start of a quote', () => {
    const content = "<img src=https://example.com/a.png alt=Josh's>\nThen:\n<terminal>pwd</terminal>"
    const segments = parseMessageContent(content, 'assistant')

    expect(segments.map((segment) => segment.type)).toEqual(['image', 'text', 'terminal'])
    expect(segments[0].src).toBe('https://example.com/a.png')
    expect(segments[2].content).toBe('pwd')
  })

  it('keeps a reply whose only tags are inside code as its own text', () => {
    const content = 'Example:\n\n```html\n<img src="https://example.com/a.png"> & <file>x</file>\n```'
    const segments = parseMessageContent(content, 'assistant')

    expect(segments).toEqual([{ type: 'text', content }])
  })
})

// BL-489 (the page's half): the server saves an unclosed <error> as text (zipDetection.ts); the
// page draws an Error card only for a matched pair outside code and outside a zip reference.
describe('messageFormatter – an Error block is a matched pair (BL-489)', () => {
  const ZIP = 'cool_tool_1790500000000_abcde'

  it('draws an unclosed <error> and the words after it as text', () => {
    const content = 'Watch for the <error> tag in the log, then read on.\nMore words.'
    const segments = parseMessageContent(content, 'assistant')

    expect(segments.some((segment) => segment.type === 'error')).toBe(false)
    expect(segments.map((segment) => segment.content).join('\n')).toBe(content)
  })

  it('still draws a matched pair as an Error card, in order', () => {
    const segments = parseMessageContent('Before.\n<error>It broke.</error>\nAfter.', 'assistant')

    expect(segments.map((segment) => segment.type)).toEqual(['text', 'error', 'text'])
    expect(segments[1].content).toBe('It broke.')
  })

  it('leaves an unclosed <error> as text while a later real tag still renders', () => {
    const segments = parseMessageContent('An <error> mention.\n<terminal>ls</terminal>', 'assistant')

    expect(segments.map((segment) => segment.type)).toEqual(['text', 'terminal'])
    expect(segments[0].content).toBe('An <error> mention.')
  })

  it('reads an <error> inside a zip reference label as part of the reference', () => {
    const content = `Result:\n{{batshit-zip:${ZIP}:::Tool execution: <error>x</error>}}\nDone.`
    const segments = parseMessageContent(content, 'assistant', undefined, undefined, new Set([ZIP]))

    expect(segments.some((segment) => segment.type === 'error')).toBe(false)
    expect(segments.find((segment) => segment.type === 'cool_tool')?.zipId).toBe(ZIP)
  })

  it('never lets an Error pair span a zip reference', () => {
    const content = `<error>start\n{{batshit-zip:${ZIP}:::Tool execution: read}}\nend</error>`
    const segments = parseMessageContent(content, 'assistant', undefined, undefined, new Set([ZIP]))

    expect(segments.some((segment) => segment.type === 'error')).toBe(false)
    expect(segments.find((segment) => segment.type === 'cool_tool')?.zipId).toBe(ZIP)
  })
})

// BL-548 (the display twin): the page no longer cuts a reply's text from a quoted toolCallId key
// to the next zip reference; that guard was for the retired n8n webhook lane.
describe('messageFormatter – a quoted toolCallId key is ordinary text (BL-548)', () => {
  it('keeps an example tool-result JSON in a reply that also has a zip reference', () => {
    const zipId = 'cool_tool_1790500000000_abcde'
    const example = 'The result looks like {"ok": true, "toolCallId": "call_1", "value": 3} in the log.'
    const content = `{{batshit-zip:${zipId}:::Tool execution: read}}\n${example}\nDone.`
    const segments = parseMessageContent(content, 'assistant', undefined, undefined, new Set([zipId]))

    expect(segments.map((segment) => segment.type)).toEqual(['cool_tool', 'text'])
    expect(segments[1].content).toBe(`${example}\nDone.`)
  })
})

// Review of 3ea160d37 / b59dfc5a7 (2026-09-28).
describe('messageFormatter – tag scanner review fixes', () => {
  const ZIP = 'cool_tool_1790500000000_abcde'

  it('does not let lone backticks around a multi-line tag pair up over it in the second scan', () => {
    const content = '`\n<terminal>ls\n```\nout</terminal>\nthen `x'
    const segments = parseMessageContent(content, 'assistant')

    expect(segments.some((segment) => segment.type === 'terminal')).toBe(true)
  })

  it('draws a TRUSTED compiled Error zip that holds a zip reference as its Error card', () => {
    const errorZip = 'error_1790500000000_abcde'
    const content = `<error data-zip-id="${errorZip}" data-zip-type="error">It broke {{batshit-zip:${ZIP}:::Tool execution: read}} here.</error>`
    const segments = parseMessageContent(content, 'assistant', undefined, undefined, new Set([ZIP, errorZip]))

    expect(segments.map((segment) => segment.type)).toEqual(['error'])
  })

  it('keeps the span check for a compiled-looking Error opening whose id is not trusted', () => {
    const content = `<error data-zip-id="error_1790500000009_fake1" data-zip-type="error">It broke {{batshit-zip:${ZIP}:::Tool execution: read}} here.</error>`
    for (const trusted of [new Set([ZIP]), undefined]) {
      const segments = parseMessageContent(content, 'assistant', undefined, undefined, trusted)
      expect(segments.some((segment) => segment.type === 'error')).toBe(false)
      expect(segments.find((segment) => segment.type === 'cool_tool')?.zipId).toBe(ZIP)
    }
  })

  it('keeps the span check for a trusted id whose zip type is not error', () => {
    const otherZip = 'terminal_1790500000000_abcde'
    const content = `<error data-zip-id="${otherZip}" data-zip-type="terminal">x {{batshit-zip:${ZIP}:::read}} y</error>`
    const segments = parseMessageContent(content, 'assistant', undefined, undefined, new Set([ZIP, otherZip]))
    expect(segments.some((segment) => segment.type === 'error')).toBe(false)
  })

  it('reads only the server form of an Error block: an exact <error> and an exact </error>', () => {
    for (const content of ['A <error/> mention.', 'A <error class="x">b</error> mention.', 'A <error>b</error > mention.']) {
      const segments = parseMessageContent(content, 'assistant')
      expect(segments.some((segment) => segment.type === 'error')).toBe(false)
    }
    expect(parseMessageContent('<ERROR>b</ERROR>', 'assistant').map((segment) => segment.type)).toEqual(['error'])
  })

  it('never lets an unfinished opening tag reach into a zip reference', () => {
    const content = `Use <img src=x then {{batshit-zip:${ZIP}:::read a > b}} done.`
    const segments = parseMessageContent(content, 'assistant', undefined, undefined, new Set([ZIP]))

    expect(segments.some((segment) => segment.type === 'image')).toBe(false)
    expect(segments.find((segment) => segment.type === 'cool_tool')?.zipId).toBe(ZIP)
  })

  it('searches for a closing tag once per stretch of text, however many openings share it', () => {
    const content = `${'<error>x '.repeat(60000)}{{batshit-zip:${ZIP}:::read}} </error>`
    const started = performance.now()
    const segments = parseMessageContent(content, 'assistant', undefined, undefined, new Set([ZIP]))
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(1500)
    expect(segments.some((segment) => segment.type === 'error')).toBe(false)
  })
})

// BL-693: both public parser paths are used by structured transcript export.
describe('messageFormatter unfinished reference scans', () => {
  it.each(['zip', 'clip'] as const)('preserves unfinished %s text promptly in the fallback path', (kind) => {
    const content = `{{batshit-${kind}:unfinished:::body`.repeat(16000)
    const start = performance.now()
    const segments = parseMessageContent(content, 'user')
    const elapsed = performance.now() - start
    console.info(`BL-693 formatter ${kind}: ${content.length} bytes, ${elapsed.toFixed(1)} ms`)
    expect(segments).toEqual([{ type: 'text', content }])
    expect(elapsed).toBeLessThan(1000)
  })

  it('preserves unfinished zip text beside a structured tag promptly', () => {
    const unfinished = '{{batshit-zip:unfinished:::body'.repeat(16000)
    const start = performance.now()
    const segments = parseMessageContent(`<terminal>done</terminal>${unfinished}`, 'assistant')
    const elapsed = performance.now() - start
    console.info(`BL-693 formatter structured zip: ${unfinished.length} bytes, ${elapsed.toFixed(1)} ms`)
    expect(segments.map((segment) => [segment.type, segment.content])).toEqual([
      ['terminal', 'done'], ['text', unfinished]
    ])
    expect(elapsed).toBeLessThan(1000)
  })
})
