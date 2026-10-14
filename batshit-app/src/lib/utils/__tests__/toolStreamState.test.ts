import { describe, it, expect } from 'vitest'
import {
  buildToolStreamStateFromContent,
  buildToolStreamStateFromEvents,
  injectZipReferencesIntoReplayEvents,
  composeToolStreamContent,
  composeToolStreamContentFromEvents,
  resetToolStreamStateFromContent
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

  // BL-759: a managed lane took a segment of the reply back; the server sends the reply's text as
  // it now reads (`content_reset`). The tab rebuilds its live text from it and keeps its tool cards:
  // a finished card from its reference in the text, a card still running (a position only) where
  // it was, and a card the tab drew with no reference of the server's (a missing zip) too.
  describe('resetToolStreamStateFromContent (BL-759)', () => {
    const card = '{{batshit-zip:cool_tool_1:::tool execution}}'

    it('rebuilds the text and the finished cards from the server’s content', () => {
      let order = 0
      const previous = buildToolStreamStateFromContent(`Intro.\n\n${card}\n\nHalf a sen`, () => order++)
      const next = resetToolStreamStateFromContent(previous, `Intro.\n\n${card}\n\n`, () => order++)
      expect(composeToolStreamContent(next)).toBe(`Intro.\n\n${card}\n\n`)
      next.textBuffer += 'The answer.'
      expect(composeToolStreamContent(next)).toBe(`Intro.\n\n${card}\n\nThe answer.`)
    })

    it('keeps a card still running where it was, before the text that follows', () => {
      let order = 0
      const previous = buildToolStreamStateFromContent('Intro. Half a sen', () => order++)
      previous.toolPositions.set('call-1', { pos: 'Intro. '.length, order: 5 })
      const next = resetToolStreamStateFromContent(previous, 'Intro. ', () => order++)
      expect(next.textBuffer).toBe('Intro. ')
      expect(next.toolPositions.get('call-1')).toEqual({ pos: 'Intro. '.length, order: 5 })
    })

    it('never places a running card past the end of the text it now has', () => {
      let order = 0
      const previous = buildToolStreamStateFromContent('Intro. Half a sen', () => order++)
      previous.toolPositions.set('call-1', { pos: 'Intro. Half'.length, order: order++ })
      const next = resetToolStreamStateFromContent(previous, 'Intro. ', () => order++)
      expect(next.toolPositions.get('call-1')?.pos).toBe('Intro. '.length)
    })

    it('keeps a card the tab drew that the server’s text does not name', () => {
      let order = 0
      const missing = '{{batshit-zip:cool_tool_missing_call-2:::Tool execution: bash}}'
      const previous = buildToolStreamStateFromContent(`Intro.\n\n${missing}\n\nHalf`, () => order++)
      const next = resetToolStreamStateFromContent(previous, 'Intro.\n\n', () => order++)
      expect(composeToolStreamContent(next)).toBe(`Intro.\n\n${missing}`)
    })
  })
})
