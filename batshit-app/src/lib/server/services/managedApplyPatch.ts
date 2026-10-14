import {
  lexShellCommands,
  shellProgramWord,
  shellTextRunsProgram,
  substitutionsInExpandedText,
  type ShellLexCommand
} from './shellCommandLexer'

export const APPLY_PATCH_BEGIN_MARKER = '*** Begin Patch'
export const APPLY_PATCH_END_MARKER = '*** End Patch'
export const APPLY_PATCH_UPDATE_PREFIX = '*** Update File: '
export const APPLY_PATCH_ADD_PREFIX = '*** Add File: '
export const APPLY_PATCH_DELETE_PREFIX = '*** Delete File: '
export const APPLY_PATCH_MOVE_PREFIX = '*** Move to: '

export type ManagedApplyPatchLineType = 'context' | 'add' | 'remove'

export interface ManagedApplyPatchHunkLine {
  type: ManagedApplyPatchLineType
  text: string
  sourceText?: string
}

export interface ManagedApplyPatchHunk {
  header: string
  lines: ManagedApplyPatchHunkLine[]
}

export interface ManagedApplyPatchUpdateOperation {
  type: 'update'
  filePath: string
  moveToPath: string | null
  hunks: ManagedApplyPatchHunk[]
}

export interface ManagedApplyPatchAddOperation {
  type: 'add'
  filePath: string
  contentLines: string[]
}

export interface ManagedApplyPatchDeleteOperation {
  type: 'delete'
  filePath: string
}

export type ManagedApplyPatchOperation =
  | ManagedApplyPatchUpdateOperation
  | ManagedApplyPatchAddOperation
  | ManagedApplyPatchDeleteOperation

export type ManagedApplyPatchParseResult =
  | {
      success: true
      operations: ManagedApplyPatchOperation[]
      touchedPaths: string[]
    }
  | {
      success: false
      operations: []
      touchedPaths: []
      message: string
    }

