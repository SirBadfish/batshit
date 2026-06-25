import { describe, it, expect } from 'vitest'
import { parseMessageContent } from './messageFormatter'

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
