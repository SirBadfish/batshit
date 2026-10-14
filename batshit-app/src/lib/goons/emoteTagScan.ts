/**
 * The Goon cue parser's emote tags, found in one pass each (BL-442's sweep of the lazy regexes,
 * the BL-640 shape in the browser). Each function returns exactly the matches its retired regex
 * returned in a global `exec` loop (compared over generated texts in `emoteTagScan.test.ts`):
 *
 * - `findPairedEmoteTags`: `/<(?:emote|goon-emote)\b([^>]*)>([\s\S]*?)<\/(?:emote|goon-emote)>/gi`
 * - `findSelfClosingEmoteTags`: `/<(?:emote|goon-emote)\b([^>]*)\/>/gi`
 * - `findNamedEmoteTags`: `/<((?:emote|goon-emote)-([a-zA-Z0-9_-]+))\b[^>]*>[\s\S]*?<\/\1>/gi`
 * - `findSelfClosingNamedEmoteTags`: `/<(?:emote|goon-emote)-([a-zA-Z0-9_-]+)\b[^>]*\/>/gi`
 *
 * The lazy regexes tried every unclosed `<emote…>` against the rest of the text, and every
 * `<emote` without a `>` near it scanned to the next `>`: the cost was (tags) x (text length).
 * Here the closing tags are listed once, and the next `>` is remembered across candidates.
 */

export interface EmoteTagMatch {
  /** Where the match starts (the `<`). */
  index: number
  /** The matched text (`match[0]`). */
  text: string
  /** The capture groups, in the retired regex's order (`match[1]`, `match[2]`). */
  groups: string[]
}

const BASES = ['emote', 'goon-emote']
const SUFFIX_CHAR = /[a-z0-9_-]/

function foldAscii(text: string): string {
  return /[A-Z]/.test(text) ? text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase()) : text
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char)
}

/** The `emote` / `goon-emote` name after the `<` at `at`, or null. */
function baseAt(folded: string, at: number): string | null {
  if (folded[at] !== '<') return null
  return BASES.find((base) => folded.startsWith(base, at + 1)) ?? null
}

/** Candidate `<emote` / `<goon-emote` positions, in order, with the first `>` at or after the name. */
function* candidates(folded: string): Generator<{ at: number; nameEnd: number; closeAngle: number }> {
  let closeAngle = -2
  for (let at = folded.indexOf('<'); at >= 0; at = folded.indexOf('<', at + 1)) {
    const base = baseAt(folded, at)
    if (!base) continue
    const nameEnd = at + 1 + base.length
    if (closeAngle !== -1 && closeAngle < nameEnd) closeAngle = folded.indexOf('>', nameEnd)
    yield { at, nameEnd, closeAngle }
  }
}

function firstAfter(sorted: number[], from: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (sorted[mid] < from) low = mid + 1
    else high = mid
  }
  return low < sorted.length ? sorted[low] : -1
}

/** The suffix ends a `-name` may have after the base (longest first), where the regex's `\b` holds. */
function suffixEnds(folded: string, nameEnd: number): number[] {
  if (folded[nameEnd] !== '-') return []
  let runEnd = nameEnd + 1
  while (runEnd < folded.length && SUFFIX_CHAR.test(folded[runEnd])) runEnd += 1
  const ends: number[] = []
  for (let end = runEnd; end >= nameEnd + 2; end -= 1) {
    if (isWordChar(folded[end - 1]) !== isWordChar(folded[end])) ends.push(end)
  }
  return ends
}

/** Runs one `exec` loop's worth of matches: `matchAt` answers the match starting at a candidate, if any. */
function scan(
  text: string,
  matchAt: (candidate: { at: number; nameEnd: number; closeAngle: number }) => { end: number; groups: string[] } | null
): EmoteTagMatch[] {
  const folded = foldAscii(text)
  if (!folded.includes('emote')) return []
  const matches: EmoteTagMatch[] = []
  let resumeAt = 0
  for (const candidate of candidates(folded)) {
    if (candidate.at < resumeAt) continue
    if (candidate.closeAngle < 0) break
    const found = matchAt(candidate)
    if (!found) continue
    matches.push({ index: candidate.at, text: text.slice(candidate.at, found.end), groups: found.groups })
    resumeAt = found.end
  }
  return matches
}

export function findPairedEmoteTags(text: string): EmoteTagMatch[] {
  const folded = foldAscii(text)
  const closings: number[] = []
  const closingEnds = new Map<number, number>()
  for (let at = folded.indexOf('</'); at >= 0; at = folded.indexOf('</', at + 2)) {
    const base = BASES.find((name) => folded.startsWith(`${name}>`, at + 2))
    if (!base) continue
    closings.push(at)
    closingEnds.set(at, at + 3 + base.length)
  }
  return scan(text, ({ nameEnd, closeAngle }) => {
    if (isWordChar(folded[nameEnd])) return null
    const closing = firstAfter(closings, closeAngle + 1)
    if (closing < 0) return null
    return {
      end: closingEnds.get(closing)!,
      groups: [text.slice(nameEnd, closeAngle), text.slice(closeAngle + 1, closing)]
    }
  })
}

export function findSelfClosingEmoteTags(text: string): EmoteTagMatch[] {
  const folded = foldAscii(text)
  return scan(text, ({ nameEnd, closeAngle }) => {
    if (isWordChar(folded[nameEnd])) return null
    // The `>` is past the name, so a `/` just before it is never part of the name.
    if (folded[closeAngle - 1] !== '/') return null
    return { end: closeAngle + 1, groups: [text.slice(nameEnd, closeAngle - 1)] }
  })
}

export function findNamedEmoteTags(text: string): EmoteTagMatch[] {
  const folded = foldAscii(text)
  // Every `</name>` by its name, in order.
  const closings = new Map<string, number[]>()
  for (let at = folded.indexOf('</'); at >= 0; at = folded.indexOf('</', at + 2)) {
    let end = at + 2
    while (end < folded.length && SUFFIX_CHAR.test(folded[end])) end += 1
    if (end === at + 2 || folded[end] !== '>') continue
    const name = folded.slice(at + 2, end)
    const list = closings.get(name)
    if (list) list.push(at)
    else closings.set(name, [at])
  }
  return scan(text, ({ at, nameEnd, closeAngle }) => {
    for (const end of suffixEnds(folded, nameEnd)) {
      const name = folded.slice(at + 1, end)
      const closing = firstAfter(closings.get(name) ?? [], closeAngle + 1)
      if (closing >= 0) {
        return { end: closing + name.length + 3, groups: [text.slice(at + 1, end), text.slice(nameEnd + 1, end)] }
      }
    }
    return null
  })
}

export function findSelfClosingNamedEmoteTags(text: string): EmoteTagMatch[] {
  const folded = foldAscii(text)
  return scan(text, ({ nameEnd, closeAngle }) => {
    const [end] = suffixEnds(folded, nameEnd)
    if (end === undefined || folded[closeAngle - 1] !== '/') return null
    return { end: closeAngle + 1, groups: [text.slice(nameEnd + 1, end)] }
  })
}
