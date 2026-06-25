import { describe, it, expect } from 'vitest'
import {
  buildToolStreamStateFromContent,
  buildToolStreamStateFromEvents,
  injectZipReferencesIntoReplayEvents,
  composeToolStreamContent,
  composeToolStreamContentFromEvents
} from '$lib/utils/toolStreamState'

describe('toolStreamState helpers', () => {
  it('extracts tool zip references and preserves order', () => {
    let order = 0
    const state = buildToolStreamStateFromContent(
      'Hello {{batshit-zip:cool_tool_1:::tool execution}} world {{batshit-zip:cool_tool_2:::tool execution}} done',
      () => order++
    )

    expect(state.insertions).toHaveLength(2)
    expect(state.insertions[0].order).toBe(0)
    expect(state.insertions[1].order).toBe(1)

    const output = composeToolStreamContent(state)
    expect(output.indexOf('cool_tool_1')).toBeLessThan(output.indexOf('cool_tool_2'))
    expect(output).toContain('Hello')
    expect(output).toContain('done')
  })

  it('leaves non-tool zip refs inside text buffer', () => {
    let order = 0
    const content = 'Here is an image {{batshit-zip:image_1:::image}} done'
    const state = buildToolStreamStateFromContent(content, () => order++)

    expect(state.insertions).toHaveLength(0)
    expect(composeToolStreamContent(state)).toBe(content)
  })

  it('keeps parallel states independent', () => {
    let orderA = 0
    let orderB = 0

    const stateA = buildToolStreamStateFromContent(
      'A {{batshit-zip:cool_tool_a:::tool execution}}',
      () => orderA++
    )
    const stateB = buildToolStreamStateFromContent(
      'B {{batshit-zip:cool_tool_b:::tool execution}}',
      () => orderB++
    )

    expect(stateA.insertions[0].order).toBe(0)
    expect(stateB.insertions[0].order).toBe(0)
    expect(composeToolStreamContent(stateA)).toContain('cool_tool_a')
    expect(composeToolStreamContent(stateB)).toContain('cool_tool_b')
  })

  it('replays streamed tool events into inline order', () => {
    const output = composeToolStreamContentFromEvents([
      { type: 'chunk', content: 'Before tool.' },
      { type: 'tool-call', toolCallId: 'call_1', order: 1 },
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        order: 1,
        zipReferences: [{ reference: '{{batshit-zip:cool_tool_1:::Tool execution: read_file}}' }]
      },
      { type: 'chunk', content: ' After tool.' }
    ])

    expect(output).toContain('Before tool.')
    expect(output).toContain('After tool.')
    expect(output.indexOf('Before tool.')).toBeLessThan(output.indexOf('cool_tool_1'))
    expect(output.indexOf('cool_tool_1')).toBeLessThan(output.indexOf('After tool.'))
  })

  it('keeps multiple tool results stable when they share the same insertion point', () => {
    const state = buildToolStreamStateFromEvents([
      { type: 'tool-call', toolCallId: 'call_1', order: 1 },
      { type: 'tool-call', toolCallId: 'call_2', order: 2 },
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        order: 1,
        zipReferences: [{ reference: '{{batshit-zip:cool_tool_1:::Tool execution: first}}' }]
      },
      {
        type: 'tool-result',
        toolCallId: 'call_2',
        order: 2,
        zipReferences: [{ reference: '{{batshit-zip:cool_tool_2:::Tool execution: second}}' }]
      },
      { type: 'chunk', content: 'Done.' }
    ])

    const output = composeToolStreamContent(state)
    expect(output.indexOf('cool_tool_1')).toBeLessThan(output.indexOf('cool_tool_2'))
    expect(output).toContain('Done.')
  })

  it('injects missing zip refs into existing tool-result events', () => {
    const replay = injectZipReferencesIntoReplayEvents(
      [
        { type: 'chunk', content: 'Before.' },
        { type: 'tool-call', toolCallId: 'call_1', order: 1 },
        { type: 'tool-result', toolCallId: 'call_1', order: 1 },
        { type: 'chunk', content: ' After.' }
      ],
      [{ zipId: 'cool_tool_1', reference: '{{batshit-zip:cool_tool_1:::Tool execution: injected}}' }]
    )

    const output = composeToolStreamContentFromEvents(replay)
    expect(output.indexOf('Before.')).toBeLessThan(output.indexOf('cool_tool_1'))
    expect(output.indexOf('cool_tool_1')).toBeLessThan(output.indexOf('After.'))
    expect(replay[2].zipReferences?.[0]?.zipId).toBe('cool_tool_1')
  })

  it('synthesizes tool-result events from tool-start positions when only starts were streamed', () => {
    const replay = injectZipReferencesIntoReplayEvents(
      [
        { type: 'chunk', content: 'Intro.' },
        { type: 'tool_start', toolCallId: 'call_1', order: 1 },
        { type: 'chunk', content: ' Outro.' }
      ],
      [{ reference: '{{batshit-zip:cool_tool_1:::Tool execution: fallback}}' }]
    )

    const output = composeToolStreamContentFromEvents(replay)
    expect(output.indexOf('Intro.')).toBeLessThan(output.indexOf('cool_tool_1'))
    expect(output.indexOf('cool_tool_1')).toBeLessThan(output.indexOf('Outro.'))
  })
})
