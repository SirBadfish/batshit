export type SplitFrontmatterResult = {
  frontmatter: Record<string, unknown>
  body: string
}

/**
 * Reads a top-level scalar after its continuation lines have been folded. A caller with
 * its own value rules still gets the shared nested-map and block reading (BL-1240).
 */
export type FrontmatterScalarReader = (value: string) => unknown

export function splitFrontmatter(
  markdown: string,
  readScalar: FrontmatterScalarReader = parseFrontmatterScalar
): SplitFrontmatterResult {
  if (!markdown.startsWith('---')) {
    return { frontmatter: {}, body: markdown }
  }

  const closingIndex = markdown.indexOf('\n---', 3)
  if (closingIndex === -1) {
    return { frontmatter: {}, body: markdown }
  }

  // Drop only the leading blank lines and the closing line's `\r`: a trim would also take the
  // first key's indentation, which a block value measures its lines against (BL-469).
  const raw = markdown
    .slice(3, closingIndex)
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/\r$/, '')
  const body = markdown.slice(closingIndex + 4).trimStart()
  return {
    frontmatter: parseFrontmatterBlock(raw, readScalar),
    body
  }
}

export function parseFrontmatterScalar(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }

  if (trimmed === 'true' || trimmed === 'false') {
    return trimmed === 'true'
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    if (!inner) return []
    return inner
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // Keep invalid object literals as plain scalar text.
    }
  }

  return trimmed
}

export function parseFrontmatterNestedMap(lines: string[]): Record<string, string> {
  const nested: Record<string, string> = {}

  let index = 0
  while (index < lines.length) {
    const rawLine = lines[index]
    index += 1
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep === -1) continue
    const key = line.slice(0, sep).trim()
    const value = line.slice(sep + 1).trim()
    if (!key) continue
    const parsed = readFrontmatterValue(lines, index - 1, value, parseFrontmatterScalar)
    nested[key] = BLOCK_SCALAR_HEADER.test(value)
      ? String(parsed.value ?? '')
      : String(parsed.value ?? '').trim()
    index = parsed.nextIndex
  }

  return nested
}