function normalizeManagedPatchInput(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

/**
 * BL-244 / BL-252 (2026-09-25): the ONE reading of a Bash command that uses the managed
 * `apply_patch`. Batshit applies the patch itself and no shell ever runs the command, so the
 * command must be nothing but the patch: optional `set -e`-style lines, an optional
 * `cd <folder>` (on its own line, or `cd <folder> &&` in front of `apply_patch`), optional
 * variable assignments, then `apply_patch` with the patch as a heredoc, a quoted argument, or
 * bare lines, and nothing after it but blank or comment lines.
 *
 * - `managed`: apply the patch, in `cdPath` when one is given (the executor resolves it and keeps
 *   it inside the workspace root). `document` is null when no `*** Begin Patch` / `*** End Patch`
 *   pair is present, which the executor reports as before.
 * - `refused`: the command uses `apply_patch` in some other way (a test after it, input piped
 *   into it, a redirect on its line, a `cd` it cannot follow). Nothing may run: before, every
 *   other line was silently dropped while the result said the command succeeded (BL-252).
 * - `none`: the command never runs `apply_patch` (`which apply_patch`, `grep apply_patch x`, a
 *   heredoc body that mentions it), so it is an ordinary shell command.
 */
export type ManagedApplyPatchCommand =
  | { kind: 'none' }
  | { kind: 'managed'; cdPath: string | null; document: string | null }
  | { kind: 'refused'; reason: string }

const SETUP_FLAGS = /^(?:[-+][euxv]*o pipefail|[-+][euxv]+)(?: (?:[-+][euxv]*o pipefail|[-+][euxv]+))*$/

const MANAGED_PATCH_WHOLE_COMMAND_RULE =
  'apply_patch must be the whole command (optionally after `cd <folder> &&`): Batshit applies the patch itself and runs nothing else in it. Nothing ran.'

function isIgnorableManagedPatchLine(line: string): boolean {
  const trimmed = line.trim()
  return !trimmed || trimmed.startsWith('#')
}

function clipManagedPatchLine(text: string): string {
  const firstLine = text.trim().split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine
}

function refuseExtraCommand(text: string): ManagedApplyPatchCommand {
  return {
    kind: 'refused',
    reason: `${MANAGED_PATCH_WHOLE_COMMAND_RULE} Send the patch by itself, then run the rest in a separate call: \`${clipManagedPatchLine(text)}\``
  }
}

function refuseCd(): ManagedApplyPatchCommand {
  return {
    kind: 'refused',
    reason:
      'The `cd` before apply_patch must name one folder, with no variables, `~`, wildcards, options, or spaces at either end, and at most one `cd`, followed by `&&` or a new line. Nothing ran.'
  }
}

function refuseApplyPatchLine(detail: string): ManagedApplyPatchCommand {
  return {
    kind: 'refused',
    reason: `apply_patch takes the patch as a heredoc (\`apply_patch <<'PATCH'\`, the patch, then \`PATCH\`) or as one quoted argument, with nothing else on its line: ${detail}. Nothing ran.`
  }
}

function isSetupCommand(command: ShellLexCommand): boolean {
  return (
    command.words[0]?.text === 'set' &&
    command.words.length > 1 &&
    !command.words.some((word) => word.expands) &&
    command.redirects.length === 0 &&
    command.heredocs.length === 0 &&
    SETUP_FLAGS.test(command.words.slice(1).map((word) => word.text).join(' '))
  )
}

function isApplyPatchCommand(command: ShellLexCommand | undefined): boolean {
  const program = command ? shellProgramWord(command) : null
  return program?.word.text === 'apply_patch' && !program.word.expands
}

/** The source from a command's start: a refusal names its whole first line (`node --test … | tail -5`). */
/** `exit` or `exit <number>` right after `||`: the guard of `cd <folder> || exit 1`. */
function isExitGuard(command: ShellLexCommand | undefined): boolean {
  if (!command || command.precededBy !== '||' || command.words[0]?.text !== 'exit') return false
  const [, code, ...extra] = command.words
  return (
    extra.length === 0 &&
    (code === undefined || (!code.expands && /^\d+$/.test(code.text))) &&
    command.redirects.length === 0 &&
    command.heredocs.length === 0
  )
}

/** `apply_patch` (after assignments) with no argument, redirect, or heredoc: the bare form. */
function isBareApplyPatch(command: ShellLexCommand): boolean {
  const program = shellProgramWord(command)
  return (
    program !== null &&
    program.index === command.words.length - 1 &&
    command.redirects.length === 0 &&
    command.heredocs.length === 0
  )
}

function commandText(source: string, command: ShellLexCommand): string {
  return source.slice(command.start)
}

/**
 * The patch in a heredoc body or quoted argument: only the text from `*** Begin Patch` to
 * `*** End Patch`, with blank lines around it. Anything else in it is refused rather than dropped
 * (an unclosed heredoc swallows the lines after it as data). Null when there is no patch at all,
 * which the executor reports as a missing payload.
 */
function readPatchDocument(body: string): { document: string | null } | { refused: ManagedApplyPatchCommand } {
  const lines = body.split('\n')
  const first = lines.findIndex((line) => line.trim().length > 0)
  let last = -1
  for (let line = lines.length - 1; line >= 0; line -= 1) {
    if (lines[line].trim().length > 0) {
      last = line
      break
    }
  }
  if (first === -1) return { document: null }
  const document = extractManagedApplyPatchPayload(body)
  if (document === null) return { document: null }
  if (lines[first].trim() !== APPLY_PATCH_BEGIN_MARKER) {
    return { refused: refuseApplyPatchLine(`the patch must start at \`${APPLY_PATCH_BEGIN_MARKER}\`, found \`${clipManagedPatchLine(lines[first])}\` before it`) }
  }
  if (lines[last].trim() !== APPLY_PATCH_END_MARKER) {
    return { refused: refuseApplyPatchLine(`the patch must end at \`${APPLY_PATCH_END_MARKER}\`, found \`${clipManagedPatchLine(lines[last])}\` after it (is the heredoc's closing line missing?)`) }
  }
  return { document }
}

export function parseManagedApplyPatchCommand(command: string): ManagedApplyPatchCommand {
  const source = normalizeManagedPatchInput(command)
  if (!shellTextRunsProgram(source, 'apply_patch')) return { kind: 'none' }
  let commands = lexShellCommands(source)
  // BL-262: bare patch lines after an `apply_patch` line are data, never commands (a `(` in
  // `function hello()` is not a subshell). When the first apply_patch has nothing after its name
  // and ends its line, only the text up to that line is read as commands.
  let bareBody: string | null = null
  const firstPatch = commands.find((entry) => isApplyPatchCommand(entry))
  if (firstPatch && isBareApplyPatch(firstPatch) && firstPatch.separator === '\n') {
    bareBody = source.slice(firstPatch.end + 1)
    commands = lexShellCommands(source.slice(0, firstPatch.end))
  }
  // A subshell or group around any part of it is not a whole-command patch.
  const grouped = commands.find(
    (entry) => entry.precededBy === '(' || entry.precededBy === ')' || entry.separator === '(' || entry.separator === ')'
  )
  if (grouped) return refuseExtraCommand(source)
  const startsLine = (entry: ShellLexCommand) => entry.precededBy === null || entry.precededBy === '\n'

  // Before the patch only `set -e`-style lines and one `cd <folder>`, each on its own line or
  // joined to the next by `&&`; `set` changes nothing for a patch Batshit applies itself.
  const joinedToNext = (entry: ShellLexCommand) => entry.separator === '&&' || entry.separator === '\n'
  const followsPrefix = (entry: ShellLexCommand) => startsLine(entry) || entry.precededBy === '&&'
  let index = 0
  let cdPath: string | null = null
  while (index < commands.length) {
    const entry = commands[index]
    if (isSetupCommand(entry) && followsPrefix(entry) && joinedToNext(entry)) {
      index += 1
      continue
    }
    if (entry.words[0]?.text !== 'cd') break
    const folder = entry.words[1]
    const literal =
      entry.words.length === 2 &&
      entry.redirects.length === 0 &&
      entry.heredocs.length === 0 &&
      folder !== undefined &&
      !folder.expands &&
      folder.text.length > 0 &&
      !folder.text.startsWith('-') &&
      folder.text === folder.text.trim() // BL-254: a folder with spaces at either end is refused
    // `cd <folder> || exit [n]` (seen in SA-126 B0) says what the executor already does: a folder
    // that is missing stops the command before anything runs.
    let joiner = entry
    if (entry.separator === '||' && isExitGuard(commands[index + 1])) {
      joiner = commands[index + 1]
      index += 1
    }
    if (cdPath !== null || !literal || !followsPrefix(entry) || !joinedToNext(joiner)) return refuseCd()
    cdPath = folder.text
    index += 1
  }

  // Then apply_patch itself, and nothing after it.
  const applyPatch = commands[index]
  if (!isApplyPatchCommand(applyPatch)) {
    return refuseExtraCommand(applyPatch ? commandText(source, applyPatch) : source)
  }
  // It starts its own line, or follows the prefix it was joined to with `&&`.
  if (!startsLine(applyPatch) && !(index > 0 && applyPatch.precededBy === '&&')) return refuseExtraCommand(source)
  const nameIndex = shellProgramWord(applyPatch)!.index
  // BL-261: `CHECK=$(touch x) apply_patch ...` would run `touch x` in a shell; Batshit applies the
  // patch itself, so an assignment the shell would expand is refused, never silently skipped.
  // Literal assignments (`LC_ALL=C`) change nothing and stay allowed.
  if (applyPatch.words.slice(0, nameIndex).some((word) => word.expands)) {
    return refuseApplyPatchLine('no variable assignments that expand or run commands (`$`, `$(…)`, backticks) before it')
  }
  const args = applyPatch.words.slice(nameIndex + 1)
  if (applyPatch.redirects.length > 0) return refuseApplyPatchLine('no redirects')
  if (applyPatch.heredocs.length > 1 || args.length > 1 || (args.length === 1 && applyPatch.heredocs.length === 1)) {
    return refuseApplyPatchLine('one patch, as one heredoc or one quoted argument')
  }
  const rest = commands.slice(index + 1)
  const endsAlone = applyPatch.separator === null || applyPatch.separator === '\n'

  let body: string
  if (applyPatch.heredocs.length === 1) {
    const heredoc = applyPatch.heredocs[0]
    // With an unquoted delimiter the shell would run `$(…)` and backticks in the body; Batshit
    // applies the body as written, so such a body is refused rather than its commands dropped.
    if (!heredoc.quoted && substitutionsInExpandedText(heredoc.body).length > 0) {
      return refuseApplyPatchLine(
        "the heredoc has an unquoted delimiter and its text holds `$(…)` or backticks, which a shell would run: quote the delimiter (`apply_patch <<'PATCH'`)"
      )
    }
    body = heredoc.body
  } else if (args.length === 1) {
    if (args[0].text.trimStart().startsWith('-')) return refuseApplyPatchLine('no flags')
    // The shell would change a double-quoted patch with `$` or a backtick before apply_patch saw it.
    if (args[0].expands) return refuseApplyPatchLine('a quoted patch must not contain `$` expansions or backticks')
    body = args[0].text
  } else {
    // Bare patch lines after an `apply_patch` line. They are data, never commands, so they are
    // read as raw lines: a first `*** Begin Patch`, a last `*** End Patch`, and nothing after it.
    const after = bareBody ?? ''
    const lines = after.split('\n')
    const first = lines.findIndex((line) => !isIgnorableManagedPatchLine(line))
    if (first === -1) return endsAlone ? { kind: 'managed', cdPath, document: null } : refuseExtraCommand(rest[0] ? commandText(source, rest[0]) : String(applyPatch.separator))
    if (lines[first].trim() !== APPLY_PATCH_BEGIN_MARKER) {
      return refuseExtraCommand(rest[0] ? commandText(source, rest[0]) : lines[first])
    }
    let last = -1
    for (let line = lines.length - 1; line >= first; line -= 1) {
      if (lines[line].trim() === APPLY_PATCH_END_MARKER) {
        last = line
        break
      }
    }
    const extra = last === -1 ? null : lines.slice(last + 1).find((line) => !isIgnorableManagedPatchLine(line))
    if (extra) return refuseExtraCommand(extra)
    return { kind: 'managed', cdPath, document: extractManagedApplyPatchPayload(lines.slice(first).join('\n')) }
  }

  if (!endsAlone || rest.length > 0) {
    return refuseExtraCommand(rest[0] ? commandText(source, rest[0]) : String(applyPatch.separator))
  }
  const read = readPatchDocument(body)
  if ('refused' in read) return read.refused
  return { kind: 'managed', cdPath, document: read.document }
}

/** True when the command runs `apply_patch` at all: Batshit then applies it or refuses it, and no shell runs it. */
export function isManagedApplyPatchCommand(command: string): boolean {
  return parseManagedApplyPatchCommand(command).kind !== 'none'
}

export function extractManagedApplyPatchPayload(source: string): string | null {
  const normalized = normalizeManagedPatchInput(source)
  const beginIndex = normalized.indexOf(APPLY_PATCH_BEGIN_MARKER)
  const endIndex = normalized.lastIndexOf(APPLY_PATCH_END_MARKER)
  if (beginIndex < 0 || endIndex < beginIndex) return null
  return normalized.slice(beginIndex, endIndex + APPLY_PATCH_END_MARKER.length)
}

/** The patch of a command Batshit will apply; null for any other command, including a refused one. */
export function extractManagedApplyPatchDocument(command: string): string | null {
  const parsed = parseManagedApplyPatchCommand(command)
  return parsed.kind === 'managed' ? parsed.document : null
}

function parseManagedApplyPatchPath(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) return null
  const rawPath = line.slice(prefix.length).trim()
  if (!rawPath) return null
  return rawPath.replace(/^['"]|['"]$/g, '')
}

function isManagedApplyPatchOpStart(line: string): boolean {
  return (
    line.startsWith(APPLY_PATCH_UPDATE_PREFIX) ||
    line.startsWith(APPLY_PATCH_ADD_PREFIX) ||
    line.startsWith(APPLY_PATCH_DELETE_PREFIX)
  )
}

export function parseManagedApplyPatchDocument(document: string): ManagedApplyPatchParseResult {
  const normalized = normalizeManagedPatchInput(document)
  const lines = normalized.split('\n')
  if (lines.length < 2) {
    return {
      success: false,
      operations: [],
      touchedPaths: [],
      message: 'apply_patch payload is incomplete.'
    }
  }

  if (lines[0].trim() !== APPLY_PATCH_BEGIN_MARKER) {
    return {
      success: false,
      operations: [],
      touchedPaths: [],
      message: 'apply_patch payload must start with "*** Begin Patch".'
    }
  }

  if (lines[lines.length - 1].trim() !== APPLY_PATCH_END_MARKER) {
    return {
      success: false,
      operations: [],
      touchedPaths: [],
      message: 'apply_patch payload must end with "*** End Patch".'
    }
  }

  const operations: ManagedApplyPatchOperation[] = []
  let index = 1
  const lastContentIndex = lines.length - 1

  while (index < lastContentIndex) {
    const current = lines[index]
    if (!current || current.trim().length === 0) {
      index += 1
      continue
    }

    if (current.startsWith(APPLY_PATCH_UPDATE_PREFIX)) {
      const filePath = parseManagedApplyPatchPath(current, APPLY_PATCH_UPDATE_PREFIX)
      if (!filePath) {
        return {
          success: false,
          operations: [],
          touchedPaths: [],
          message: 'Invalid "*** Update File" path in apply_patch payload.'
        }
      }

      index += 1
      let moveToPath: string | null = null
      if (index < lastContentIndex && lines[index].startsWith(APPLY_PATCH_MOVE_PREFIX)) {
        moveToPath = parseManagedApplyPatchPath(lines[index], APPLY_PATCH_MOVE_PREFIX)
        if (!moveToPath) {
          return {
            success: false,
            operations: [],
            touchedPaths: [],
            message: 'Invalid "*** Move to" path in apply_patch payload.'
          }
        }
        index += 1
      }

      const hunks: ManagedApplyPatchHunk[] = []
      while (index < lastContentIndex) {
        const line = lines[index]
        if (isManagedApplyPatchOpStart(line)) break
        if (line.startsWith('@@')) {
          const header = line
          index += 1
          const hunkLines: ManagedApplyPatchHunkLine[] = []

          while (index < lastContentIndex) {
            const bodyLine = lines[index]
            if (bodyLine.startsWith('@@') || isManagedApplyPatchOpStart(bodyLine)) break
            if (bodyLine === '*** End of File' || bodyLine === '\\ No newline at end of file') {
              index += 1
              continue
            }

            const prefix = bodyLine.charAt(0)
            const text = bodyLine.slice(1)
            if (prefix === ' ') {
              hunkLines.push({ type: 'context', text, sourceText: bodyLine })
            } else if (prefix === '+') {
              hunkLines.push({ type: 'add', text })
            } else if (prefix === '-') {
              hunkLines.push({ type: 'remove', text })
            } else {
              hunkLines.push({ type: 'context', text: bodyLine, sourceText: bodyLine })
            }
            index += 1
          }

          hunks.push({ header, lines: hunkLines })
          continue
        }

        if (line === '*** End of File') {
          index += 1
          continue
        }

        return {
          success: false,
          operations: [],
          touchedPaths: [],
          message: `Unexpected line in "*** Update File" section: "${line}".`
        }
      }

      if (hunks.length === 0 && !moveToPath) {
        return {
          success: false,
          operations: [],
          touchedPaths: [],
          message:
            'apply_patch update operation requires at least one hunk or a "*** Move to" path.'
        }
      }

      operations.push({
        type: 'update',
        filePath,
        moveToPath,
        hunks
      })
      continue
    }

    if (current.startsWith(APPLY_PATCH_ADD_PREFIX)) {
      const filePath = parseManagedApplyPatchPath(current, APPLY_PATCH_ADD_PREFIX)
      if (!filePath) {
        return {
          success: false,
          operations: [],
          touchedPaths: [],
          message: 'Invalid "*** Add File" path in apply_patch payload.'
        }
      }

      index += 1
      const contentLines: string[] = []
      while (index < lastContentIndex && !isManagedApplyPatchOpStart(lines[index])) {
        const line = lines[index]
        if (line === '*** End of File') {
          index += 1
          continue
        }
        if (!line.startsWith('+')) {
          return {
            success: false,
            operations: [],
            touchedPaths: [],
            message: `Invalid line in "*** Add File" section: "${line}".`
          }
        }
        contentLines.push(line.slice(1))
        index += 1
      }

      operations.push({
        type: 'add',
        filePath,
        contentLines
      })
      continue
    }

    if (current.startsWith(APPLY_PATCH_DELETE_PREFIX)) {
      const filePath = parseManagedApplyPatchPath(current, APPLY_PATCH_DELETE_PREFIX)
      if (!filePath) {
        return {
          success: false,
          operations: [],
          touchedPaths: [],
          message: 'Invalid "*** Delete File" path in apply_patch payload.'
        }
      }

      index += 1
      while (index < lastContentIndex && !isManagedApplyPatchOpStart(lines[index])) {
        const line = lines[index]
        if (!line || line.trim().length === 0 || line === '*** End of File') {
          index += 1
          continue
        }
        return {
          success: false,
          operations: [],
          touchedPaths: [],
          message: `Unexpected content in "*** Delete File" section: "${line}".`
        }
      }

      operations.push({
        type: 'delete',
        filePath
      })
      continue
    }

    return {
      success: false,
      operations: [],
      touchedPaths: [],
      message: `Unexpected apply_patch line: "${current}".`
    }
  }

  if (operations.length === 0) {
    return {
      success: false,
      operations: [],
      touchedPaths: [],
      message: 'apply_patch payload did not include any operations.'
    }
  }

  const touchedPaths = Array.from(
    new Set(
      operations.flatMap((operation) =>
        operation.type === 'update' && operation.moveToPath
          ? [operation.filePath, operation.moveToPath]
          : [operation.filePath]
      )
    )
  )

  return {
    success: true,
    operations,
    touchedPaths
  }
}

function splitManagedPatchText(
  content: string
): { lines: string[]; hasTrailingNewline: boolean } {
  const normalized = normalizeManagedPatchInput(content)
  if (normalized.length === 0) {
    return {
      lines: [],
      hasTrailingNewline: false
    }
  }

  const hasTrailingNewline = normalized.endsWith('\n')
  const lines = normalized.split('\n')
  if (hasTrailingNewline) lines.pop()
  return {
    lines,
    hasTrailingNewline
  }
}

function joinManagedPatchLines(lines: string[], hasTrailingNewline: boolean): string {
  if (lines.length === 0) return ''
  const joined = lines.join('\n')
  return hasTrailingNewline ? `${joined}\n` : joined
}

function findManagedPatchSequence(
  source: string[],
  target: string[],
  startIndex: number
): number {
  if (target.length === 0) return Math.min(startIndex, source.length)
  const maxStart = source.length - target.length
  for (let index = Math.max(0, startIndex); index <= maxStart; index += 1) {
    let matched = true
    for (let offset = 0; offset < target.length; offset += 1) {
      if (source[index + offset] !== target[offset]) {
        matched = false
        break
      }
    }
    if (matched) return index
  }
  return -1
}

function buildManagedPatchCandidate(hunk: ManagedApplyPatchHunk, useSourceText: boolean): {
  sourcePattern: string[]
  replacement: string[]
} {
  const textForLine = (line: ManagedApplyPatchHunkLine): string =>
    useSourceText && line.type === 'context'
      ? line.sourceText ?? line.text
      : line.text

  return {
    sourcePattern: hunk.lines
      .filter((line) => line.type !== 'add')
      .map((line) => textForLine(line)),
    replacement: hunk.lines
      .filter((line) => line.type !== 'remove')
      .map((line) => textForLine(line))
  }
}

function buildManagedPatchCandidates(hunk: ManagedApplyPatchHunk): Array<{
  sourcePattern: string[]
  replacement: string[]
}> {
  const strict = buildManagedPatchCandidate(hunk, false)
  const copiedContext = buildManagedPatchCandidate(hunk, true)

  if (
    strict.sourcePattern.length === copiedContext.sourcePattern.length &&
    strict.replacement.length === copiedContext.replacement.length &&
    strict.sourcePattern.every((line, index) => line === copiedContext.sourcePattern[index]) &&
    strict.replacement.every((line, index) => line === copiedContext.replacement[index])
  ) {
    return [strict]
  }

  return [strict, copiedContext]
}

export function applyManagedPatchHunks(options: {
  content: string
  hunks: ManagedApplyPatchHunk[]
  filePath: string
}): string {
  const parsed = splitManagedPatchText(options.content)
  const lines = parsed.lines.slice()
  let cursor = 0

  for (const hunk of options.hunks) {
    const candidates = buildManagedPatchCandidates(hunk)
    let match:
      | {
          targetIndex: number
          sourcePattern: string[]
          replacement: string[]
        }
      | null = null

    for (const candidate of candidates) {
      let targetIndex = findManagedPatchSequence(lines, candidate.sourcePattern, cursor)
      if (targetIndex < 0) {
        targetIndex = findManagedPatchSequence(lines, candidate.sourcePattern, 0)
      }
      if (targetIndex >= 0) {
        match = {
          targetIndex,
          sourcePattern: candidate.sourcePattern,
          replacement: candidate.replacement
        }
        break
      }
    }

    if (!match) {
      throw new Error(
        `Failed to apply hunk "${hunk.header}" in ${options.filePath}: context did not match.`
      )
    }

    lines.splice(match.targetIndex, match.sourcePattern.length, ...match.replacement)
    cursor = match.targetIndex + match.replacement.length
  }

  return joinManagedPatchLines(lines, parsed.hasTrailingNewline)
}
