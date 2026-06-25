export interface BashToolMapping {
  toolName:
    | 'batshit_server_read_file'
    | 'batshit_server_overwrite_file'
    | 'batshit_server_edit_file'
    | 'batshit_server_list_files'
    | 'batshit_server_search_files'
    | 'native_bash_execute'
  args: Record<string, any>
  reason: string
}

export interface Mode4BashToolMapping {
  toolName:
    | 'batshit_server_read_file'
    | 'batshit_server_overwrite_file'
    | 'batshit_server_edit_file'
    | 'batshit_server_list_files'
    | 'batshit_server_search_files'
    | 'batshit_server_execute_command'
  args: Record<string, any>
  reason: string
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractShellCommand(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) return command

  const loginMatch = trimmed.match(/-lc\s+(['"])([\s\S]*?)\1/)
  if (loginMatch?.[2]) return loginMatch[2]

  const commandMatch = trimmed.match(/-c\s+(['"])([\s\S]*?)\1/)
  if (commandMatch?.[2]) return commandMatch[2]

  const tokens = tokenizeCommand(trimmed)
  for (let index = 0; index < tokens.length - 2; index += 1) {
    const token = tokens[index]?.toLowerCase()
    const flag = tokens[index + 1]?.toLowerCase()
    if (!token || !flag) continue

    const looksLikeShell =
      token === 'bash' ||
      token === 'zsh' ||
      token === 'sh' ||
      token.endsWith('/bash') ||
      token.endsWith('/zsh') ||
      token.endsWith('/sh')

    if (!looksLikeShell || (flag !== '-lc' && flag !== '-c')) continue

    const innerTokens = tokens.slice(index + 2)
    if (innerTokens.length > 0) {
      return innerTokens.join(' ')
    }
  }

  return command
}

function extractPrimaryCommandSegment(shellCommand: string): string {
  const trimmed = shellCommand.trim()
  if (!trimmed) return ''

  // Heredocs can contain semicolons/newlines in the body, so inspect the first heredoc header line
  // rather than the first line of the whole script. Batshit-managed write/edit scripts often begin
  // with setup preambles like `set -euo pipefail` or `mkdir -p ...` before the real heredoc command.
  if (/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(trimmed)) {
    const heredocHeader = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(line))

    if (heredocHeader) return heredocHeader
    return trimmed.split(/\r?\n/, 1)[0]?.trim() ?? trimmed
  }

  const segments = shellCommand
    .split(/&&|\|\||;/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  if (segments.length === 0) return trimmed
  return segments[segments.length - 1]
}

function extractTopLevelCommandLines(shellCommand: string): string[] {
  const lines = shellCommand.split(/\r?\n/)
  const commands: string[] = []
  let heredocMarker: string | null = null

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue

    if (heredocMarker) {
      if (trimmed === heredocMarker) {
        heredocMarker = null
      }
      continue
    }

    commands.push(trimmed)

    const markerMatch = trimmed.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/)
    if (markerMatch?.[1]) {
      heredocMarker = markerMatch[1]
    }
  }

  return commands
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  const matcher = /"([^"]*)"|'([^']*)'|([^\s]+)/g
  let match: RegExpExecArray | null = null
  while ((match = matcher.exec(command))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return tokens.filter((token) => token.length > 0)
}

function extractPathFromReadCommand(shellCommand: string): string | undefined {
  const catLikeMatch = shellCommand.match(
    /\b(?:cat|head|tail)\b\s+(?:-[^\s]+\s+)*(?![><])(?:['"]?)([^'"`\s|><]+)(?:['"]?)/i
  )
  if (catLikeMatch?.[1]) return catLikeMatch[1].trim()

  const sedMatch = shellCommand.match(
    /\bsed\b[\s\S]*?\s(?:['"]?)([^'"`\s|><]+)(?:['"]?)\s*$/i
  )
  if (sedMatch?.[1]) return sedMatch[1].trim()

  return undefined
}

function extractLeadingCommandName(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) return ''
  const tokens = tokenizeCommand(trimmed)
  if (tokens.length === 0) return ''
  return tokens[0]?.toLowerCase() ?? ''
}

const RIPGREP_OPTIONS_WITH_VALUES = new Set([
  '-A',
  '-B',
  '-C',
  '-e',
  '-f',
  '-g',
  '-m',
  '--context',
  '--encoding',
  '--engine',
  '--file',
  '--glob',
  '--iglob',
  '--max-count',
  '--max-depth',
  '--path-separator',
  '--pre',
  '--pre-glob',
  '--regexp',
  '--replace',
  '--sort',
  '--sortr',
  '--type',
  '--type-add',
  '--type-not'
])

function isRipgrepListFilesCommand(tokens: string[]): boolean {
  const command = tokens[0]?.toLowerCase()
  return command === 'rg' && tokens.includes('--files')
}

function extractListPath(shellCommand: string): string | undefined {
  const primary = extractPrimaryCommandSegment(shellCommand)
  const tokens = tokenizeCommand(primary)
  if (tokens.length === 0) return undefined

  const command = tokens[0]?.toLowerCase()
  if (!command) return undefined

  if (command === 'ls') {
    for (let i = 1; i < tokens.length; i += 1) {
      const token = tokens[i]
      if (!token || token.startsWith('-')) continue
      if (token === '--') continue
      return token
    }
    return undefined
  }

  if (command === 'find') {
    for (let i = 1; i < tokens.length; i += 1) {
      const token = tokens[i]
      if (!token || token.startsWith('-')) continue
      if (token === '--') continue
      return token
    }
    return undefined
  }

  if (command === 'tree') {
    for (let i = 1; i < tokens.length; i += 1) {
      const token = tokens[i]
      if (!token || token.startsWith('-')) continue
      if (token === '--') continue
      return token
    }
    return undefined
  }

  if (isRipgrepListFilesCommand(tokens)) {
    for (let i = 1; i < tokens.length; i += 1) {
      const token = tokens[i]
      if (!token) continue
      if (RIPGREP_OPTIONS_WITH_VALUES.has(token)) {
        i += 1
        continue
      }
      if (token === '--files' || token === '--') continue
      if (token.startsWith('-')) continue
      return token
    }
    return undefined
  }

  return undefined
}

function extractApplyPatchTargetPath(shellCommand: string): string | undefined {
  const patchBody = extractHeredocContent(shellCommand) ?? shellCommand
  const lines = patchBody.split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('***')) continue

    const match = trimmed.match(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/)
    if (!match?.[1]) continue

    const candidate = match[1].trim().replace(/^['"]|['"]$/g, '')
    if (!candidate) continue
    return candidate
  }

  return undefined
}

function extractRedirectPath(shellCommand: string): string | undefined {
  const match = shellCommand.match(/(?:^|\s)(?:\d*>>|\d*>|>>|>)\s*(['"]?)([^'"`><\s]+)\1/)
  const candidate = match?.[2]?.trim()
  if (!candidate) return undefined
  if (candidate.startsWith('&')) return undefined
  if (candidate === '/dev/null' || candidate.startsWith('/dev/fd/')) return undefined
  return candidate
}

function extractPathFromInPlaceEditCommand(shellCommand: string): string | undefined {
  const lower = shellCommand.toLowerCase()
  const hasStandaloneInPlaceFlag = /\s-i(?:\s|$)/.test(lower)
  const hasCombinedPerlInPlaceFlag = /\s-[a-z0-9]*i[a-z0-9]*(?:\s|$)/.test(lower)
  const looksInPlaceEdit =
    (lower.includes('sed') && hasStandaloneInPlaceFlag) ||
    (lower.includes('perl') && (hasStandaloneInPlaceFlag || hasCombinedPerlInPlaceFlag))
  if (!looksInPlaceEdit) return undefined

  const match = shellCommand.match(/\s(['"]?)([^'"`\s|><]+)\1\s*$/)
  const candidate = match?.[2]?.trim()
  if (!candidate || candidate.startsWith('-') || candidate.includes('=')) return undefined
  return candidate
}

function decodeShellStringLiteral(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''

  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }

  if (trimmed.startsWith("$'") && trimmed.endsWith("'")) {
    return trimmed
      .slice(2, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\\\/g, '\\')
      .replace(/\\'/g, "'")
  }

  return trimmed
}

function extractHeredocContent(shellCommand: string): string | undefined {
  const markerMatch = shellCommand.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/)
  const marker = markerMatch?.[1]
  if (!marker || !markerMatch) return undefined

  const markerIndex = markerMatch.index ?? -1
  if (markerIndex < 0) return undefined
  const startOfBody = shellCommand.indexOf('\n', markerIndex + markerMatch[0].length)
  if (startOfBody === -1) return undefined

  const remaining = shellCommand.slice(startOfBody + 1)
  const lines = remaining.split(/\r?\n/)
  const endLineIndex = lines.findIndex((line) => line.trim() === marker)
  if (endLineIndex !== -1) {
    return lines.slice(0, endLineIndex).join('\n')
  }

  const hardSuffix = `\n${marker}`
  if (remaining.endsWith(hardSuffix)) {
    return remaining.slice(0, -hardSuffix.length)
  }

  return undefined
}

function extractWriteContent(shellCommand: string): string | undefined {
  const heredoc = extractHeredocContent(shellCommand)
  if (typeof heredoc === 'string' && heredoc.length > 0) return heredoc

  const echoMatch = shellCommand.match(
    /^\s*echo\s+([\s\S]*?)\s*(?:\d*>>|\d*>|>>|>)\s*['"]?[^'"`><\s]+['"]?\s*$/i
  )
  if (echoMatch?.[1]) return decodeShellStringLiteral(echoMatch[1])

  const printfMatch = shellCommand.match(
    /^\s*printf\s+([\s\S]*?)\s*(?:\d*>>|\d*>|>>|>)\s*['"]?[^'"`><\s]+['"]?\s*$/i
  )
  if (printfMatch?.[1]) return decodeShellStringLiteral(printfMatch[1])

  return undefined
}

function extractPythonFileMutation(shellCommand: string):
  | { filePath: string; kind: 'edit' | 'write' }
  | null {
  const commandLines = extractTopLevelCommandLines(shellCommand)
  const pythonHeader = commandLines.find((line) =>
    /\b(?:python|python3)\b[\s\S]*<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/i.test(line)
  )
  if (!pythonHeader || !/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(pythonHeader)) {
    return null
  }

  const heredoc = extractHeredocContent(shellCommand)
  if (!heredoc) return null

  const pathMatch = heredoc.match(/\bPath\((['"])([^'"`\n]+)\1\)/)
  let filePath = pathMatch?.[2]?.trim()
  if (!filePath) return null

  if (!filePath.startsWith('/')) {
    const cdMatch = pythonHeader.match(/\bcd\s+(['"]?)([^'"`;&|]+)\1\s*&&/i)
    const cdPath = cdMatch?.[2]?.trim()
    if (cdPath) {
      filePath = `${cdPath.replace(/\/+$/, '')}/${filePath.replace(/^\.?\//, '')}`
    }
  }

  const hasWrite = /\bwrite_(?:text|bytes)\s*\(/i.test(heredoc)
  if (!hasWrite) return null

  const hasRead = /\bread_(?:text|bytes)\s*\(/i.test(heredoc)
  return {
    filePath,
    kind: hasRead ? 'edit' : 'write'
  }
}

function normalizeCommandArgs(command: string): Record<string, any> {
  const shellCommand = extractShellCommand(command)
  return {
    command,
    innerCommand: shellCommand
  }
}

export function mapBashCommandToRendererTool(command: string): BashToolMapping {
  const normalized = normalizeCommandArgs(command)
  const shellCommand = normalized.innerCommand as string
  const commandLines = extractTopLevelCommandLines(shellCommand)
  const primaryCommand = extractPrimaryCommandSegment(shellCommand)
  const lower = primaryCommand.toLowerCase()
  const commandName = extractLeadingCommandName(primaryCommand)

  if (!primaryCommand.trim()) {
    return {
      toolName: 'native_bash_execute',
      args: normalized,
      reason: 'empty-command'
    }
  }

  const applyPatchLine = commandLines.find((line) => line.toLowerCase().includes('apply_patch'))
  if (applyPatchLine) {
    const filePath = extractApplyPatchTargetPath(shellCommand)
    return {
      toolName: 'batshit_server_edit_file',
      args: filePath ? { ...normalized, filePath, path: filePath } : normalized,
      reason: 'apply-patch'
    }
  }

  const inPlaceEditPath =
    commandLines.map((line) => extractPathFromInPlaceEditCommand(line)).find((value) => Boolean(value)) ??
    extractPathFromInPlaceEditCommand(primaryCommand)
  if (inPlaceEditPath) {
    return {
      toolName: 'batshit_server_edit_file',
      args: { ...normalized, filePath: inPlaceEditPath, path: inPlaceEditPath },
      reason: 'in-place-edit'
    }
  }

  const redirectPath =
    commandLines.map((line) => extractRedirectPath(line)).find((value) => Boolean(value)) ??
    extractRedirectPath(primaryCommand)
  if (redirectPath) {
    const content = extractWriteContent(shellCommand)
    return {
      toolName: 'batshit_server_overwrite_file',
      args:
        typeof content === 'string'
          ? { ...normalized, filePath: redirectPath, path: redirectPath, content }
          : { ...normalized, filePath: redirectPath, path: redirectPath },
      reason: 'redirect-write'
    }
  }

  const pythonFileMutation = extractPythonFileMutation(shellCommand)
  if (pythonFileMutation) {
    return {
      toolName:
        pythonFileMutation.kind === 'edit'
          ? 'batshit_server_edit_file'
          : 'batshit_server_overwrite_file',
      args: {
        ...normalized,
        filePath: pythonFileMutation.filePath,
        path: pythonFileMutation.filePath
      },
      reason: pythonFileMutation.kind === 'edit' ? 'python-file-edit' : 'python-file-write'
    }
  }

  if (
    commandName === 'ls' ||
    commandName === 'find' ||
    commandName === 'tree' ||
    isRipgrepListFilesCommand(tokenizeCommand(primaryCommand))
  ) {
    const listPath = extractListPath(primaryCommand)
    return {
      toolName: 'batshit_server_list_files',
      args: listPath ? { ...normalized, path: listPath, dirPath: listPath } : normalized,
      reason: 'list-command'
    }
  }

  if (commandName === 'rg' || commandName === 'grep') {
    return {
      toolName: 'batshit_server_search_files',
      args: normalized,
      reason: 'search-command'
    }
  }

  if (commandName === 'cat' || commandName === 'sed' || commandName === 'head' || commandName === 'tail') {
    const filePath = extractPathFromReadCommand(primaryCommand)
    if (filePath) {
      return {
        toolName: 'batshit_server_read_file',
        args: { ...normalized, filePath, path: filePath },
        reason: 'read-command'
      }
    }
  }

  return {
    toolName: 'native_bash_execute',
    args: normalized,
    reason: 'fallback-command'
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function resolveCommandCandidate(args?: Record<string, any> | null, result?: any): string | null {
  if (isRecord(args)) {
    const fromArgs = [args.command, args.innerCommand, args.cmd]
      .find((entry) => typeof entry === 'string' && entry.trim().length > 0)
    if (typeof fromArgs === 'string') return fromArgs
  }

  if (isRecord(result)) {
    const fromResult = [result.command, result.innerCommand, result.cmd]
      .find((entry) => typeof entry === 'string' && entry.trim().length > 0)
    if (typeof fromResult === 'string') return fromResult
  }

  return null
}

function isNativeBashToolName(toolName: string): boolean {
  const trimmed = toolName.trim()
  if (!trimmed) return false

  const doubleUnderscoreParts = trimmed.includes('__')
    ? trimmed.split('__').filter(Boolean)
    : []
  const doubleUnderscoreLeaf =
    doubleUnderscoreParts.length > 0 ? doubleUnderscoreParts[doubleUnderscoreParts.length - 1] : null
  const dotParts = trimmed.includes('.')
    ? trimmed.split('.').filter(Boolean)
    : []
  const dotLeaf = dotParts.length > 0 ? dotParts[dotParts.length - 1] : trimmed
  const leaf = doubleUnderscoreLeaf || dotLeaf || trimmed

  return leaf === 'native_bash_execute' || leaf === 'batshit_server_bash_execute'
}

export function resolveNativeBashMapping(options: {
  toolName?: string | null
  args?: Record<string, any> | null
  result?: any
}): {
  mappedToolName: BashToolMapping['toolName']
  mappedArgs: Record<string, any>
  reason: string
  command: string
} | null {
  const originalToolName = options.toolName?.trim()
  if (!originalToolName || !isNativeBashToolName(originalToolName)) {
    return null
  }

  const command = resolveCommandCandidate(options.args ?? null, options.result)
  if (!command) return null

  const mapped = mapBashCommandToRendererTool(command)

  return {
    mappedToolName: mapped.toolName,
    mappedArgs: {
      ...(mapped.args || {}),
      originalToolName: originalToolName
    },
    reason: mapped.reason,
    command
  }
}

export function mapBashCommandToMode4Tool(command: string): Mode4BashToolMapping {
  const mapped = mapBashCommandToRendererTool(command)

  if (mapped.toolName === 'native_bash_execute') {
    return {
      toolName: 'batshit_server_execute_command',
      args: mapped.args,
      reason: mapped.reason
    }
  }

  return {
    toolName: mapped.toolName,
    args: mapped.args,
    reason: mapped.reason
  }
}
