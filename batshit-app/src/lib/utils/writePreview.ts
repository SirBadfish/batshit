type WriteContentExtractionOptions = {
  commandCandidates?: unknown[]
  directContentCandidates?: unknown[]
}

function decodeEscapedShellText(value: string): string {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char !== '\\') {
      output += char
      continue
    }

    const next = value[index + 1]
    if (!next) {
      output += char
      continue
    }

    index += 1
    switch (next) {
      case 'n':
        output += '\n'
        break
      case 'r':
        output += '\r'
        break
      case 't':
        output += '\t'
        break
      case '\\':
      case '"':
      case "'":
        output += next
        break
      default:
        output += `\\${next}`
    }
  }
  return output
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

function readShellToken(value: string, start: number): { token: string; end: number } | null {
  let tokenStart = start
  while (tokenStart < value.length && /\s/.test(value[tokenStart] ?? '')) tokenStart += 1
  if (tokenStart >= value.length) return null

  let index = tokenStart
  let quote: string | null = null
  while (index < value.length) {
    const char = value[index] ?? ''
    if (quote) {
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      index += 1
      continue
    }
    if (/\s/.test(char)) break
    index += 1
  }

  return {
    token: value.slice(tokenStart, index),
    end: index
  }
}

function findRedirectOperatorIndex(value: string): number {
  let quote: string | null = null
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? ''
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '>') return index
  }
  return -1
}

function parsePrintfWriteContent(command: string): string {
  const trimmed = command.trimStart()
  if (!trimmed.toLowerCase().startsWith('printf')) return ''
  const afterCommand = trimmed.slice('printf'.length)
  if (afterCommand.length > 0 && !/\s/.test(afterCommand[0] ?? '')) return ''

  const redirectIndex = findRedirectOperatorIndex(afterCommand)
  if (redirectIndex < 0) return ''

  const beforeRedirect = afterCommand.slice(0, redirectIndex).trim()
  const firstToken = readShellToken(beforeRedirect, 0)
  if (!firstToken) return ''

  const firstValue = stripQuotedWriteText(firstToken.token)
  const contentToken = firstValue.startsWith('%')
    ? readShellToken(beforeRedirect, firstToken.end)
    : firstToken
  if (!contentToken) return ''

  return stripQuotedWriteText(contentToken.token)
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

  const printfContent = parsePrintfWriteContent(command)
  if (printfContent.length > 0) return printfContent

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
