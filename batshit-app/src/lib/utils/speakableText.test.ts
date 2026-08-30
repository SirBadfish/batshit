import { describe, expect, it } from 'vitest'
import { extractSpeakableText } from './speakableText'

describe('extractSpeakableText', () => {
  it('removes control tags and unsupported XML blocks entirely', () => {
    const result = extractSpeakableText(
      'Hello <emotion>sad</emotion> there <batshit-group>{"mode":"responding"}</batshit-group> <batshit-cue>{"goon_mood":"joy"}</batshit-cue> <thinking>hidden</thinking> <mute>silent</mute>'
    )

    expect(result).toBe('Hello there')
  })

  it('preserves readable text from standard HTML formatting tags', () => {
    const result = extractSpeakableText(
      'Hello <strong>world</strong> and <em>friends</em>'
    )

    expect(result).toBe('Hello world and friends')
  })

  it('removes unsupported self-closing XML tags', () => {
    const result = extractSpeakableText('Keep this <voice-break level="low"/> text')

    expect(result).toBe('Keep this text')
  })

  it('removes emote tags without speaking cue names', () => {
    const result = extractSpeakableText(
      '<emote name="smile" /> Hello there. <emote name="wink">.</emote> Still talking. <emote-side_eye>.</emote-side_eye> Done.'
    )

    expect(result).toBe('Hello there. Still talking. Done.')
  })

  it('preserves bracket-style expressive hints', () => {
    const result = extractSpeakableText('Say [sad] hello')

    expect(result).toBe('Say [sad] hello')
  })

  it('preserves adjacent bracket TTS cues instead of collapsing them into spoken words', () => {
    // Fish Audio S2 and Inworld combine cues with no separator. The pair looks like a
    // Markdown reference link, so it previously became the literal word "sad".
    expect(extractSpeakableText('[sad][whispering] I miss you so much.')).toBe(
      '[sad][whispering] I miss you so much.'
    )
    expect(extractSpeakableText('[excited][laughing] We won! Ha ha!')).toBe(
      '[excited][laughing] We won! Ha ha!'
    )
    expect(extractSpeakableText('[soft tone][slightly breathless] hey you')).toBe(
      '[soft tone][slightly breathless] hey you'
    )
  })

  it('preserves space-separated and triple-stacked bracket TTS cues', () => {
    expect(extractSpeakableText('[sad] [whispering] I miss you so much.')).toBe(
      '[sad] [whispering] I miss you so much.'
    )
    expect(extractSpeakableText('[hopeful][soft tone][breathless] Maybe.')).toBe(
      '[hopeful][soft tone][breathless] Maybe.'
    )
  })

  it('still collapses Markdown reference links whose label is defined', () => {
    const full = extractSpeakableText('See the [setup guide][docs] for details.\n[docs]: https://example.com')
    expect(full).toBe('See the setup guide for details.')

    const collapsed = extractSpeakableText('See the [docs][] for details.\n[docs]: https://example.com')
    expect(collapsed).toBe('See the docs for details.')
  })

  it('leaves undefined reference-style brackets intact rather than speaking the label', () => {
    const result = extractSpeakableText('Read the [manual][missing] later.')

    expect(result).toBe('Read the [manual][missing] later.')
  })

  it('preserves line separation for br/hr tags', () => {
    const result = extractSpeakableText('Line 1<br/>Line 2<hr>Line 3')

    expect(result).toBe('Line 1\nLine 2\nLine 3')
  })

  it('strips group controls and presentation cues while preserving spoken text', () => {
    const result = extractSpeakableText(
      '<batshit-group>{"mode":"responding"}</batshit-group>\n' +
        '<batshit-cue>{"goon_mood":"joy"}</batshit-cue>\n' +
        '*goon: wave*\n' +
        'Hey team, here is the update.\n' +
        '<emotion level=\"high\">excited</emotion>\n' +
        '<batshit-cue>{"another":"block"}</batshit-cue>'
    )

    expect(result).toBe('Hey team, here is the update.')
  })

  it('removes control tags with attributes', () => {
    const result = extractSpeakableText(
      '<batshit-group data-mode="group">{"mode":"responding"}</batshit-group> Hello there'
    )

    expect(result).toBe('Hello there')
  })

  it('strips zip/tool payload markers while keeping the normal reply text speakable', () => {
    const result = extractSpeakableText(
      'Here is the answer you asked for.\n\n{{batshit-zip:cool_tool_1:::Tool execution: read_file}}\n\nAnd here is the short summary.'
    )

    expect(result).toBe('Here is the answer you asked for.\n\nAnd here is the short summary.')
  })

  it('removes Tool Results Summary sections from speech output', () => {
    const result = extractSpeakableText(
      [
        'Here is the actual answer.',
        '',
        'Tool Results Summary',
        '- Bash: listed the files.',
        '- Read File: opened the note.',
        '',
        'One more spoken sentence.'
      ].join('\n')
    )

    expect(result).toBe('Here is the actual answer.\n\nOne more spoken sentence.')
  })

  it('removes same-line Tool Results Summary text from speech output', () => {
    const result = extractSpeakableText(
      'Here is the actual answer.\n\nTool Results Summary voice_test: This note is not speech.'
    )

    expect(result).toBe('Here is the actual answer.')
  })

  it('removes complete and partial zip-control payloads from speech output', () => {
    const complete = extractSpeakableText(
      'Speak this. <batshit-zip-control>{"toolResultsSummary":[{"summary":"do not speak"}]}</batshit-zip-control>'
    )
    const partial = extractSpeakableText(
      'Speak this too. <batshit-zip-control>{"toolResultsSummary":[{"summary":"do not speak yet"}]'
    )

    expect(complete).toBe('Speak this.')
    expect(partial).toBe('Speak this too.')
  })

  it('removes partial group and cue control payloads from speech output', () => {
    const group = extractSpeakableText('Speak this. <batshit-group>{"mode":"listening"')
    const cue = extractSpeakableText('Speak this too. <batshit-cue>{"goon_mood":"joy"')

    expect(group).toBe('Speak this.')
    expect(cue).toBe('Speak this too.')
  })

  it('removes emoji combo joiners without stripping normal plus signs', () => {
    const result = extractSpeakableText('Use C++ for code, 2+2 for math, and 🙄+🤨 for emotes.')

    expect(result).toBe('Use C++ for code, 2+2 for math, and for emotes.')
  })

  it('removes repeated emoji combo joiners in chained emoji emotes', () => {
    const result = extractSpeakableText('Mood chain: 😏+🙄+🤨 done.')

    expect(result).toBe('Mood chain: done.')
  })

  it('strips common markdown formatting markers without dropping the spoken words', () => {
    const result = extractSpeakableText(
      [
        '# Voice Test',
        'This is **bold**, *italic*, __strong__, and _soft_.',
        '- First bullet',
        '- [x] Checked item',
        '1. Numbered item with [a link](https://example.com).',
        '> Quoted words.',
        'Use `npm run check` when done.',
        '```ts',
        'console.log("do not read raw code")',
        '```'
      ].join('\n')
    )

    expect(result).toBe(
      [
        'Voice Test',
        'This is bold, italic, strong, and soft.',
        'First bullet',
        'Checked item',
        'Numbered item with a link.',
        'Quoted words.',
        'Use npm run check when done.'
      ].join('\n')
    )
  })

  it('can silence italic narration while keeping the visible reply speakable', () => {
    const result = extractSpeakableText(
      [
        '*She looks away.* Hello **Josh**.',
        '<em>Quiet aside.</em> Keep this line.',
        '<i>Another aside.</i> Done.'
      ].join('\n'),
      { italicBehavior: 'silent' }
    )

    expect(result).toBe(['Hello Josh.', 'Keep this line.', 'Done.'].join('\n'))
  })

  it('keeps ordinary underscores speakable when italic narration is silent', () => {
    const result = extractSpeakableText(
      'Open file_name_here.ts, then skip _quiet narration_ before speaking.',
      { italicBehavior: 'silent' }
    )

    expect(result).toBe('Open file_name_here.ts, then skip before speaking.')
  })
})

