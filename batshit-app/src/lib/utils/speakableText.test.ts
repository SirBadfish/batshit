import { describe, expect, it } from 'vitest'
import { extractSpeakableText, stripLegacySpeechBlocks, stripUnsupportedXmlBlocks } from './speakableText'

describe('speech reference removal preserves its old grammar without repeated tail scans (BL-708 subset)', () => {
  function oldRemoveReferences(text: string): string {
    return text
      .replace(/\{\{batshit-zip:[^}]+\}\}/g, '')
      .replace(/\{\{batshit\|id:[^}]+\}\}/g, '')
  }

  it.each([
    ['A{{batshit-zip:id:::body}}B', 'AB'],
    ['A{{batshit|id:with spaces\nand lines}}B', 'AB'],
    ['A{{batshit-zip:}}B{{batshit|id:}}C', 'A{{batshit-zip:}}B{{batshit|id:}}C'],
    ['A{{batshit-zip:x}y}}B', 'A{{batshit-zip:x}y}}B'],
    ['A{{batshit-zip:outer{{batshit|id:inner}}B}}C', 'AB}}C'],
    ['A{{batshit-zip:x}}}B', 'A}B'],
    ['A{{BATSHIT-ZIP:x}}B{{Batshit|id:y}}C', 'A{{BATSHIT-ZIP:x}}B{{Batshit|id:y}}C'],
    ['A{{bat{{batshit-zip:x}}shit|id:y}}B', 'AB'],
    ['A{{bat{{batshit|id:x}}shit-zip:y}}B', 'A{{batshit-zip:y}}B']
  ])('retains the exact spoken output for %s', (text, expected) => {
    expect(extractSpeakableText(text)).toBe(expected)
  })

  it('matches the former two passes on generated plain malformed and mixed reference text', () => {
    const pieces = ['{{batshit-zip:', '{{batshit|id:', '{{BATSHIT-ZIP:', '{{Batshit|id:', '{{bat', 'shit-zip:', 'shit|id:', '{{', '{', '}', '}}', '}}}', ':', ':::', 'id', 'body']
    let state = 708
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 2 ** 32
    }
    for (let sample = 0; sample < 5_000; sample += 1) {
      let text = 'p'
      const length = Math.floor(random() * 12)
      for (let part = 0; part < length; part += 1) text += pieces[Math.floor(random() * pieces.length)]
      text += 'q'
      expect(extractSpeakableText(text), JSON.stringify(text)).toBe(oldRemoveReferences(text))
    }
  })

  it.each(['{{batshit-zip:', '{{batshit|id:'])('prepares 20,000 unclosed %s references within the existing 2-second scan budget', (opener) => {
    const text = `prefix ${(opener + 'broken:::tail ').repeat(20_000)}suffix`
    const started = performance.now()
    const result = extractSpeakableText(text)
    const elapsed = performance.now() - started
    console.info(JSON.stringify({ speechReferenceFixture: opener, characters: text.length, milliseconds: elapsed }))
    expect(result).toBe(text)
    expect(elapsed).toBeLessThan(2_000)
  })
})

