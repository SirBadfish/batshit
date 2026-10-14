import { describe, expect, it } from 'vitest'
import {
  buildStopFallbackContent,
  shouldAcceptLateEndAfterStopFallback,
  stripUnfinalizedReplyControl
} from './replyEndSave'

describe('buildStopFallbackContent (BL-361 a)', () => {
  it('strips the reply control blocks from the streamed text before the fallback save', () => {
    const streamed =
      'Here is the answer.\n\n<batshit-zip-control>{"zip":["zip_1"]}</batshit-zip-control>\n' +
      '<batshit-tool-notes>{"notes":[{"toolName":"read","summary":"x"}]}</batshit-tool-notes>'
    const content = buildStopFallbackContent(streamed)
    expect(content).toBe('Here is the answer.')
    expect(content).not.toContain('batshit-zip-control')
    expect(content).not.toContain('batshit-tool-notes')
  })

  it('strips a memory block too', () => {
    const content = buildStopFallbackContent(
      'Noted.\n<batshit-memory>{"content":"Josh likes tea"}</batshit-memory>'
    )
    expect(content).not.toContain('batshit-memory')
    expect(content).toContain('Noted.')
  })

  it('cuts a control block the Stop left unclosed (notes come last, so this is the likely case)', () => {
    expect(
      buildStopFallbackContent('The answer.\n\n<batshit-tool-notes>{"notes":[{"toolName":"read","sum')
    ).toBe('The answer.')
    expect(buildStopFallbackContent('The answer.\n<batshit-zip-control>{"zip":["zi')).toBe('The answer.')
    expect(buildStopFallbackContent('The answer.\n<batshit-memory>{"content":"Jo')).toBe('The answer.')
    // A complete block before the unclosed one goes too, and the words between stay.
    expect(
      buildStopFallbackContent(
        'One.\n<batshit-memory>{"content":"x"}</batshit-memory>\nTwo.\n<batshit-tool-notes>{"no'
      )
    ).toBe('One.\n\nTwo.')
  })

  it('keeps a short start that never became a tag and hides a cut tag, as the server does (BL-442 R4, BL-577)', () => {
    // Only `<`, or letters that do not yet spell `<batshit-`: text.
    expect(buildStopFallbackContent('If x is less than y, write x <')).toBe('If x is less than y, write x <')
    expect(buildStopFallbackContent('The answer is <bat')).toBe('The answer is <bat')
    // `<batshit-` in full: the start of a cut block, hidden (a stopped reply never ends with part
    // of a tag's name).
    expect(buildStopFallbackContent('The answer.\n<batshit-tool-no')).toBe('The answer.')
    expect(buildStopFallbackContent('The answer.\n<batshit-')).toBe('The answer.')
    // A complete opening tag with nothing after it is not a bare cut start: text (R4 strict).
    expect(buildStopFallbackContent('The answer.\n<batshit-memory>\n')).toBe('The answer.\n<batshit-memory>')
    expect(buildStopFallbackContent('The answer.\n<batshit-cu')).toBe('The answer.')
  })

  it('keeps every word of the three review inputs and hides a bare cut start (R4 strict)', () => {
    const inputs = [
      "The memory prompt says so.\nWrap it in a <batshit-memory tag and it's saved.",
      'Use <batshit-memory with a "content" key.',
      'Write <batshit-memory then an object, e.g. f = () => {"content":"x"} and it works.\nMore text after.'
    ]
    for (const input of inputs) expect(buildStopFallbackContent(input)).toBe(input)
    for (const tail of ['<batshit-', '<batshit-mem', '<batshit-memory ']) {
      expect(buildStopFallbackContent(`The answer. ${tail}`)).toBe('The answer.')
    }
  })

  it('keeps the four bug cases and removes only the correct block (BL-442 contract)', () => {
    const words = [
      'Here is how:',
      '```',
      '<batshit-memory>{"lane":"ltm","content":"example"}</batshit-memory>',
      '```',
      'I write a <batshit-memory> block to save it. If x < 5 it waits.'
    ].join('\n')
    expect(
      buildStopFallbackContent(`${words}\n<batshit-memory>{"lane":"ltm","content":"Josh likes tea"}</batshit-memory>\nThe end <`)
    ).toBe(`${words}\n\nThe end <`)
  })

  it('keeps an example in code and a tag named in a sentence (BL-442, BL-473)', () => {
    const example = 'Like this:\n```\n<batshit-memory>{"lane":"ltm","content":"x"}</batshit-memory>\n```'
    expect(buildStopFallbackContent(example)).toBe(example)
    const mention = 'I write a <batshit-memory> block to save it, and more words after.'
    expect(buildStopFallbackContent(mention)).toBe(mention)
  })

  it('leaves an ordinary angle bracket alone', () => {
    expect(buildStopFallbackContent('a < b and <div>x</div>')).toBe('a < b and <div>x</div>')
  })

  it('says the response stopped when nothing but control blocks (or nothing) streamed', () => {
    expect(buildStopFallbackContent('<batshit-zip-control>{"zip":[]}</batshit-zip-control>')).toBe(
      'Response stopped.'
    )
    expect(buildStopFallbackContent('   ')).toBe('Response stopped.')
    expect(buildStopFallbackContent(undefined)).toBe('Response stopped.')
  })
})

describe('shouldAcceptLateEndAfterStopFallback (BL-361 b)', () => {
  it('lets through a late end with replyControlFinalized for a message this tab saved as stopped', () => {
    expect(
      shouldAcceptLateEndAfterStopFallback({
        savedByStopFallback: true,
        isFinalized: true,
        endMetadata: { replyControlFinalized: true, interrupted: true }
      })
    ).toBe(true)
  })

  it('still ignores a late end without the flag', () => {
    expect(
      shouldAcceptLateEndAfterStopFallback({ savedByStopFallback: true, isFinalized: true, endMetadata: { interrupted: true } })
    ).toBe(false)
    expect(
      shouldAcceptLateEndAfterStopFallback({
        savedByStopFallback: true,
        isFinalized: true,
        endMetadata: { replyControlFinalized: 'true' }
      })
    ).toBe(false)
    expect(shouldAcceptLateEndAfterStopFallback({ savedByStopFallback: true, isFinalized: true, endMetadata: undefined })).toBe(
      false
    )
  })

  it('ignores the end of a message that is no longer finalized (reopened by an approval resume)', () => {
    expect(
      shouldAcceptLateEndAfterStopFallback({
        savedByStopFallback: true,
        isFinalized: false,
        endMetadata: { replyControlFinalized: true }
      })
    ).toBe(false)
  })

  it('still ignores a late end for a message finalized any other way', () => {
    expect(
      shouldAcceptLateEndAfterStopFallback({
        savedByStopFallback: false,
        isFinalized: true,
        endMetadata: { replyControlFinalized: true }
      })
    ).toBe(false)
  })
})

describe('stripUnfinalizedReplyControl (the complete copy, no end reached the tab)', () => {
  it('strips complete and unclosed control blocks, with no placeholder', () => {
    expect(
      stripUnfinalizedReplyControl('Done.\n<batshit-zip-control>{"zip":[]}</batshit-zip-control>\n<batshit-tool-notes>{')
    ).toBe('Done.')
    expect(stripUnfinalizedReplyControl('<batshit-tool-notes>{')).toBe('')
    expect(stripUnfinalizedReplyControl(undefined)).toBe('')
  })
})
