import { describe, expect, it } from 'vitest'
import { SegmentedText } from '$lib/utils/segmentedText'

/**
 * BL-759: a reader that keeps a reply's text takes a segment back by its name, never by a count
 * of characters and never by a search for its words.
 */
describe('SegmentedText', () => {
  it('removes one segment and nothing else, and keeps text with no segment', () => {
    const text = new SegmentedText()
    text.append('Intro. ')
    text.append('Partial ', 'msg_1')
    text.append('before the drop ', 'msg_1')
    text.append('Hello after the retry.', 'msg_2')

    expect(text.retract('msg_1')).toBe('Partial before the drop ')
    expect(text.toString()).toBe('Intro. Hello after the retry.')
    expect(text.length).toBe('Intro. Hello after the retry.'.length)
    expect(text.hasSegment('msg_1')).toBe(false)
    expect(text.hasSegment('msg_2')).toBe(true)
  })

  it('removes a segment by name even when its words also appear elsewhere', () => {
    const text = new SegmentedText()
    text.append('Hello ', 'msg_1')
    text.append('Hello world.', 'msg_2')

    expect(text.retract('msg_1')).toBe('Hello ')
    expect(text.toString()).toBe('Hello world.')
  })

  it('takes back every piece of a segment that other text split, and joins what is left', () => {
    const text = new SegmentedText()
    text.append('A1 ', 'a')
    text.append('B1 ', 'b')
    text.append('A2 ', 'a')
    text.append('B2', 'b')

    expect(text.retract('b')).toBe('B1 B2')
    expect(text.toString()).toBe('A1 A2 ')
    text.append('A3', 'a')
    expect(text.retract('a')).toBe('A1 A2 A3')
    expect(text.toString()).toBe('')
  })

  it('answers empty for a segment it never held, and never removes text with no segment', () => {
    const text = new SegmentedText()
    text.append('Kept.')
    expect(text.retract('msg_9')).toBe('')
    expect(text.retract('')).toBe('')
    expect(text.toString()).toBe('Kept.')
  })

  // BL-759: the group chat's control buffer hands on what follows its leading control block, which
  // is always the END of what it buffered; each piece keeps the segment it came from.
  it('answers the pieces of a suffix with their segments, or null when the text does not end with it', () => {
    const text = new SegmentedText()
    text.append('<batshit-group>{}</batshit-group>Hel', 'msg_1')
    text.append('lo', 'msg_2')
    expect(text.piecesOfSuffix('Hello')).toEqual([
      { segmentId: 'msg_1', text: 'Hel' },
      { segmentId: 'msg_2', text: 'lo' }
    ])
    expect(text.piecesOfSuffix('')).toEqual([])
    expect(text.piecesOfSuffix('Bye')).toBeNull()
    const whole = text.piecesOfSuffix(text.toString())
    expect(whole?.map((piece) => piece.text).join('')).toBe(text.toString())
  })
})
