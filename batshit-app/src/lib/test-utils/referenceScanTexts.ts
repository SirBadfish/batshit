/**
 * Generated texts for the reference readers' comparisons (BL-707): each reader's one-pass scan
 * must find exactly what its old regex found, so these texts are mostly references or one rule
 * short of one: a `}` inside a description, `{` and `{{` in an id, colons, `:::`, `::::`, line
 * breaks (U+2028 included), spaces, very long ids, empty bodies, and zip, clip, legacy clip, and
 * placeholder tokens mixed. Seeded, so a failure names a text that reproduces.
 */

/** Deterministic, so a failure names a text that reproduces. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const CONCRETE_ZIP_ID = 'cool_tool_1779416324513_abcd1'
export const CONCRETE_CLIP_ID = 'clip_1779416324513_abcd1234'

const NBSP = String.fromCharCode(0xa0)
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
const ZIP = CONCRETE_ZIP_ID
const CLIP = CONCRETE_CLIP_ID

const TOKENS = [
  '{{batshit-zip:', '{{batshit-zip:', '{{batshit-zip:', '{{batshit-clip:', '{{batshit-clip:',
  '{{TOOL_LOADING_PLACEHOLDER:', '{{batshit-clip|id:clip_1}}', '{{/batshit-clip}}', '{{batshit|id:',
  ':::', ':::', '::::', '::', ':', '}}', '}}', '}', '}}}', '{', '{{', '|', 'zip_1', 'clip_1', ZIP,
  CLIP, `${ZIP} `, ` ${CLIP}`, 'tool_result_1', ' ', 'id ', '\n', '\r', '\r\n', '\n\n\n', '\t', NBSP,
  LINE_SEPARATOR, PARAGRAPH_SEPARATOR, 'a', 'desc words', 'Tool execution: read', 'subagent',
  'q'.repeat(170), 'z'.repeat(1200), `{{batshit-zip:${ZIP}:::Tool execution: bash}}`,
  `{{batshit-zip:${ZIP}}}`, `{{batshit-clip:${CLIP}:::notes.md}}`, `{{batshit-clip:${CLIP}}}`,
  '{{TOOL_LOADING_PLACEHOLDER:tool_1}}'
]

const OPENERS = ['{{batshit-zip:', '{{batshit-zip:', '{{batshit-clip:', '{{batshit-clip:', '{{TOOL_LOADING_PLACEHOLDER:']
const ID_PARTS = [
  ZIP, ZIP, CLIP, CLIP, 'zip_1', 'a', ' ', '\n', '\r\n', LINE_SEPARATOR, '{', '{{', NBSP, '\t', '|',
  'q'.repeat(200), 'x'.repeat(5000)
]
const DESCRIPTION_PARTS = [
  'desc', ' ', '\n', LINE_SEPARATOR, '{', '}', ':', ':::', '::::', '{{batshit-zip:b}}',
  `{{batshit-clip:${CLIP}}}`, 'Tool execution: x', 'x'.repeat(60)
]
const CLOSERS = ['}}', '}}', '}}', '}', '} }', '}}}', '', ':}}', ' }}']

/** Hand-written texts for the rules the generated ones may miss. */
export const REFERENCE_SCAN_HAND_CASES: string[] = [
  '',
  '{{batshit-zip:',
  '{{batshit-zip:}}',
  '{{batshit-zip:::}}',
  '{{batshit-zip::::}}',
  '{{batshit-zip::::x}}',
  '{{batshit-zip:a}',
  '{{batshit-zip:a} }}',
  '{{batshit-zip:a}}}',
  '{{batshit-zip:a b}}',
  '{{batshit-zip: a}}',
  '{{batshit-zip: }}',
  `{{batshit-zip:${ZIP} }}`,
  `{{batshit-zip:${ZIP} :::Tool execution: read}}`,
  '{{batshit-zip:a\nb}}',
  '{{batshit-zip:a\r\nb:::x}}',
  '{{batshit-zip:a' + LINE_SEPARATOR + 'b:::x}}',
  '{{batshit-zip:a{b}}',
  '{{batshit-zip:{{batshit-zip:b}}',
  '{{batshit-zip:a{{batshit-zip:b}}',
  '{{batshit-zip:a:::x}y}}',
  '{{batshit-zip:a:::x}y}} {{batshit-zip:b:::z}}',
  '{{batshit-zip:a:::x}}}',
  '{{batshit-zip:a:::}}',
  '{{batshit-zip:a::::x}}',
  '{{batshit-zip:a::::}}',
  '{{batshit-zip:a::b}}',
  '{{batshit-zip:a:}}',
  '{{batshit-zip:a:::x {{batshit-zip:b}}',
  '{{batshit-zip:a b:::{{batshit-zip:c}}',
  '{{batshit-zip:a:::line one\nline two}}',
  '{{batshit-zip:' + 'a'.repeat(5000) + ':::x}}',
  '{{batshit-zip:' + 'a'.repeat(5000) + '}}',
  '{{batshit-clip:a b}}',
  '{{batshit-clip:a{b}}',
  '{{batshit-clip:a:::x}y}}',
  `{{batshit-clip:${CLIP} :::notes.md}}`,
  `{{batshit-clip:${CLIP}:::}}`,
  '{{batshit-clip:a{{batshit-clip:b}}',
  `{{batshit-clip|id:c}}x{{/batshit-clip}} {{batshit-clip:${CLIP}:::y}} {{batshit-zip:${ZIP}:::z}} {{TOOL_LOADING_PLACEHOLDER:t}}`,
  `{{batshit-zip:${ZIP}}} {{batshit-zip:${ZIP}}} {{batshit-zip:${ZIP}:::Tool execution: bash}}`,
  'The `{{batshit-zip:` prefix opens a reference.\nLater, `}}` closes one.',
  ZIP,
  ` ${CLIP} `
]

