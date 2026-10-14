import { describe, expect, it } from 'vitest'

import {
  findNamedEmoteTags,
  findPairedEmoteTags,
  findSelfClosingEmoteTags,
  findSelfClosingNamedEmoteTags,
  type EmoteTagMatch
} from './emoteTagScan'

/** The regexes these scans replaced in `cueParser.ts`, kept as the reference. */
const RETIRED = {
  paired: /<(?:emote|goon-emote)\b([^>]*)>([\s\S]*?)<\/(?:emote|goon-emote)>/gi,
  selfClosing: /<(?:emote|goon-emote)\b([^>]*)\/>/gi,
  named: /<((?:emote|goon-emote)-([a-zA-Z0-9_-]+))\b[^>]*>[\s\S]*?<\/\1>/gi,
  selfClosingNamed: /<(?:emote|goon-emote)-([a-zA-Z0-9_-]+)\b[^>]*\/>/gi
}

function execAll(regex: RegExp, text: string): EmoteTagMatch[] {
  const pattern = new RegExp(regex.source, regex.flags)
  const matches: EmoteTagMatch[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    matches.push({ index: match.index, text: match[0], groups: match.slice(1).map((group) => group ?? '') })
  }
  return matches
}

const SCANS = {
  paired: findPairedEmoteTags,
  selfClosing: findSelfClosingEmoteTags,
  named: findNamedEmoteTags,
  selfClosingNamed: findSelfClosingNamedEmoteTags
} as const

describe('the Goon cue parser\'s emote scans: the retired regexes, in one pass', () => {
  const pieces = [
    '<emote',
    '<goon-emote',
    '<EMOTE',
    '<emote-wave',
    '<Goon-Emote-smile_2',
    '<emote-a-',
    '<emotex',
    '</emote>',
    '</goon-emote>',
    '</emote-wave>',
    '</EMOTE-WAVE>',
    '</goon-emote-smile_2>',
    '</emote-a->',
    '</emote-',
    '>',
    '/>',
    ' name="wink"',
    ' ',
    '-',
    '_',
    'x',
    '\n',
    '<',
    'hello ',
    'İ'
  ]

  it('finds the same matches on 5,000 generated texts', () => {
    let state = 19
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 2 ** 32
    }
    for (let sample = 0; sample < 5000; sample += 1) {
      let text = ''
      const length = Math.floor(random() * 12)
      for (let part = 0; part < length; part += 1) text += pieces[Math.floor(random() * pieces.length)]
      for (const name of Object.keys(SCANS) as Array<keyof typeof SCANS>) {
        expect(SCANS[name](text), `${name}: ${JSON.stringify(text)}`).toEqual(execAll(RETIRED[name], text))
      }
    }
  })

  it('reads 100,000 unclosed emote tags in one pass', () => {
    const text = `${'x <emote name="wave"> <emote-wink y '.repeat(50_000)}>`
    const started = performance.now()
    for (const scan of Object.values(SCANS)) expect(scan(text)).toEqual([])
    expect(performance.now() - started).toBeLessThan(1_500)
  })

  it('reads 150,000 emote openings with one `>` at the very end in one pass', () => {
    // Without the remembered `>`, each opening searched to the end (grows with the square).
    const text = `${'<emote a '.repeat(150_000)}>`
    const started = performance.now()
    for (const scan of Object.values(SCANS)) scan(text)
    expect(performance.now() - started).toBeLessThan(1_500)
  })
})
