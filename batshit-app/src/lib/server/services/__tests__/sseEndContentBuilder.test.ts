import { describe, expect, it } from 'vitest'
import { buildEndStreamingContent } from '$lib/server/services/sseEndContentBuilder'

describe('sseEndContentBuilder', () => {
  it('keeps Mode 1 style refs appended when inline replay is disabled', () => {
    const result = buildEndStreamingContent({
      streamEvents: [
        { type: 'chunk', content: 'Hello from n8n.' },
        { type: 'tool_start', toolCallId: 'call_1', order: 1 }
      ],
      inlineCapable: false,
      toolZipRefs: [{ reference: '{{batshit-zip:cool_tool_1:::Tool execution: read_file}}' }],
      allZipRefs: [{ reference: '{{batshit-zip:cool_tool_1:::Tool execution: read_file}}' }]
    })

    expect(result.content).toBe(
      'Hello from n8n.\n\n{{batshit-zip:cool_tool_1:::Tool execution: read_file}}'
    )
  })

  it('keeps Mode 2 enhanced tools inline when only the end-stage cool_tool zip is available', () => {
    const result = buildEndStreamingContent({
      streamEvents: [
        { type: 'chunk', content: 'Before tool.' },
        { type: 'tool_start', toolCallId: 'call_1', order: 1 },
        { type: 'tool_end', toolCallId: 'call_1', order: 1 },
        { type: 'chunk', content: ' After tool.' }
      ],
      inlineCapable: true,
      toolZipRefs: [{ reference: '{{batshit-zip:cool_tool_1:::Tool execution: read_file}}' }],
      allZipRefs: [{ reference: '{{batshit-zip:cool_tool_1:::Tool execution: read_file}}' }]
    })

    expect(result.content.indexOf('Before tool.')).toBeLessThan(
      result.content.indexOf('cool_tool_1')
    )
    expect(result.content.indexOf('cool_tool_1')).toBeLessThan(
      result.content.indexOf('After tool.')
    )
  })

  it('keeps Modes 3/4 tool refs inline and appends only non-inline refs', () => {
    const result = buildEndStreamingContent({
      streamEvents: [
        { type: 'chunk', content: 'Intro.' },
        { type: 'tool-call', toolCallId: 'call_1', order: 1 },
        { type: 'tool-result', toolCallId: 'call_1', order: 1 },
        { type: 'chunk', content: ' Outro.' }
      ],
      inlineCapable: true,
      toolZipRefs: [{ reference: '{{batshit-zip:cool_tool_1:::Tool execution: read_file}}' }],
      allZipRefs: [
        { reference: '{{batshit-zip:cool_tool_1:::Tool execution: read_file}}' },
        { reference: '{{batshit-zip:image_1:::Image}}' }
      ]
    })

    expect(result.content.indexOf('Intro.')).toBeLessThan(result.content.indexOf('cool_tool_1'))
    expect(result.content.indexOf('cool_tool_1')).toBeLessThan(result.content.indexOf('Outro.'))
    expect(result.content.trim().endsWith('{{batshit-zip:image_1:::Image}}')).toBe(true)
  })
})
