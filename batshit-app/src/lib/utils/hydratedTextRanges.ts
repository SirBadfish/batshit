/** Structural UI hydration sidecar. These ranges are code-produced and never read from HTML. */
export type TextRange = { start: number; end: number }

/** Retain only original ranges outside a replacement; inserted text inherits no trust. */
export function replaceTextRanges(ranges: readonly TextRange[], start: number, end: number, length: number): TextRange[] {
  const delta = length - (end - start)
  return ranges.flatMap((range) => {
    if (range.end <= start) return [{ ...range }]
    if (range.start >= end) return [{ start: range.start + delta, end: range.end + delta }]
    const kept: TextRange[] = []
    if (range.start < start) kept.push({ start: range.start, end: start })
    if (range.end > end) kept.push({ start: start + length, end: range.end + delta })
    return kept
  })
}

/**
 * Render cleanup only removes bytes. Project trust conservatively through that cleanup: both
 * the earliest and latest possible source position must lie in the SAME hydrated range. Thus
 * even identical raw and hydrated tags cannot lend each other trust after a removal.
 * An insertion or any unaccounted transformation drops the sidecar. Linear in the two texts.
 */
export function projectRemovedTextRanges(before: string, after: string, ranges: readonly TextRange[]): TextRange[] {
  if (!ranges.length || !after) return []
  if (before === after) return ranges.map((range) => ({ ...range }))
  const earliest = new Uint32Array(after.length)
  let source = 0
  for (let i = 0; i < after.length; i++) {
    while (source < before.length && before[source] !== after[i]) source++
    if (source === before.length) return []
    earliest[i] = source++
  }
  const latest = new Uint32Array(after.length)
  source = before.length - 1
  for (let i = after.length - 1; i >= 0; i--) {
    while (source >= 0 && before[source] !== after[i]) source--
    if (source < 0) return []
    latest[i] = source--
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const projected: TextRange[] = []
  let rangeIndex = 0
  let openRangeIndex = -1
  let open: TextRange | null = null
  for (let i = 0; i < after.length; i++) {
    while (rangeIndex < sorted.length && earliest[i] >= sorted[rangeIndex].end) rangeIndex++
    const range = sorted[rangeIndex]
    const trusted = range && earliest[i] >= range.start && latest[i] < range.end
    if (trusted) {
      if (!open || openRangeIndex !== rangeIndex) {
        open = { start: i, end: i + 1 }
        openRangeIndex = rangeIndex
        projected.push(open)
      }
      else open.end = i + 1
    } else open = null
  }
  return projected
}