/** `count` texts: some a run of tokens, most built part by part as references or near misses. */
export function generateReferenceScanTexts(count: number, seed: number): string[] {
  const random = seededRandom(seed)
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]
  const texts: string[] = []
  for (let i = 0; i < count; i++) {
    let text = ''
    if (random() < 0.35) {
      const length = 1 + Math.floor(random() * 20)
      for (let j = 0; j < length; j++) text += pick(TOKENS)
    } else {
      const segments = 1 + Math.floor(random() * 4)
      for (let j = 0; j < segments; j++) {
        if (random() < 0.2) {
          text += pick(TOKENS)
          continue
        }
        text += pick(OPENERS)
        const idLength = Math.floor(random() * 3)
        for (let k = 0; k < idLength; k++) text += pick(ID_PARTS)
        if (random() < 0.5) {
          text += pick([':::', ':::', '::::', '::', ':'])
          const descriptionLength = Math.floor(random() * 4)
          for (let k = 0; k < descriptionLength; k++) text += pick(DESCRIPTION_PARTS)
        }
        text += pick(CLOSERS)
      }
    }
    texts.push(text)
  }
  return texts
}

/**
 * Every run of characters other than `:` and `}` right after an `open` in `text`, as written and
 * trimmed: a superset of the ids any reader of `{{<open>id…}}` can read there, for comparing
 * readers that answer a yes or no about one id at a time.
 */
export function idRunsAfter(text: string, open: string): string[] {
  const runs = new Set<string>()
  for (let at = text.indexOf(open); at >= 0; at = text.indexOf(open, at + 1)) {
    const idStart = at + open.length
    let end = idStart
    while (end < text.length && text[end] !== ':' && text[end] !== '}') end++
    const run = text.slice(idStart, end)
    runs.add(run)
    if (run.trim()) runs.add(run.trim())
  }
  return Array.from(runs)
}
