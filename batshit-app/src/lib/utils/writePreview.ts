type WriteContentExtractionOptions = {
  commandCandidates?: unknown[]
  directContentCandidates?: unknown[]
}

function decodeEscapedShellText(value: string): string {
  return value
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
}

function stripQuotedWriteText(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return decodeEscapedShellText(trimmed.slice(1, -1))
  }
  return trimmed
}

function parseSimpleWriteCommand(command: string): string {
  const heredocMarker = command.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/)
  if (heredocMarker?.[1]) {
    const marker = heredocMarker[1]
    const start = command.indexOf('\n', (heredocMarker.index ?? 0) + heredocMarker[0].length)
    if (start !== -1) {
      const body = command.slice(start + 1)
      const endToken = `\n${marker}`
      const end = body.indexOf(endToken)
      if (end !== -1) return body.slice(0, end)
    }
  }

  const printfMatch = command.match(
    /^\s*printf\s+(?:%[^\s]+\s+)?("(?:\\.|[^"])*"|'(?:[^']*)*')\s*(?:\d*>>|\d*>|>>|>)\s*['"]?[^'"`><\s]+['"]?\s*$/i
  )
  if (printfMatch?.[1]) {
    return stripQuotedWriteText(printfMatch[1])
  }

  const echoMatch = command.match(
    /^\s*echo\s+([\s\S]*?)\s*(?:\d*>>|\d*>|>>|>)\s*['"]?[^'"`><\s]+['"]?\s*$/i
  )
  if (echoMatch?.[1]) {
    return stripQuotedWriteText(echoMatch[1])
  }

  return ''
}

function parseWriteContentFromCommand(command: string): string {
  const segments = command
    .split(/&&|\|\||;/)
    .map((segment) => segment.trim())
    .filter(Boolean)

  const candidates = [command, segments[segments.length - 1] ?? '']
  for (const candidate of candidates) {
    const parsed = parseSimpleWriteCommand(candidate)
    if (parsed.length > 0) return parsed
  }

  return ''
}

export function countTextLines(value: string | null | undefined): number {
  if (typeof value !== 'string' || value.length === 0) return 0

  const normalized = value.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines.length
}

export function extractWriteContentFromSources(options: WriteContentExtractionOptions): string {
  for (const candidate of options.directContentCandidates ?? []) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate
    }
  }

  for (const candidate of options.commandCandidates ?? []) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    const parsed = parseWriteContentFromCommand(candidate)
    if (parsed.length > 0) return parsed
  }

  return ''
}