describe('legacy speech blocks preserve their old grammar without repeated tail scans (BL-694)', () => {
  function oldStrip(text: string): string {
    return text
      .replace(/<thinking[\s\S]*?>[\s\S]*?<\/thinking>/gi, '')
      .replace(/<mute[\s\S]*?>[\s\S]*?<\/mute>/gi, '')
      .replace(/<tool[-_ ]?results(?:[-_ ]?summary)?\b[\s\S]*?<\/tool[-_ ]?results(?:[-_ ]?summary)?>/gi, '')
      .replace(/<tool[-_ ]?results(?:[-_ ]?summary)?\b[\s\S]*$/gi, '')
      .replace(/\btoolResultsSummary\b(?=["']?\s*:)[\s\S]*$/i, '')
  }

  it('matches the former strips on malformed, nested, mixed-case and mismatched legacy blocks', () => {
    const pieces = ['<thinking>', '</thinking>', '<THINKING note="x">', '<thinking-extra>', '<thinking', '<mute>', '</MUTE>', '<muteish>', '<tool-results>', '</tool_results>', '<tool results summary>', '</tool-results-summary>', '<toolresults', '<tool-resultsx>', 'toolResultsSummary:', 'toolResultsSummary says hello', '<', '>', 'text', ' ', '\n']
    let state = 694
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 2 ** 32
    }
    for (let sample = 0; sample < 5_000; sample += 1) {
      let text = ''
      const length = Math.floor(random() * 12)
      for (let part = 0; part < length; part += 1) text += pieces[Math.floor(random() * pieces.length)]
      expect(stripLegacySpeechBlocks(text), JSON.stringify(text)).toBe(oldStrip(text))
    }
  })

  it.each(['thinking', 'mute'])('handles 1,500 unclosed %s tags within the existing 2-second scan budget', (tag) => {
    const text = `x <${tag}> y `.repeat(1_500)
    const started = performance.now()
    expect(stripLegacySpeechBlocks(text)).toBe(text)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('retains protected code examples and spoken words around closed legacy blocks', () => {
    expect(extractSpeakableText('Say `<thinking>example</thinking>` aloud. <thinking>hidden</thinking> Then <mute>silent</mute> speak.')).toBe('Say thinkingexamplethinking aloud. Then speak.')
    expect(extractSpeakableText('Before <tool-results>hidden</tool_results> after.')).toBe('Before after.')
  })
})

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

describe('extractSpeakableText: what counts as a control block (BL-442)', () => {
  it('speaks a lone < and >, and a reply that ends in one (R5, BL-477)', () => {
    expect(extractSpeakableText('If the count is < 5, retry the upload.')).toBe('If the count is < 5, retry the upload.')
    expect(extractSpeakableText('x < 5 and y > 3')).toBe('x < 5 and y > 3')
    expect(extractSpeakableText('The last one is <')).toBe('The last one is <')
    expect(extractSpeakableText('Hello <b>bold</b> and <i>more</i>.')).toBe('Hello bold and more.')
  })

  it('never speaks part of a cut tag name, and speaks a short start (R4)', () => {
    expect(extractSpeakableText('The answer was cut <batshit-tool-no')).toBe('The answer was cut')
    expect(extractSpeakableText('The answer ends in <bat')).toBe('The answer ends in <bat')
  })

  it('never speaks a closed block with a bad payload (R2 b)', () => {
    expect(extractSpeakableText('Saved. <batshit-memory>lane ltm, content: secret</batshit-memory> Next.')).toBe('Saved. Next.')
  })

  it('reads code before the Markdown pass removes its backticks (trap 2, BL-618)', () => {
    expect(extractSpeakableText('Put it in a `<script>` tag at the end.')).toBe('Put it in a script tag at the end.')
    expect(extractSpeakableText('Use `a < b` here, then go on.')).toBe('Use a < b here, then go on.')
  })

  it('speaks the rest of a reply that names a tag in a sentence (BL-473)', () => {
    expect(extractSpeakableText('I write a <batshit-memory> block when you ask me to remember something.')).toBe(
      'I write a block when you ask me to remember something.'
    )
    expect(extractSpeakableText('The toolResultsSummary field is gone now, and this is still spoken.')).toBe(
      'The toolResultsSummary field is gone now, and this is still spoken.'
    )
  })

  it('skips an example block as code, speaks what follows, and never speaks a real block', () => {
    const reply = [
      'Here is how I save a memory:',
      '```',
      '<batshit-memory>{"lane":"ltm","content":"example"}</batshit-memory>',
      '```',
      'I write a <batshit-memory> block, and `<batshit-memory>` in code. If x < 5 it waits.',
      '<batshit-memory>{"lane":"ltm","content":"Josh likes tea"}</batshit-memory>',
      'The end <'
    ].join('\n')
    const spoken = extractSpeakableText(reply)
    expect(spoken).toBe(
      'Here is how I save a memory:\n\nI write a block, and batshit-memory in code. If x < 5 it waits.\n\nThe end <'
    )
    expect(spoken).not.toContain('Josh likes tea')
  })
})

describe('stripUnsupportedXmlBlocks: the old regexes, in one pass', () => {
  const SPEAKABLE = new Set(['b', 'em', 'p', 'code', 'strong'])
  function oldStripUnsupportedXmlBlocks(text: string): string {
    const drop = (tagName: string) => !SPEAKABLE.has(tagName.toLowerCase())
    let output = text
    let changed = true
    output = output.replace(/<([a-z][a-z0-9:_-]*)\b[^>]*\/>/gi, (match, tagName) => (drop(tagName) ? '' : match))
    while (changed) {
      changed = false
      output = output.replace(/<([a-z][a-z0-9:_-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, (match, tagName) => {
        if (drop(tagName)) {
          changed = true
          return ''
        }
        return match
      })
    }
    return output.replace(/<([a-z][a-z0-9:_-]*)\b[^>]*\/>/gi, (match, tagName) => (drop(tagName) ? '' : match))
  }

  it('matches them on 5,000 generated texts', () => {
    const pieces = ['<a>', '</a>', '<b>', '</b>', '<ab-c>', '</ab>', '</ab->', '<ab->', '<x:y>', '</x:y>', '<emote/>', '<p/>', '<P>', '</p>', '<em x="1">', '</EM>', '<', '>', '/', '-', ':', 'text', ' ', '\n', '<<a>>', 'z']
    let state = 105
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 2 ** 32
    }
    for (let sample = 0; sample < 5000; sample += 1) {
      let text = ''
      const length = Math.floor(random() * 12)
      for (let part = 0; part < length; part += 1) text += pieces[Math.floor(random() * pieces.length)]
      // The test's own speakable set stands in for the module's: the pairing is what is compared.
      expect(stripUnsupportedXmlBlocks(text, SPEAKABLE), JSON.stringify(text)).toBe(oldStripUnsupportedXmlBlocks(text))
    }
  })

  it('strips a reply of 50,000 unclosed tags in one pass', () => {
    const text = 'x <div class="a"> y '.repeat(50_000)
    const started = performance.now()
    expect(stripUnsupportedXmlBlocks(text)).toBe(text)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe('extractSpeakableText: a backtick inside one block never makes the next block code (BL-442 review)', () => {
  it('never speaks a memory block that follows a Tool Notes block holding a lone backtick', () => {
    const reply =
      'Done.\n<batshit-tool-notes>{"notes":[{"toolName":"bash","summary":"make: No rule to make target `all\'"}]}</batshit-tool-notes>\n' +
      '<batshit-memory>{"lane":"ltm","content":"canary: Josh builds with `make release`"}</batshit-memory>\nThe next step is ready.'
    expect(extractSpeakableText(reply)).toBe('Done.\n\nThe next step is ready.')
  })
})

describe('extractSpeakableText: R4 strict (Faye, 2026-09-27)', () => {
  it('speaks every word of the three review inputs and no part of a bare cut start', () => {
    expect(extractSpeakableText("Wrap it in a <batshit-memory tag and it's saved.")).toBe("Wrap it in a <batshit-memory tag and it's saved.")
    expect(extractSpeakableText('Use <batshit-memory with a "content" key.')).toBe('Use <batshit-memory with a "content" key.')
    expect(
      extractSpeakableText('Write <batshit-memory then an object, e.g. f = () => {"content":"x"} and it works.\nMore text after.')
    ).toBe('Write <batshit-memory then an object, e.g. f = () => {"content":"x"} and it works.\nMore text after.')
    for (const tail of ['<batshit-', '<batshit-mem', '<batshit-memory ']) {
      expect(extractSpeakableText(`The answer. ${tail}`)).toBe('The answer.')
    }
  })
})