// A YAML block scalar header (BL-469): `|` keeps line breaks, `>` folds them. An optional
// chomping indicator (`-` strip, `+` keep) and an optional indentation digit may follow in
// either order, then an optional comment. `>=1.0` or `|x` stay plain values.
const BLOCK_SCALAR_HEADER = /^([|>])(?:([+-])([1-9])?|([1-9])([+-])?)?(?:\s+#.*)?$/

function indentWidth(line: string): number {
  return /^[ \t]*/.exec(line)![0].length
}

/**
 * Reads the indented lines under a `|` or `>` key the way YAML does: strip the block's
 * indentation, fold (`>`) or keep (`|`) the line breaks, then apply the chomping
 * indicator. A line of only whitespace counts as an empty line. A comment indented less
 * than the text ends the text. Any other line indented less than the block's first line is
 * not valid YAML; it stays text of the block, so the caller never reads it as a key.
 */
function readBlockScalar(header: RegExpExecArray, blockLines: string[], parentIndent: number): string {
  const folded = header[1] === '>'
  const chomping = header[2] ?? header[5] ?? ''
  const indentIndicator = header[3] ?? header[4]
  const firstContentLine = blockLines.find((line) => line.trim())
  const contentIndent = indentIndicator
    ? parentIndent + Number(indentIndicator)
    : firstContentLine
      ? indentWidth(firstContentLine)
      : parentIndent + 1

  let text = ''
  let hasContent = false
  let emptyLines = 0
  let previousMoreIndented = false

  for (const line of blockLines) {
    if (!line.trim()) {
      emptyLines += 1
      continue
    }

    const lineIndent = indentWidth(line)
    // A comment indented less than the text ends the block, as in YAML.
    if (lineIndent < contentIndent && line.trim().startsWith('#')) break

    const content = line.slice(Math.min(lineIndent, contentIndent))
    const moreIndented = /^[ \t]/.test(content)

    if (!folded || moreIndented || previousMoreIndented) {
      text += '\n'.repeat(hasContent ? emptyLines + 1 : emptyLines)
    } else if (emptyLines > 0) {
      text += '\n'.repeat(emptyLines)
    } else if (hasContent) {
      text += ' '
    }

    text += content
    hasContent = true
    previousMoreIndented = moreIndented
    emptyLines = 0
  }

  if (chomping === '+') {
    text += '\n'.repeat(hasContent ? emptyLines + 1 : emptyLines)
  } else if (chomping === '' && hasContent) {
    text += '\n'
  }

  return text
}

/** Ignore escaped double quotes and doubled single quotes when finding a scalar's end. */
function hasClosingQuote(text: string, quote: string, start: number): boolean {
  for (let index = start; index < text.length; index += 1) {
    if (quote === '"' && text[index] === '\\') {
      index += 1
    } else if (text[index] === quote) {
      if (quote === "'" && text[index + 1] === "'") index += 1
      else return true
    }
  }
  return false
}

/** Shared value boundaries for top-level keys and one-level metadata (BL-1239). */
function readFrontmatterValue(
  lines: string[], index: number, valuePart: string, readScalar: FrontmatterScalarReader
): { value: unknown; nextIndex: number } {
  const parentIndent = indentWidth(lines[index])
  const blockHeader = BLOCK_SCALAR_HEADER.exec(valuePart)
  if (blockHeader) {
    let cursor = index + 1
    while (cursor < lines.length) {
      const candidate = lines[cursor]
      if (candidate.trim() && indentWidth(candidate) <= parentIndent) break
      cursor += 1
    }
    return {
      value: readBlockScalar(blockHeader, lines.slice(index + 1, cursor), parentIndent),
      nextIndex: cursor
    }
  }

  const quote = /^["']/.test(valuePart) ? valuePart[0] : null
  // Complete quoted/collection values retain the existing reader's rules and boundary.
  if (!valuePart || /^[\[{]/.test(valuePart) || (quote && hasClosingQuote(valuePart, quote, 1))) {
    return { value: readScalar(valuePart), nextIndex: index + 1 }
  }

  let text = valuePart
  let cursor = index + 1
  let emptyLines = 0
  while (cursor < lines.length) {
    const candidate = lines[cursor]
    if (!candidate.trim()) {
      emptyLines += 1
      cursor += 1
      continue
    }
    if (indentWidth(candidate) <= parentIndent || (!quote && candidate.trim().startsWith('#'))) break

    // Flow scalars fold ordinary breaks to spaces; blank lines retain paragraph breaks.
    // Quotes stay around the folded text for the caller's existing scalar reader.
    const continuation = candidate.trim()
    text = text.trimEnd() + (emptyLines ? '\n'.repeat(emptyLines) : ' ') + continuation
    emptyLines = 0
    cursor += 1
    if (quote && hasClosingQuote(continuation, quote, 0)) break
  }
  return { value: readScalar(text), nextIndex: cursor }
}

export function parseFrontmatterBlock(
  raw: string,
  readScalar: FrontmatterScalarReader = parseFrontmatterScalar
): Record<string, unknown> {
  const lines = raw.split(/\r?\n/)
  const frontmatter: Record<string, unknown> = {}

  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      index += 1
      continue
    }

    const sep = trimmed.indexOf(':')
    if (sep === -1) {
      index += 1
      continue
    }

    const key = trimmed.slice(0, sep).trim()
    const valuePart = trimmed.slice(sep + 1).trim()
    if (!key) {
      index += 1
      continue
    }

    if (valuePart.length > 0) {
      const parsed = readFrontmatterValue(lines, index, valuePart, readScalar)
      frontmatter[key] = parsed.value
      index = parsed.nextIndex
      continue
    }

    // A nested line is indented deeper than its key, as for a block; in a frontmatter whose
    // lines are all indented, the next key at the same depth is a sibling (BL-1240).
    const keyIndent = indentWidth(line)
    const nestedLines: string[] = []
    let cursor = index + 1
    while (cursor < lines.length) {
      const candidate = lines[cursor]
      if (!candidate.trim()) {
        nestedLines.push(candidate)
        cursor += 1
        continue
      }
      if (indentWidth(candidate) <= keyIndent) {
        break
      }
      nestedLines.push(candidate)
      cursor += 1
    }

    frontmatter[key] = parseFrontmatterNestedMap(nestedLines)
    index = cursor
  }

  return frontmatter
}

export function splitAllowedToolsString(raw: string): string[] {
  const values: string[] = []
  let current = ''
  let depth = 0
  let quote: '"' | "'" | null = null
  let escape = false

  const flush = () => {
    const token = current.trim()
    current = ''
    if (!token) return
    values.push(token)
  }

  for (const char of raw) {
    if (escape) {
      current += char
      escape = false
      continue
    }

    if (char === '\\') {
      current += char
      escape = true
      continue
    }

    if (quote) {
      current += char
      if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }

    if (char === '(') {
      depth += 1
      current += char
      continue
    }

    if (char === ')') {
      depth = Math.max(0, depth - 1)
      current += char
      continue
    }

    if (depth === 0 && (char === ',' || /\s/.test(char))) {
      flush()
      continue
    }

    current += char
  }

  flush()
  return values
}

export function normalizeAllowedTools(input: unknown): string[] {
  const rawValues =
    typeof input === 'string'
      ? splitAllowedToolsString(input)
      : Array.isArray(input)
        ? splitAllowedToolsString(input.map((value) => String(value ?? '')).join(' '))
        : []

  const seen = new Set<string>()
  const normalized: string[] = []
  for (const value of rawValues) {
    const candidate = String(value ?? '').trim()
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    normalized.push(candidate)
  }
  return normalized
}