describe('extractSpeakableText control-tag registry coverage (SA-104 P1)', () => {
  it('never speaks tool-notes blocks, closed or unclosed', () => {
    expect(
      extractSpeakableText(
        'Done. <batshit-tool-notes>{"notes":[{"summary":"secret fact"}]}</batshit-tool-notes>'
      )
    ).toBe('Done.')

    expect(
      extractSpeakableText('Done. <batshit-tool-notes>{"notes":[{"summary":"cut off')
    ).toBe('Done.')
  })

  it('never speaks any registered control tag in unclosed trailing form', () => {
    expect(extractSpeakableText('Okay. <batshit-zip-control>{"unzip":["z1"')).toBe('Okay.')
    expect(extractSpeakableText('Okay. <batshit-cue>{"goon_mood":"hap')).toBe('Okay.')
    expect(extractSpeakableText('Okay. <batshit-group>{"mode":"listen')).toBe('Okay.')
  })

  it('never speaks memory save blocks, closed or unclosed (SA-104 P3 tag)', () => {
    expect(
      extractSpeakableText(
        'Noted. <batshit-memory>{"lane":"ltm","content":"private-sounding fact"}</batshit-memory>'
      )
    ).toBe('Noted.')
    expect(extractSpeakableText('Noted. <batshit-memory>{"lane":"stm","content":"cut off')).toBe(
      'Noted.'
    )
  })

  it('strips control tags appearing mid-message, keeping surrounding speech', () => {
    expect(
      extractSpeakableText(
        'First part. <batshit-cue>{"goon_mood":"excited"}</batshit-cue> Second part.'
      )
    ).toBe('First part. Second part.')
  })
})
