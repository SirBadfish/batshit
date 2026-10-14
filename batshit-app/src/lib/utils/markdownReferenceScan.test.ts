import { describe, expect, it } from 'vitest'
import {
  scanTranscriptReferences, scanMessageZipReferences, scanMessageClipReferences,
  scanTranscriptLegacyClipBlocks
} from './markdownReferenceScan'

// Literal pre-fix readers are an independent compatibility oracle on short inputs.
const transcriptRegex = /\{\{(batshit-zip|batshit-clip):([^:}]+?)(?::::([^}]+))?\}\}/g
const messageZipRegex = /\{\{batshit-zip:([^:]+?)(?::::([^}]+?))?\}\}/g
const messageClipRegex = /\{\{batshit-clip:([^:]+?)(?::::([^}]+?))?\}\}/g
const legacyRegex = /\{\{batshit-clip\|([^}]+)\}\}([\s\S]*?)\{\{\/batshit-clip\}\}/g
function modernOracle(text: string, regex: RegExp, kind?: 'batshit-zip' | 'batshit-clip') {
  return Array.from(text.matchAll(regex), (m) => ({
    start: m.index, end: m.index + m[0].length, match: m[0],
    kind: kind || m[1], id: m[kind ? 1 : 2], description: m[kind ? 2 : 3]
  }))
}
function legacyOracle(text: string) {
  return Array.from(text.matchAll(legacyRegex), (m) => ({
    start: m.index, end: m.index + m[0].length, metadata: m[1], body: m[2]
  }))
}
const pieces = [
  '{{batshit-zip:', '{{batshit-clip:', '{{batshit-clip|', '{{/batshit-clip}}',
  '{{batshit-ZIP:', 'x', '', ':', ':::', '}', '}}', '}}}', '{', '|', '\n', ' ',
  '<terminal>', '</terminal>', '`', '🐟', '{{batshit-zip:z:::ok}}', '{{batshit-clip:c}}'
]
function examples() {
  const texts = [
    '{{batshit-zip:}}}', '{{batshit-zip:a}b}}', '{{batshit-zip:x:::}}',
    '{{batshit-zip:x::::d}}', '{{batshit-zip:x}:::d}}', '{{batshit-clip|}}body{{/batshit-clip}}',
    '{{batshit-clip|outer}}{{batshit-clip|inner}}body{{/batshit-clip}}{{/batshit-clip}}'
  ]
  for (const first of pieces) for (const second of pieces) for (const third of pieces) {
    texts.push(first + second + third)
  }
  let seed = 693
  for (let i = 0; i < 12000; i++) {
    let text = ''
    for (let j = 0; j < 12; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      text += pieces[seed % pieces.length]
    }
    texts.push(text)
  }
  return texts
}

describe('markdownReferenceScan existing grammar compatibility', () => {
  it('matches the transcript modern reader exactly, including positions and captures', () => {
    for (const text of examples()) expect(scanTranscriptReferences(text), text).toEqual(modernOracle(text, transcriptRegex))
  })
  it('matches the message zip reader exactly, retaining its broader id grammar', () => {
    for (const text of examples()) expect(scanMessageZipReferences(text), text).toEqual(modernOracle(text, messageZipRegex, 'batshit-zip'))
  })
  it('matches the message clip reader exactly, retaining its broader id grammar', () => {
    for (const text of examples()) expect(scanMessageClipReferences(text), text).toEqual(modernOracle(text, messageClipRegex, 'batshit-clip'))
  })
  it('matches the legacy block reader exactly, including nested and unfinished blocks', () => {
    for (const text of examples()) expect(scanTranscriptLegacyClipBlocks(text), text).toEqual(legacyOracle(text))
  })
})
