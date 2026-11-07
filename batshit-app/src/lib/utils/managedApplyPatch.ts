import {
  lexShellCommands,
  shellProgramWord,
  shellTextRunsProgram,
  substitutionsInExpandedText,
  type ShellLexCommand,
  type ShellLexSeparator
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
 * bare lines. After a heredoc or quoted patch, commands on the following lines or after `&&` are
 * named in the result and never run (BL-1915); after bare lines, nothing but blank or comment lines.
 *
 * - `managed`: apply the patch, in `cdPath` when one is given (the executor resolves it and keeps
 *   it inside the workspace root). `document` is null when no `*** Begin Patch` / `*** End Patch`
 *   pair is present, which the executor reports as before. `notRun` lists the commands written
 *   after the patch (BL-1915): they are never run, and the result names them.
 *   `afterPatch` (SA-126 item 2, `readAfterPatch`) is what a caller may run after the whole patch
 *   applied: the rest of the `apply_patch` line after `&&` and the lines after the patch, when
 *   every one is in the supported grammar. A caller that does not run it names those commands as
 *   `notRun` (BL-1915), which is always set for them.
 * - `refused`: the command uses `apply_patch` in some other way (a test after it, input piped
 *   into it, a redirect on its line, a `cd` it cannot follow). Nothing may run: before, every
 *   other line was silently dropped while the result said the command succeeded (BL-252).
 * - `none`: the command never runs `apply_patch` (`which apply_patch`, `grep apply_patch x`, a
 *   heredoc body that mentions it), so it is an ordinary shell command.
 */
export type ManagedApplyPatchCommand =
  | { kind: 'none' }
  | { kind: 'managed'; cdPath: string | null; document: string | null; notRun?: string[];
      afterPatch?: Readonly<{ command: string; tail: string }>
      notRunReason?: AfterPatchNotRunReason
      payloadRange?: Readonly<{ start: number; end: number }> }
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

/**
 * BL-1990 review: a fault in the patch text itself (where it starts or ends), whatever stands on the
 * apply_patch line (`cd <folder> &&` before it, commands after it, both valid).
 */
function refusePatchText(detail: string): ManagedApplyPatchCommand {
  return {
    kind: 'refused',
    reason: `apply_patch's patch runs from \`${APPLY_PATCH_BEGIN_MARKER}\` to \`${APPLY_PATCH_END_MARKER}\`: ${detail}. Nothing ran.`
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

/** BL-1915: the commands after a patch, one entry per line they start on, clipped to that line. */
function trailingCommandLines(source: string, rest: ShellLexCommand[]): string[] {
  const lines: string[] = []
  let start = rest[0].start
  rest.forEach((command, index) => {
    const next = rest[index + 1]
    // A command joined by an operator stays on the entry, unless it starts on a later line (an
    // `&&` at the end of the apply_patch line continues after the heredoc's body).
    if (next && next.precededBy !== '\n' && !source.slice(command.end, next.start).includes('\n')) return
    lines.push(clipManagedPatchLine(source.slice(start, command.end)))
    if (next) start = next.start
  })
  return lines
}

/**
 * The patch in a heredoc body or quoted argument: only the text from `*** Begin Patch` to
 * `*** End Patch`, with blank lines around it. Anything else in it is refused rather than dropped
 * (an unclosed heredoc swallows the lines after it as data). Null when there is no patch at all,
 * which the executor reports as a missing payload.
 */
function readPatchDocument(
  body: string,
  commandsFollow = false
): { document: string | null } | { refused: ManagedApplyPatchCommand } {
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
  // BL-1990: a patch that starts but never ends is that fault, not "the whole command" (a command
  // after the patch is a valid shape since SA-126 item 2): name the missing line.
  if (document === null && lines.some((line) => line.trim() === APPLY_PATCH_BEGIN_MARKER)) {
    return { refused: refusePatchText(`it has \`${APPLY_PATCH_BEGIN_MARKER}\` but no \`${APPLY_PATCH_END_MARKER}\` line after it; add \`${APPLY_PATCH_END_MARKER}\` as the patch's last line`) }
  }
  if (document === null) return { document: null }
  if (lines[first].trim() !== APPLY_PATCH_BEGIN_MARKER) {
    return { refused: refusePatchText(`it must start at \`${APPLY_PATCH_BEGIN_MARKER}\`, found \`${clipManagedPatchLine(lines[first])}\` before it`) }
  }
  if (lines[last].trim() !== APPLY_PATCH_END_MARKER) {
    // With commands after the patch the heredoc did close (an unclosed one swallows them), so the
    // hint about its closing line is only true without them (BL-1990 review).
    return { refused: refusePatchText(`it must end at \`${APPLY_PATCH_END_MARKER}\`, found \`${clipManagedPatchLine(lines[last])}\` after it${commandsFollow ? '' : " (is the heredoc's closing line missing?)"}`) }
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
  // A subshell or group around the patch, or around anything before it, is not a whole-command
  // patch. One in the commands after it is plain shell text (SA-126 item 2b).
  const patchIndex = commands.findIndex((entry) => isApplyPatchCommand(entry))
  const grouped = commands.slice(0, patchIndex === -1 ? commands.length : patchIndex + 1).find(
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
  let payloadRange: Readonly<{ start: number; end: number }>
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
    payloadRange = { start: heredoc.bodyStart, end: heredoc.bodyEnd }
  } else if (args.length === 1) {
    if (args[0].text.trimStart().startsWith('-')) return refuseApplyPatchLine('no flags')
    // The shell would change a double-quoted patch with `$` or a backtick before apply_patch saw it.
    if (args[0].expands) return refuseApplyPatchLine('a quoted patch must not contain `$` expansions or backticks')
    body = args[0].text
    payloadRange = { start: args[0].start, end: args[0].end }
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
    const document = extractManagedApplyPatchPayload(lines.slice(first).join('\n'))
    const start = applyPatch.end + 1 + lines.slice(0, first).reduce((length, line) => length + line.length + 1, 0) +
      lines[first].indexOf(APPLY_PATCH_BEGIN_MARKER)
    return { kind: 'managed', cdPath, document,
      ...(document ? { payloadRange: { start, end: start + document.length } } : {}) }
  }

  const read = readPatchDocument(body, rest.length > 0)
  if (rest.length === 0) {
    if (!endsAlone) return refuseExtraCommand(String(applyPatch.separator))
    if ('refused' in read) return read.refused
    return { kind: 'managed', cdPath, document: read.document, ...(read.document ? { payloadRange } : {}) }
  }
  // BL-1915 (Faye, 2026-10-20): commands after the patch, on the lines after it or joined to it by
  // `&&`, are the model's next step, most often a test run (over every SA-126 Batshit try, 738
  // such commands put it on the lines after the heredoc and 2 after `&&`). The patch is applied
  // and they are never run; the result names them, so nothing is silently dropped
  // (BL-252). SA-126 item 2b (Faye, 2026-10-21): `;` and `||` on the apply_patch line join them
  // too (`||` is then named as not run, `readAfterPatch`). A pipe or `&` on the apply_patch line,
  // a second patch, and a command without a patch are still refused.
  const trailingText = commandText(source, rest[0])
  // Each command's own text only: with `&&` on the marker line, the patch's heredoc body comes
  // after the command in the source, and it is data (a patch may mention apply_patch).
  const runsAnotherPatch = rest.some((command) => shellTextRunsProgram(source.slice(command.start, command.end), 'apply_patch'))
  const joinsAfterPatch = applyPatch.separator === '\n' || applyPatch.separator === '&&' ||
    applyPatch.separator === ';' || applyPatch.separator === '||'
  if (!joinsAfterPatch || runsAnotherPatch) return refuseExtraCommand(trailingText)
  // BL-1990: a patch whose own text is wrong (no end line, text around it) says that fault; the
  // command after it is a valid shape since SA-126 item 2. A body with no patch at all still gets
  // the whole-command rule (BL-1993).
  if ('refused' in read) return read.refused
  if (read.document === null) return refuseExtraCommand(trailingText)
  const managed = { kind: 'managed' as const, cdPath, document: read.document, payloadRange, notRun: trailingCommandLines(source, rest) }
  const reading = readAfterPatch(source, commands.slice(0, index), applyPatch, rest)
  return 'reason' in reading ? { ...managed, notRunReason: reading.reason } : { ...managed, afterPatch: reading }
}

/**
 * Why the commands after a patch are not run, for the result's `Not run:` line (deep review of
 * SA-126 item 2): a quoted patch (only a heredoc patch runs its commands), an Agent Browser command,
 * `||` right after the patch (a shell runs that only when the patch fails), or the grammar (a
 * background `&`, a heredoc of their own, a `\` continuation into the patch, an open chain).
 */
export type AfterPatchNotRunReason = 'quoted-patch' | 'agent-browser' | 'or-after-patch' | 'grammar'

/**
 * SA-126 item 2 (Ashe's execution contract; Faye, 2026-10-21): the commands a caller may run after
 * the whole patch applied, or null when any of them is outside the supported grammar (then every
 * one is named as not run, BL-1915). Two places, both after a heredoc patch:
 *
 * - the rest of the `apply_patch` line after `&&` or `;` (`apply_patch <<'PATCH' && npm test`);
 * - the lines after the closing delimiter (`PATCH`, then `npm test`).
 *
 * Item 2b (Faye, 2026-10-21, from the A3 smoke, where Opus's tails used `;` and redirects): they
 * are plain shell text, as a plain command may be (`;`, `&&`, `||`, pipes, redirects, `$(…)`,
 * subshells, loops), except a background `&` (so the result reports what finished; it is not
 * containment: a background start hidden in a word, `bash -c 'x &'`, is the same as in a plain
 * command, ended by Stop with the managed process group), a heredoc of
 * their own, a `\` continuation from the apply_patch line into the patch, and a chain left open.
 * Both places may be used; the apply_patch line's part comes first. Batshit runs them as one text
 * in the same shell, after the leading `set` lines (their exact text), so each line runs as a
 * shell runs a script's lines. The one stated difference from a shell: they run only after the
 * whole patch applied, so after a patch that did not apply none of them runs, whatever joins them
 * to it (`;` and the newline included). `||` right after the patch is the exception: a shell runs
 * that command only when the patch fails, so running it after a success would invert it; it is
 * named as not run.
 *
 * `command` is what runs; `tail` is the same text without the carried `set` lines (for the
 * approval card and refusals). Both are exact source text, never the clipped `notRun` names.
 */
function readAfterPatch(
  source: string,
  prefix: ShellLexCommand[],
  applyPatch: ShellLexCommand,
  rest: ShellLexCommand[]
): { command: string; tail: string } | { reason: AfterPatchNotRunReason } {
  const grammar = { reason: 'grammar' as const }
  const heredoc = applyPatch.heredocs[0]
  if (!heredoc) return { reason: 'quoted-patch' }
  if (!heredoc.terminated || applyPatch.heredocs.length !== 1) return grammar
  if (applyPatch.separator === '||') return { reason: 'or-after-patch' }
  for (const command of rest) {
    if (command.heredocs.length > 0 || command.separator === '&') return grammar
    if (command.start > heredoc.bodyStart && command.start < heredoc.bodyEnd) return grammar
  }
  // The last command ends the text: an open `&&`, `||` or `|` would end in a shell error.
  const lastSeparator: ShellLexSeparator | null = rest[rest.length - 1].separator
  if (lastSeparator === '&&' || lastSeparator === '||' || lastSeparator === '|') return grammar
  const onLine = rest.filter((command) => command.start < heredoc.bodyStart)
  const afterLines = rest.filter((command) => command.start >= heredoc.bodyEnd)
  if (onLine.length + afterLines.length !== rest.length) return grammar
  if (onLine.length > 0) {
    // The apply_patch line's part ends that line, closed (the patch body starts on the next line):
    // no open chain, and no `\` continuation that would join the patch's first line to it.
    if (applyPatch.separator !== '&&' && applyPatch.separator !== ';') return grammar
    const lineText = source.slice(applyPatch.end, heredoc.bodyStart)
    const lastOnLine = onLine[onLine.length - 1]
    if (lastOnLine.end > heredoc.bodyStart || /\\\n/.test(lineText)) return grammar
    if (!/^[;)\s]*$/.test(source.slice(lastOnLine.end, heredoc.bodyStart))) return grammar
  }

  const parts: string[] = []
  // The rest of the apply_patch line after its `&&` or `;`, whole: a subshell's `(` and `)`, or a
  // closing `;`, sit outside the commands' own text.
  if (onLine.length > 0) parts.push(source.slice(applyPatch.end + String(applyPatch.separator).length, heredoc.bodyStart).trim())
  if (afterLines.length > 0) {
    // From the line after the closing delimiter to the end of the text.
    const delimiterLineEnd = source.indexOf('\n', heredoc.bodyEnd + 1)
    if (delimiterLineEnd < 0 || delimiterLineEnd >= afterLines[0].start) return grammar
    parts.push(source.slice(delimiterLineEnd + 1).trim())
  }
  const tail = parts.join('\n')
  // An Agent Browser command is not run after a patch: its runtime rewrites the whole command
  // and can choose another backend (`nativeBashExecute`).
  if (/\bagent-browser\b/.test(tail)) return { reason: 'agent-browser' }
  if (!tail) return grammar
  const setLines = prefix.filter((command) => command.words[0]?.text === 'set').map((command) => source.slice(command.start, command.end).trim())
  return { command: [...setLines, tail].join('\n'), tail }
}

/** The approval card's line for a command a patch runs after itself: its first line, and how many more. */
export function describeAfterPatchForApproval(tail: string): { firstLine: string; moreLines: number } {
  const lines = tail.split('\n').map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'))
  return { firstLine: lines[0] ?? tail.trim(), moreLines: Math.max(0, lines.length - 1) }
}

/**
 * SA-126 item 2: what the API lane's Bash approval card says at its top for a patch with commands
 * after it (`ChatMessage.svelte`, Faye 2026-10-21): the files and the first command, read by this
 * same parser from the exact input the card holds, on every view of the card (live, reload, a
 * second viewer). Null for any other command.
 */
export function describeManagedPatchApproval(command: string): { files: string[]; firstLine: string; moreLines: number } | null {
  const parsed = parseManagedApplyPatchCommand(command)
  if (parsed.kind !== 'managed' || !parsed.document || !parsed.afterPatch) return null
  const document = parseManagedApplyPatchDocument(parsed.document, { lenientAddFile: true })
  return { files: document.success ? document.touchedPaths : [], ...describeAfterPatchForApproval(parsed.afterPatch.tail) }
}

/** Omit only the payload consumed by this parser, not a later marker in command data.
 * Ranges belong to the same normalized source used for quotes, heredocs and bare lines. */
export function managedApplyPatchPolicySource(command: string, payloadText = '[managed apply_patch payload]'): string {
  const source = normalizeManagedPatchInput(command)
  const parsed = parseManagedApplyPatchCommand(source)
  if (parsed.kind !== 'managed' || !parsed.payloadRange) return source
  const { start, end } = parsed.payloadRange
  return `${source.slice(0, start)}${payloadText}${source.slice(end)}`
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

/**
 * The content lines of one `*** Add File` section, or the refusal for its first bad line.
 *
 * Strict (the patch grammar Codex defines, and what `fabric:sys.artifact.apply_patch` keeps): every
 * line starts with `+`. Lenient (BL-1915, the native Bash patch, Faye 2026-10-20): blank lines at
 * the section's end separate it from the next one; a blank line inside a `+` section is an empty
 * content line; a section with no `+` line at all is the file as written. A section that mixes `+`
 * lines with other text is refused, because stripping would corrupt content lines that really start
 * with `+`; so is one whose every line starts with a space (diff context lines, not a file).
 */
function readAddFileSection(lines: string[], lenient: boolean): { contentLines: string[] } | { message: string } {
  if (!lenient) {
    const invalid = lines.find((line) => !line.startsWith('+'))
    return invalid === undefined
      ? { contentLines: lines.map((line) => line.slice(1)) }
      : { message: `Invalid line in "*** Add File" section: "${invalid}".` }
  }
  const invalid = (line: string) => ({
    message: `Invalid line in "*** Add File" section: "${clipManagedPatchLine(line)}": every line in an Add File section must start with \`+\` (an empty line is \`+\`). Nothing was written.`
  })
  let end = lines.length
  while (end > 0 && lines[end - 1].trim().length === 0) end -= 1
  const section = lines.slice(0, end)
  if (!section.some((line) => line.startsWith('+'))) {
    const written = section.filter((line) => line.trim().length > 0)
    if (written.length > 0 && written.every((line) => line.startsWith(' '))) return invalid(written[0])
    return { contentLines: section }
  }
  const contentLines: string[] = []
  for (const line of section) {
    if (line.startsWith('+')) contentLines.push(line.slice(1))
    else if (line.trim().length === 0) contentLines.push('')
    else return invalid(line)
  }
  return { contentLines }
}

export function parseManagedApplyPatchDocument(
  document: string,
  options: { lenientAddFile?: boolean } = {}
): ManagedApplyPatchParseResult {
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
      const sectionLines: string[] = []
      while (index < lastContentIndex && !isManagedApplyPatchOpStart(lines[index])) {
        if (lines[index] !== '*** End of File') sectionLines.push(lines[index])
        index += 1
      }
      const section = readAddFileSection(sectionLines, options.lenientAddFile === true)
      if ('message' in section) {
        return {
          success: false,
          operations: [],
          touchedPaths: [],
          message: section.message
        }
      }

      operations.push({
        type: 'add',
        filePath,
        contentLines: section.contentLines
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

/** Every start index where `target` matches, from `startIndex` on. */
function findManagedPatchSequences(source: string[], target: string[], startIndex: number): number[] {
  if (target.length === 0) return [findManagedPatchSequence(source, target, startIndex)]
  const found: number[] = []
  for (let index = findManagedPatchSequence(source, target, startIndex); index >= 0; index = findManagedPatchSequence(source, target, index + 1)) {
    found.push(index)
  }
  return found
}

/**
 * The line a hunk's `@@` header names (`@@ function b() {`): the function or class it sits in, as
 * the apply_patch format defines it. A unified-diff header (`@@ -12,7 +12,8 @@ name`) gives its
 * section name. Empty for a bare `@@`.
 */
function managedPatchHunkAnchor(header: string): string {
  const rest = header.replace(/^@@/, '').trim()
  const unified = /^-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s*@@\s*(.*)$/.exec(rest)
  return (unified ? unified[1] : rest.replace(/\s*@@$/, '')).trim()
}

/** The first value in ascending `values` that is greater than `after`, or undefined. */
function firstManagedPatchIndexAfter(values: number[], after: number): number | undefined {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (values[middle] > after) high = middle
    else low = middle + 1
  }
  return values[low]
}

/** The lines that are an `@@` anchor (trimmed text equal to it) and the lines that start with it, read once. */
function findManagedPatchAnchorLines(lines: string[], anchor: string): { exact: number[]; prefix: number[] } {
  const exact: number[] = []
  const prefix: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === anchor) exact.push(index)
    else if (line.startsWith(anchor)) prefix.push(index)
  }
  return { exact, prefix }
}

/**
 * BL-2156 (2026-10-23): which of a hunk's matches it changes. One match is the hunk's place, as
 * before. With more than one, the `@@` lines decide: `scope` holds the anchors of the header-only
 * `@@` lines stacked above this hunk (`@@ class Wishlist {` then `@@ constructor() {`), outermost
 * first. Every line of the whole file that is the first anchor (or, when none is, starts with it)
 * is tried; each inner anchor is the next line after the one before that is it (or, when none is,
 * starts with it); the try's place is the first match that holds that line or comes after it (a
 * hunk's unchanged lines often start above its `@@` line). The hunk is placed only when every try
 * that finds a match gives the same one (a try that finds none drops out); otherwise it is refused. Each anchor's lines are read once, so a large file
 * costs one pass per anchor. It used to change the first match, and then the first match after the
 * first line that starts with the anchor, so a hunk with few unchanged lines could edit another
 * function (a repeated `constructor() {`, a prefix such as `parseConfig` before `parseConfigFile`)
 * and report success (the tool-descriptions review and its two confirm passes).
 *
 * Still possible: an `@@` line that names one place whose lines have moved (a stale view) places
 * the hunk at the first match after it; lines above the `@@` line (a decorator, a doc comment) are
 * found in the next block (so a repeated `@@` line can then be placed in the later block, not
 * refused); an inner `@@` line missing from its outer block, or only the start of a line there
 * while a later line is it whole, is found in a later one;
 * a hunk that only adds lines has one place, the cursor, and ignores its `@@` lines; and a hunk
 * whose `@@` line comes before an earlier hunk's change lands at its first match after the cursor.
 * The boundary: it places a hunk somewhere other than its first match only when that first match
 * lies wholly above the line every reading of its `@@` lines lands on.
 */
function pickManagedPatchMatch(lines: string[], found: number[], patternLength: number, hunk: ManagedApplyPatchHunk, scope: string[], filePath: string): number {
  if (found.length === 1) return found[0]
  const anchors = [...scope, managedPatchHunkAnchor(hunk.header)].filter(Boolean)
  if (anchors.length > 0) {
    const anchorLines = anchors.map((anchor) => findManagedPatchAnchorLines(lines, anchor))
    const outerLines = anchorLines[0].exact.length > 0 ? anchorLines[0].exact : anchorLines[0].prefix
    const span = Math.max(1, patternLength)
    const placements = new Set<number>()
    for (const outer of outerLines) {
      let position: number | undefined = outer
      for (const inner of anchorLines.slice(1)) {
        position = firstManagedPatchIndexAfter(inner.exact, position) ?? firstManagedPatchIndexAfter(inner.prefix, position)
        if (position === undefined) break
      }
      if (position === undefined) continue
      const placed = firstManagedPatchIndexAfter(found, position - span)
      if (placed !== undefined) placements.add(placed)
    }
    if (placements.size === 1) return [...placements][0]
  }
  throw new Error(
    `Failed to apply hunk "${hunk.header}" in ${filePath}: its lines match ${found.length} places${anchors.length > 0 ? ' and its `@@` line does not pick one' : ''}. ` +
      'Add unchanged lines around the change, or start the hunk with an `@@` line naming the function or class it is in, so it matches one place.'
  )
}

export function applyManagedPatchHunks(options: {
  content: string
  hunks: ManagedApplyPatchHunk[]
  filePath: string
}): string {
  const parsed = splitManagedPatchText(options.content)
  const lines = parsed.lines.slice()
  let cursor = 0
  // BL-2156: the anchors of header-only `@@` lines stacked above the next hunk (they change nothing).
  let scope: string[] = []

  for (const hunk of options.hunks) {
    if (hunk.lines.length === 0) {
      const anchor = managedPatchHunkAnchor(hunk.header)
      if (anchor) scope.push(anchor)
      continue
    }
    const candidates = buildManagedPatchCandidates(hunk)
    let match:
      | {
          targetIndex: number
          sourcePattern: string[]
          replacement: string[]
        }
      | null = null

    for (const candidate of candidates) {
      let found = findManagedPatchSequences(lines, candidate.sourcePattern, cursor)
      if (found.length === 0) found = findManagedPatchSequences(lines, candidate.sourcePattern, 0)
      if (found.length > 0) {
        match = {
          targetIndex: pickManagedPatchMatch(lines, found, candidate.sourcePattern.length, hunk, scope, options.filePath),
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
    scope = []
  }

  return joinManagedPatchLines(lines, parsed.hasTrailingNewline)
}
