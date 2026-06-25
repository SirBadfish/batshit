export type SplitFrontmatterResult = {
  frontmatter: Record<string, unknown>
  body: string
}

export function splitFrontmatter(markdown: string): SplitFrontmatterResult {
  if (!markdown.startsWith('---')) {
    return { frontmatter: {}, body: markdown }
  }

  const closingIndex = markdown.indexOf('\n---', 3)
  if (closingIndex === -1) {
    return { frontmatter: {}, body: markdown }
  }

  const raw = markdown.slice(3, closingIndex).trim()
  const body = markdown.slice(closingIndex + 4).trimStart()
  return {
    frontmatter: parseFrontmatterBlock(raw),
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

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep === -1) continue
    const key = line.slice(0, sep).trim()
    const value = line.slice(sep + 1).trim()
    if (!key) continue
    nested[key] = String(parseFrontmatterScalar(value) ?? '').trim()
  }

  return nested
}

export function parseFrontmatterBlock(raw: string): Record<string, unknown> {
  const lines = raw.split('\n')
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
      frontmatter[key] = parseFrontmatterScalar(valuePart)
      index += 1
      continue
    }

    const nestedLines: string[] = []
    let cursor = index + 1
    while (cursor < lines.length) {
      const candidate = lines[cursor]
      if (!candidate.trim()) {
        nestedLines.push(candidate)
        cursor += 1
        continue
      }
      if (!candidate.startsWith(' ') && !candidate.startsWith('\t')) {
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
