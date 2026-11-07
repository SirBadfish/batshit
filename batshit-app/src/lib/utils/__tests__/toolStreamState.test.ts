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

    // BL-946: the tab's live text has no line breaks around its cards (they are added when the
    // text is drawn); the server's text has them. A kept card's place was measured in the tab's
    // text, so it landed 2 to 4 characters early for each card before it, in the middle of a word.
    describe('a kept card after a card the text names (BL-946)', () => {
      const missing = '{{batshit-zip:cool_tool_missing_call-2:::Tool execution: bash}}'

      // The tab's state as the page builds it while streaming: chunks, then cards by position.
      function liveState() {
        let order = 0
        const state = {
          textBuffer: 'Intro. Then more.Half a sen',
          insertions: [
            { pos: 'Intro.'.length, ref: card, order: order++ },
            { pos: 'Intro. Then more.'.length, ref: missing, order: order++ }
          ],
          toolPositions: new Map<string, { pos: number; order: number }>()
        }
        return { state, nextOrder: () => order++ }
      }
      const serverText = `Intro.\n\n${card}\n\n Then more.`

      it('stays after the words it followed, not in the middle of one', () => {
        const { state, nextOrder } = liveState()
        const next = resetToolStreamStateFromContent(state, serverText, nextOrder)
        expect(composeToolStreamContent(next)).toBe(`Intro.\n\n${card}\n\n Then more.\n\n${missing}`)
      })

      it('a running card keeps its place after the card the text names', () => {
        const { state, nextOrder } = liveState()
        state.insertions.pop()
        state.toolPositions.set('call-3', { pos: 'Intro. Then'.length, order: 9 })
        const next = resetToolStreamStateFromContent(state, serverText, nextOrder)
        expect(next.textBuffer.slice(0, next.toolPositions.get('call-3')?.pos)).toBe(`Intro.\n\n\n\n Then`)
      })

      it('a running card started right after the named card lands after it, not before it', () => {
        const { state, nextOrder } = liveState()
        state.insertions.pop()
        state.toolPositions.set('call-3', { pos: 'Intro.'.length, order: 9 })
        const next = resetToolStreamStateFromContent(state, serverText, nextOrder)
        // Its result is inserted at this place with the newest order, so after the named card.
        next.insertions.push({ pos: next.toolPositions.get('call-3')?.pos ?? -1, ref: missing, order: nextOrder() })
        expect(composeToolStreamContent(next)).toBe(`Intro.\n\n${card}\n\n${missing}\n\n Then more.`)
      })

      it('two cards at one place keep their order, either way round', () => {
        // Kept card drawn after the named one, at the same point of the text.
        let order = 0
        const after = {
          textBuffer: 'Intro.Next words.',
          insertions: [
            { pos: 6, ref: card, order: order++ },
            { pos: 6, ref: missing, order: order++ }
          ],
          toolPositions: new Map<string, { pos: number; order: number }>()
        }
        const text = `Intro.\n\n${card}\n\nNext words.`
        expect(composeToolStreamContent(resetToolStreamStateFromContent(after, text, () => order++))).toBe(
          `Intro.\n\n${card}\n\n${missing}\n\nNext words.`
        )
        // Kept card drawn before it.
        const before = { ...after, insertions: [after.insertions[1], after.insertions[0]].map((entry, index) => ({ ...entry, order: index })) }
        expect(composeToolStreamContent(resetToolStreamStateFromContent(before, text, () => order++))).toBe(
          `Intro.\n\n${missing}\n\n${card}\n\nNext words.`
        )
      })

      it('a card the text names last, then a kept one at the very end', () => {
        let order = 0
        const state = {
          textBuffer: 'Intro.',
          insertions: [
            { pos: 6, ref: card, order: order++ },
            { pos: 6, ref: missing, order: order++ }
          ],
          toolPositions: new Map<string, { pos: number; order: number }>()
        }
        expect(composeToolStreamContent(resetToolStreamStateFromContent(state, `Intro.\n\n${card}`, () => order++))).toBe(
          `Intro.\n\n${card}\n\n${missing}`
        )
      })
    })
  })
})
