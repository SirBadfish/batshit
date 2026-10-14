import { endsWithToolModelCutNotice } from './toolModelTextSizeGuard'
import { failedCommandExitCode } from './toolActivityContract'

/**
 * SA-129 P1 (DL-01): dead copies of file reads.
 *
 * A whole-file read result is DEAD when a later whole read of the same file exists in the chat
 * (`superseded`) or when the agent edited that file after the read (`stale`). A dead copy is only
 * weight in the prompt: the agent either has a newer copy in front of it or the copy is wrong. The
 * compile compresses dead copies whatever the lane's buffer or Auto/Normal setting says; only an `Off`
 * row and a user unzip keep one open (`calculateZipActivation`).
 *
 * The rules, each one pinned by `zipDeadCopies.test.ts`:
 * - A later whole read supersedes every earlier read of that file, whole or partial; a partial read
 *   (`sed -n`, `head`, `tail`, a piped read, a read with a range or a cut) never supersedes.
 * - "Edited" is a `write_file` or `edit_file` result for the same path after the read, including a
 *   managed `apply_patch`. A failed edit never counts, and a Bash command with an unknown effect is
 *   never an edit (it is not stored as one). Only whole copies go stale; a partial copy stays until
 *   a whole read supersedes it.
 * - A result that holds several files compresses only when every file in it is dead. A result whose file
 *   set is unknown (a command this module cannot read word for word, a failed read, BL-233's
 *   mislabelled compound reads) is never dead and never supersedes anything.
 * - Paths are compared after normalization against the chat's project path. When in doubt the copy
 *   stays: a path that cannot be normalized (a glob, a variable, a `~`) makes the file set unknown.
 * - Results are compared within one author: another agent's read never supersedes and another
 *   agent's edit never makes a copy stale (group chats, and a chat that switched agents).
 * - A file read through a gateway MCP tool (`dynamic_use`, `read_file` / `read_text_file`) is a
 *   whole read only when its stored result proves it (BL-418, `gatewayReadFiles`); otherwise its
 *   file set is unknown.
 *
 * Pure: it reads the stored payloads it is handed and nothing else. The ledger is built per
 * compile from the compile's own messages, like the zip state (F-P5-11), so two chats compiling at
 * once can never share one.
 */

export type DeadCopyReason = 'superseded' | 'stale'

/** What the compressed reference of a dead copy says after its description (DL-01, P1). */
export const DEAD_COPY_REASON_TEXT: Record<DeadCopyReason, string> = {
  superseded: 'superseded by a later read',
  stale: 'stale, edited since'
}

export type FileReadMode = 'whole' | 'partial'

/** What one stored tool result did to files, as far as this module can tell. */
export type ToolResultFiles =
  | { kind: 'read'; files: Map<string, FileReadMode> }
  | { kind: 'edit'; files: Set<string> }
  /** A read whose file set is unknown: it is never dead and never supersedes. */
  | { kind: 'unknown_read' }
  | { kind: 'none' }

export interface DeadCopyToolResult {
  /** Normalized zip id. */
  zipId: string
  /** The agent that wrote the message holding the result; null when the message names none. */
  authorId: string | null
  /** Index of that message in the compile's message list. */
  messageIndex: number
  /** The zip's stored `metadata.operationKind` (the payload's own is the fallback). */
  operationKind?: string | null
  /** The parsed cool_tool payload, or null when the zip is not a tool result. */
  payload: Record<string, any> | null
}

export interface DeadCopy {
  reason: DeadCopyReason
  /** The message whose result made the last file of this copy dead. */
  deadAtMessageIndex: number
}

export interface DeadCopyOptions {
  /** The chat's project path; relative paths resolve against it. */
  projectPath?: string | null
}

// ---------------------------------------------------------------------------------------------
// Paths

function normalizePosixPath(value: string): string | null {
  const absolute = value.startsWith('/')
  const parts: string[] = []
  for (const part of value.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (absolute) return null
      else parts.push('..')
      continue
    }
    parts.push(part)
  }
  const joined = parts.join('/')
  if (absolute) return `/${joined}`
  return joined || '.'
}

/** macOS reaches `/tmp` and `/var` through `/private`; both spellings name one file. */
function withoutMacPrivatePrefix(value: string): string {
  return value.replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, '')
}

function isLiteralPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value === value.trim() &&
    !value.startsWith('~') &&
    !value.startsWith('-') &&
    // Control characters and backslashes (a Windows path, an escape) are never compared.
    !/[\u0000-\u001f\u007f\\]/.test(value)
  )
}

export function normalizeDeadCopyProjectPath(projectPath: unknown): string | null {
  if (!isLiteralPath(projectPath) || !projectPath.startsWith('/')) return null
  const normalized = normalizePosixPath(projectPath)
  return normalized ? withoutMacPrivatePrefix(normalized) : null
}

/**
 * One file's comparison key: relative to the project when the file sits inside it, else absolute;
 * null when the path cannot be compared (the caller then treats the file set as unknown).
 */
function filePathKey(raw: unknown, baseDir: string | null, project: string | null): string | null {
  if (!isLiteralPath(raw)) return null
  let joined = raw
  if (!raw.startsWith('/')) {
    const base = baseDir ?? project
    if (base) joined = `${base}/${raw}`
  }
  const normalized = normalizePosixPath(joined)
  if (!normalized) return null
  if (!normalized.startsWith('/')) return normalized
  const absolute = withoutMacPrivatePrefix(normalized)
  if (project && absolute === project) return '.'
  if (project && absolute.startsWith(`${project}/`)) return absolute.slice(project.length + 1)
  return absolute
}

/** A `cd` target as a base directory for the paths after it (absolute, or relative to the project). */
function baseDirectory(raw: string, project: string | null): string | null {
  if (!isLiteralPath(raw)) return null
  const joined = raw.startsWith('/') || !project ? raw : `${project}/${raw}`
  const normalized = normalizePosixPath(joined)
  if (!normalized) return null
  return normalized.startsWith('/') ? withoutMacPrivatePrefix(normalized) : normalized
}

// ---------------------------------------------------------------------------------------------
// A strict reading of a shell command line
//
// Only a small, fully literal grammar is read: simple commands joined by `&&`, `;`, or a newline,
// and one kind of two-command pipe (a whole read filtered to a range). Anything else — a variable,
// a substitution, a glob, a redirect, `||`, a subshell, a comment — makes the reading fail, and the
// caller treats the result's file set as unknown.

type ShellToken = { kind: 'word'; text: string; dynamic: boolean } | { kind: 'op'; op: string }

const SHELL_OPERATORS = ['&&', '||', '|&', '>>', '<<', '>&', '<&', ';;', '|', '&', ';', '(', ')', '<', '>']

function tokenizeShell(text: string): ShellToken[] | null {
  const tokens: ShellToken[] = []
  let word = ''
  let inWord = false
  let dynamic = false
  const endWord = () => {
    if (inWord) tokens.push({ kind: 'word', text: word, dynamic })
    word = ''
    inWord = false
    dynamic = false
  }

  for (let index = 0; index < text.length; ) {
    const char = text[index]
    if (char === '\\') {
      const next = text[index + 1]
      if (next === undefined) return null
      if (next !== '\n') {
        word += next
        inWord = true
      }
      index += 2
      continue
    }
    if (char === "'") {
      const end = text.indexOf("'", index + 1)
      if (end < 0) return null
      word += text.slice(index + 1, end)
      inWord = true
      index = end + 1
      continue
    }
    if (char === '"') {
      let cursor = index + 1
      while (cursor < text.length && text[cursor] !== '"') {
        const inner = text[cursor]
        if (inner === '\\' && cursor + 1 < text.length) {
          const escaped = text[cursor + 1]
          if (escaped === '\n') {
            cursor += 2
            continue
          }
          word += '$`"\\'.includes(escaped) ? escaped : `\\${escaped}`
          cursor += 2
          continue
        }
        if (inner === '$' || inner === '`') dynamic = true
        word += inner
        cursor += 1
      }
      if (cursor >= text.length) return null
      inWord = true
      index = cursor + 1
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      endWord()
      index += 1
      continue
    }
    if (char === '\n') {
      endWord()
      tokens.push({ kind: 'op', op: ';' })
      index += 1
      continue
    }
    if (char === '#' && !inWord) return null
    const operator = SHELL_OPERATORS.find((candidate) => text.startsWith(candidate, index))
    if (operator) {
      endWord()
      tokens.push({ kind: 'op', op: operator })
      index += operator.length
      continue
    }
    if ('$`*?[]{}!'.includes(char) || (char === '~' && !inWord)) dynamic = true
    word += char
    inWord = true
    index += 1
  }
  endWord()
  return tokens
}

type ShellWord = { text: string; dynamic: boolean }
/** Simple commands joined by `|`. */
type ShellPipeline = ShellWord[][]

/** Pipelines joined by `&&`, `;`, or a newline; null for any other operator or a syntax slip. */
function parsePipelines(tokens: ShellToken[]): ShellPipeline[] | null {
  const pipelines: ShellPipeline[] = []
  let pipeline: ShellPipeline = []
  let words: ShellWord[] = []

  for (const token of tokens) {
    if (token.kind === 'word') {
      words.push({ text: token.text, dynamic: token.dynamic })
      continue
    }
    if (token.op === '|') {
      if (words.length === 0) return null
      pipeline.push(words)
      words = []
      continue
    }
    if (token.op === '&&' || token.op === ';') {
      if (words.length === 0) {
        // A blank line (or a `;` after one) is nothing; a joiner with nothing before it is a slip.
        if (token.op === ';' && pipeline.length === 0) continue
        return null
      }
      pipeline.push(words)
      pipelines.push(pipeline)
      pipeline = []
      words = []
      continue
    }
    return null
  }
  if (words.length > 0) pipeline.push(words)
  else if (pipeline.length > 0) return null
  if (pipeline.length > 0) pipelines.push(pipeline)
  return pipelines
}

function programName(word: ShellWord): string {
  return word.text.slice(word.text.lastIndexOf('/') + 1)
}

const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const SED_RANGE_SCRIPT = /^\d+(?:,(?:\d+|\$))?p(?:;\d+(?:,(?:\d+|\$))?p)*;?$/
const COUNT_OPTION = /^-(?:\d+|[nc]\d+)$/

/** `cat`/`nl` (whole) or `sed -n <range>p`/`head`/`tail` (partial) with their file operands. */
function readOperands(command: ShellWord[]): { files: string[]; mode: FileReadMode } | null {
  const program = programName(command[0])
  const args = command.slice(1).map((word) => word.text)

  if (program === 'cat') {
    const files: string[] = []
    let optionsDone = false
    for (const arg of args) {
      if (!optionsDone && arg === '--') {
        optionsDone = true
        continue
      }
      if (!optionsDone && arg.startsWith('-')) {
        // Numbering (`-n`, `-b`) and unbuffered output (`-u`) still print every line.
        if (arg === '-n' || arg === '-b' || arg === '-u') continue
        return null
      }
      if (arg === '-') return null
      files.push(arg)
    }
    return files.length > 0 ? { files, mode: 'whole' } : null
  }

  if (program === 'nl') {
    // `nl -ba` numbers every line; plain `nl` prints every line and numbers the non-blank ones.
    const operands = args[0] === '-ba' ? args.slice(1) : args[0] === '-b' && args[1] === 'a' ? args.slice(2) : args
    if (operands.length !== 1 || operands[0].startsWith('-')) return null
    return { files: operands, mode: 'whole' }
  }

  if (program === 'sed') {
    if (args[0] !== '-n' || !SED_RANGE_SCRIPT.test(args[1] ?? '')) return null
    const files = args.slice(2)
    if (files.length === 0 || files.some((file) => file.startsWith('-'))) return null
    return { files, mode: 'partial' }
  }

  if (program === 'head' || program === 'tail') {
    const files = readCountOptions(args)
    if (!files || files.length === 0) return null
    return { files, mode: 'partial' }
  }

  return null
}

/** The operands after `head`/`tail` count options; null for any other option (`tail -f`). */
function readCountOptions(args: string[]): string[] | null {
  const operands: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if ((arg === '-n' || arg === '-c') && /^\d+$/.test(args[index + 1] ?? '')) {
      index += 1
      continue
    }
    if (COUNT_OPTION.test(arg) || /^--(?:lines|bytes)=\d+$/.test(arg)) continue
    if (arg.startsWith('-')) return null
    operands.push(arg)
  }
  return operands
}

/** The right side of `cat f | …`: a range filter that reads no file of its own. */
function isRangeFilter(command: ShellWord[]): boolean {
  const program = programName(command[0])
  const args = command.slice(1).map((word) => word.text)
  if (program === 'sed') return args.length === 2 && args[0] === '-n' && SED_RANGE_SCRIPT.test(args[1])
  if (program === 'head' || program === 'tail') return readCountOptions(args)?.length === 0
  return false
}

/**
 * The files a read command read and how (whole or partial), resolved against its leading `cd`.
 * Null when any part of the command is outside the strict grammar above.
 */
export function readFilesFromCommand(
  command: string,
  project: string | null,
  depth = 0
): Map<string, FileReadMode> | null {
  const tokens = tokenizeShell(command)
  const pipelines = tokens ? parsePipelines(tokens) : null
  if (!pipelines || pipelines.length === 0) return null

  // A shell wrapper around one command line (`/bin/zsh -lc '…'`): read the line it runs.
  const only = pipelines.length === 1 && pipelines[0].length === 1 ? pipelines[0][0] : null
  if (
    only &&
    depth < 2 &&
    only.length === 3 &&
    only.every((word) => !word.dynamic) &&
    SHELL_PROGRAMS.has(programName(only[0])) &&
    /^-[a-z]*c[a-z]*$/.test(only[1].text)
  ) {
    return readFilesFromCommand(only[2].text, project, depth + 1)
  }

  const files = new Map<string, FileReadMode>()
  let baseDir: string | null = null
  const add = (raw: string, mode: FileReadMode): boolean => {
    const key = filePathKey(raw, baseDir, project)
    if (!key) return false
    if (files.get(key) !== 'whole') files.set(key, mode)
    return true
  }

  for (let index = 0; index < pipelines.length; index += 1) {
    const pipeline = pipelines[index]
    if (pipeline.some((command) => command.some((word) => word.dynamic))) return null

    if (pipeline.length === 1) {
      const command = pipeline[0]
      const program = programName(command[0])
      if (program === 'cd') {
        // Only a leading `cd` is followed: a later one would move files the reading already saw.
        if (index !== 0 || command.length !== 2 || command[1].text === '-') return null
        baseDir = baseDirectory(command[1].text, project)
        if (!baseDir) return null
        continue
      }
      // Separator lines between files (`echo "=== a.ts ==="`).
      if (program === 'echo' || program === 'printf') continue
      const read = readOperands(command)
      if (!read) return null
      for (const file of read.files) if (!add(file, read.mode)) return null
      continue
    }

    if (pipeline.length === 2) {
      const read = readOperands(pipeline[0])
      if (!read || read.mode !== 'whole' || read.files.length !== 1) return null
      if (!isRangeFilter(pipeline[1])) return null
      if (!add(read.files[0], 'partial')) return null
      continue
    }
    return null
  }

  return files.size > 0 ? files : null
}

// ---------------------------------------------------------------------------------------------
// Stored payloads

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

function payloadArgs(payload: Record<string, any>): Record<string, any> {
  return asRecord(payload.toolArgs) ?? asRecord(payload.toolInput) ?? asRecord(payload.input) ?? {}
}

function payloadResult(payload: Record<string, any>): Record<string, any> | null {
  return asRecord(payload.toolResult ?? payload.observation ?? payload.result ?? payload.output)
}

function commandOf(args: Record<string, any>, result: Record<string, any> | null): string | null {
  return firstText(args.innerCommand, args.command, args.cmd, result?.innerCommand, result?.command)
}

function resultFailed(payload: Record<string, any>, result: Record<string, any> | null): boolean {
  return (
    Boolean(firstText(payload.error)) ||
    result?.success === false ||
    result?.blocked === true ||
    failedCommandExitCode(result) !== undefined
  )
}

/**
 * A runner's own stream-cut line, as the start of a line: Batshit's runners (`limitedOutput`,
 * commandOutputLimit.ts, and its Docker sidecar and operator twins) and Claude Code's cut
 * (`claudeCutOutputLine`, claudeEventAdapter.ts). A read can hold text after it (stderr joined
 * after a cut stdout, Claude's trailing note), so it counts wherever a line starts with it.
 */
const STREAM_CUT_LINE =
  /(?:^|\n)\[Output cut here by (?:Batshit: the command printed more than \d{1,3}(?:,\d{3})* characters|Claude Code: (?:only the first \d{1,3}(?:,\d{3})* bytes kept|\d{1,3}(?:,\d{3})* of \d{1,3}(?:,\d{3})* bytes kept))\.\]/

/**
 * A lane or runner cut the output: what the result holds is the start of the file. BL-678: a
 * size guard cut is only the guard's exact notice at the end; a file that quotes the notice's
 * words is read whole. The check stays conservative: a guard notice at the end counts at any
 * length, and a runner's cut line counts wherever a line starts with it.
 */
function readWasCut(payload: Record<string, any>, result: Record<string, any> | null): boolean {
  if (!result) return false
  if (result.outputCut || result.truncated === true) return true
  const content = firstText(result.content, result.fileContent, result.output)
  return content !== null && (
    endsWithToolModelCutNotice(content) ||
    STREAM_CUT_LINE.test(content) ||
    /\.\.\.\[truncated \d+ chars\]/.test(content)
  )
}

/** Arguments that ask a read tool for part of a file (Claude Code's Read takes `offset`/`limit`). */
const RANGE_ARGUMENTS = [
  'offset',
  'limit',
  'startLine',
  'endLine',
  'start_line',
  'end_line',
  'lineStart',
  'lineEnd',
  'fromLine',
  'toLine',
  'range',
  'lines',
  'maxLines',
  'max_lines',
  'head',
  'tail'
]

/**
 * Claude Code's Read returns at most 2,000 lines and its stored result keeps only the count it
 * returned, so a read that long may be the start of a longer file.
 */
const LONGEST_KNOWN_WHOLE_DIRECT_READ = 1999

function readFiles(payload: Record<string, any>, operationKind: string, project: string | null): ToolResultFiles {
  const args = payloadArgs(payload)
  const result = payloadResult(payload)
  if (resultFailed(payload, result)) return { kind: 'unknown_read' }
  if (result?.contentOmitted === true || payload.storage?.binaryLikeOmitted === true) return { kind: 'unknown_read' }
  const cut = readWasCut(payload, result)

  if (operationKind === 'skill_read') {
    const skillId = firstText(args.skillId, result?.skillId)
    const file = normalizePosixPath(firstText(args.path, result?.path, result?.filePath) ?? 'SKILL.md')
    if (!skillId || !file || file.startsWith('/') || file.startsWith('..')) return { kind: 'unknown_read' }
    // Only `invoke` returns a whole file (the skill's SKILL.md). A `read` or `script_read` returns
    // a window whose size each lane sets, and the stored result does not keep whether it was cut,
    // so it is always a part.
    const whole =
      !cut &&
      firstText(args.action, result?.action) === 'invoke' &&
      (args.offset === undefined || args.offset === null || args.offset === 0)
    // A skill's files are named inside the skill, never by a project path.
    return { kind: 'read', files: new Map([[`skill:${skillId}:${file}`, whole ? 'whole' : 'partial']]) }
  }

  const command = commandOf(args, result)
  if (command) {
    const files = readFilesFromCommand(command, project)
    if (!files) return { kind: 'unknown_read' }
    if (cut) for (const file of files.keys()) files.set(file, 'partial')
    return { kind: 'read', files }
  }

  const key = filePathKey(firstText(result?.filePath, args.filePath, args.file_path, args.path, result?.path), null, project)
  if (!key) return { kind: 'unknown_read' }
  const lineCount = Number(result?.lineCount ?? result?.numLines)
  const partial =
    cut ||
    RANGE_ARGUMENTS.some((name) => args[name] !== undefined && args[name] !== null) ||
    (Number.isFinite(lineCount) && lineCount > LONGEST_KNOWN_WHOLE_DIRECT_READ)
  return { kind: 'read', files: new Map([[key, partial ? 'partial' : 'whole']]) }
}

/**
 * BL-418: the gateway MCP tools that read one whole text file when called with a path alone
 * (`@modelcontextprotocol/server-filesystem`: `read_file`, and `read_text_file`, which is the same
 * handler; `head` or `tail` asks it for part of the file).
 */
const GATEWAY_FILE_READ_TOOLS = new Set(['read_file', 'read_text_file'])

/**
 * BL-418: the tool's own arguments of a gateway call, from the model's input as the stored result
 * keeps it (`result.input`), or null when they cannot be known for sure.
 *
 * The broker hands the tool `{ ...top level, ...params, ...input }`, later wins, leaving out its own
 * keys (`normalizeBatshitToolUsePayload`, `nativeTools.ts`): of those, only `ref` can appear in a
 * read. `send-routed` stores the model's input through `normalizeToolArgs`
 * (`sseToolNormalization.ts`), which merges `input` into the top level (input wins), keeps `params`
 * nested, and copies `path` into `filePath` when the input has none. So `ref` is skipped, `filePath`
 * is skipped only when it is that copy, and a key both in the merged top level and in `params` is
 * ambiguous (it came from `input`, which beats `params`, or from the top level, which loses to it)
 * unless the two agree.
 */
function gatewayCallArguments(stored: Record<string, any> | null): Record<string, unknown> | null {
  if (!stored) return null
  const params = stored.params === undefined ? {} : asRecord(stored.params)
  if (!params) return null
  const merged: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(stored)) {
    if (key === 'ref' || key === 'params') continue
    if (key === 'filePath' && value === stored.path) continue
    merged[key] = value
  }
  for (const [key, value] of Object.entries(params)) {
    if (key in merged && merged[key] !== value) return null
  }
  return { ...params, ...merged }
}

/**
 * BL-418 (Faye's decision, 2026-09-27): a file read through a gateway MCP tool (Batshit Tool Use's
 * `mcp` family, stored as `operationKind: 'dynamic_use'` with the executed tool's name) is a WHOLE
 * read only when its stored result proves it; otherwise its file set is unknown, so it is never
 * dead, never supersedes, and cannot be held ("You have no whole read of ..."). It proves it when:
 *
 * - the call worked: the stored result keeps the MCP result, and it is not `isError`;
 * - the tool's own arguments are exactly `{ path }` (`gatewayCallArguments`). Anything more may
 *   read part of the file (`head`, `tail`, `length`, or a key this module has never heard of);
 * - the path is absolute: the tool server resolves a relative path against its own folder, which
 *   need not be the chat's project, so only an absolute path names the same file both ways;
 * - the stored result holds the whole text: one `text` item whose text is a plain string. The
 *   generic zip summary keeps a string only up to 80 lines and 2,000 characters and stores a longer
 *   one as `{ preview, truncated }`, and text that parses as JSON (a `.json` file) as the parsed
 *   value, so such a read stays unknown.
 *
 * The shape is the API lane's, taken from a real gateway read (`gateway-read-steps.ts`).
 */
function gatewayReadFiles(payload: Record<string, any>, project: string | null): ToolResultFiles {
  const toolName = firstText(payload.toolName, payload.metadata?.toolName)
  if (!toolName || !GATEWAY_FILE_READ_TOOLS.has(toolName)) return { kind: 'none' }
  // A failed call keeps no MCP result (a broker refusal, or a thrown call stored as
  // `{ success: false, error }`, BL-450); a failed read keeps one with `isError`.
  const result = payloadResult(payload)
  const mcpResult = asRecord(result?.result)
  if (!result || !mcpResult || mcpResult.isError === true) return { kind: 'unknown_read' }

  const args = gatewayCallArguments(asRecord(result.input))
  if (!args || Object.keys(args).length !== 1 || typeof args.path !== 'string') return { kind: 'unknown_read' }
  if (!args.path.startsWith('/')) return { kind: 'unknown_read' }
  const key = filePathKey(args.path, null, project)
  if (!key) return { kind: 'unknown_read' }

  const content = mcpResult.content
  const item = Array.isArray(content) && content.length === 1 ? asRecord(content[0]) : null
  if (item?.type !== 'text' || typeof item.text !== 'string') return { kind: 'unknown_read' }
  return { kind: 'read', files: new Map([[key, 'whole']]) }
}

/** A managed patch's file headers. Built per call: a shared `/g` pattern carries `lastIndex`. */
const patchFileHeaders = () => /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gm

/**
 * The words before a managed `apply_patch` document: an optional leading `cd <folder>` and `set`
 * options, then `apply_patch` itself. Returns the `cd` folder (or '' for none); null when the
 * command is not that shape (a script that merely contains patch text is not a managed patch).
 */
function managedPatchBase(command: string): string | null {
  const beforePatch = command.slice(0, command.indexOf('*** Begin Patch'))
  // The document arrives through a heredoc (`<<'PATCH'`) or as one quoted argument.
  const invocation = beforePatch.replace(/<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1\s*$/, '').replace(/(['"])\s*$/, '')
  const tokens = tokenizeShell(invocation)
  const pipelines = tokens ? parsePipelines(tokens) : null
  if (!pipelines || pipelines.length === 0) return null
  let base = ''
  for (let index = 0; index < pipelines.length; index += 1) {
    const pipeline = pipelines[index]
    if (pipeline.length !== 1 || pipeline[0].some((word) => word.dynamic)) return null
    const command = pipeline[0]
    const program = programName(command[0])
    const last = index === pipelines.length - 1
    if (last) return program === 'apply_patch' && command.length === 1 ? base : null
    if (program === 'cd' && command.length === 2 && !base) {
      base = command[1].text
      continue
    }
    if (program === 'set' && command.slice(1).every((word) => /^[-+][a-zA-Z]+$/.test(word.text) || word.text === 'pipefail')) continue
    return null
  }
  return null
}

function editFiles(payload: Record<string, any>, project: string | null): ToolResultFiles {
  const args = payloadArgs(payload)
  const result = payloadResult(payload)
  if (resultFailed(payload, result)) return { kind: 'none' }
  const files = new Set<string>()
  const command = commandOf(args, result)

  if (command && command.includes('*** Begin Patch')) {
    const base = managedPatchBase(command)
    if (base === null) return { kind: 'none' }
    const baseDir = base ? baseDirectory(base, project) : null
    if (base && !baseDir) return { kind: 'none' }
    for (const match of command.matchAll(patchFileHeaders())) {
      const key = filePathKey(match[1].trim(), baseDir, project)
      if (key) files.add(key)
    }
    return files.size > 0 ? { kind: 'edit', files } : { kind: 'none' }
  }

  if (command) {
    // A shell edit (`sed -i`, a redirect) is stored under the path its mapper read from the line.
    // It counts only when that path is one of the line's own literal words and nothing moved the
    // working folder first; a heredoc body is not part of the line.
    const label = firstText(result?.filePath, args.filePath, args.path)
    const newline = command.indexOf('\n')
    const line = command.includes('<<') && newline >= 0 ? command.slice(0, newline) : command
    const tokens = tokenizeShell(line.replace(/<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1/, ''))
    const words = (tokens ?? []).filter((token): token is Extract<ShellToken, { kind: 'word' }> => token.kind === 'word')
    if (!label || words.length === 0 || words.some((word) => programName(word) === 'cd')) return { kind: 'none' }
    if (!words.some((word) => !word.dynamic && word.text === label)) return { kind: 'none' }
    const key = filePathKey(label, null, project)
    return key ? { kind: 'edit', files: new Set([key]) } : { kind: 'none' }
  }

  // A direct edit or write tool names its file (and a Codex patch of several files names them all).
  const changes = Array.isArray(result?.changes) ? result.changes : []
  const candidates = [
    result?.filePath,
    args.filePath,
    args.file_path,
    args.path,
    result?.path,
    ...(Array.isArray(args.paths) ? args.paths : []),
    ...(Array.isArray(result?.filePaths) ? result.filePaths : []),
    ...changes.map((change: any) => change?.path ?? change?.filePath ?? change?.file)
  ]
  for (const candidate of candidates) {
    const key = filePathKey(candidate, null, project)
    if (key) files.add(key)
  }
  return files.size > 0 ? { kind: 'edit', files } : { kind: 'none' }
}

/** What one stored tool result did to files (see the rules at the top of this module). */
export function describeToolResultFiles(
  result: Pick<DeadCopyToolResult, 'operationKind' | 'payload'>,
  options: DeadCopyOptions = {}
): ToolResultFiles {
  const payload = result.payload
  if (!payload) return { kind: 'none' }
  const project = normalizeDeadCopyProjectPath(options.projectPath)
  const operationKind = firstText(result.operationKind, payload.operationKind, payload.metadata?.operationKind)
  if (operationKind === 'read_file' || operationKind === 'skill_read') return readFiles(payload, operationKind, project)
  if (operationKind === 'edit_file' || operationKind === 'write_file') return editFiles(payload, project)
  if (operationKind === 'dynamic_use') return gatewayReadFiles(payload, project)
  return { kind: 'none' }
}

// ---------------------------------------------------------------------------------------------
// The ledger

interface ReadCopy {
  zipId: string
  files: Map<string, FileReadMode>
  dead: Map<string, { reason: DeadCopyReason; at: number }>
}

/**
 * The dead copies among a compile's tool results, keyed by normalized zip id. `results` must be in
 * chat order (message order, then the order of the references inside each message).
 */
export function findDeadCopies(results: DeadCopyToolResult[], options: DeadCopyOptions = {}): Map<string, DeadCopy> {
  const readsByAuthor = new Map<string, Map<string, ReadCopy[]>>()
  const copies: ReadCopy[] = []
  const seen = new Set<string>()

  for (const result of results) {
    if (seen.has(result.zipId)) continue
    seen.add(result.zipId)
    const effect = describeToolResultFiles(result, options)
    if (effect.kind !== 'read' && effect.kind !== 'edit') continue

    const author = result.authorId ?? ''
    let readsByFile = readsByAuthor.get(author)
    if (!readsByFile) {
      readsByFile = new Map()
      readsByAuthor.set(author, readsByFile)
    }

    if (effect.kind === 'read') {
      for (const [file, mode] of effect.files) {
        if (mode !== 'whole') continue
        for (const earlier of readsByFile.get(file) ?? []) {
          if (!earlier.dead.has(file)) earlier.dead.set(file, { reason: 'superseded', at: result.messageIndex })
        }
      }
      const copy: ReadCopy = { zipId: result.zipId, files: effect.files, dead: new Map() }
      copies.push(copy)
      for (const file of effect.files.keys()) {
        const list = readsByFile.get(file) ?? []
        list.push(copy)
        readsByFile.set(file, list)
      }
      continue
    }

    for (const file of effect.files) {
      for (const earlier of readsByFile.get(file) ?? []) {
        if (earlier.files.get(file) === 'whole' && !earlier.dead.has(file)) {
          earlier.dead.set(file, { reason: 'stale', at: result.messageIndex })
        }
      }
    }
  }

  const dead = new Map<string, DeadCopy>()
  for (const copy of copies) {
    if (copy.files.size === 0 || copy.dead.size !== copy.files.size) continue
    const marks = [...copy.dead.values()]
    dead.set(copy.zipId, {
      reason: marks.some((mark) => mark.reason === 'stale') ? 'stale' : 'superseded',
      deadAtMessageIndex: Math.max(...marks.map((mark) => mark.at))
    })
  }
  return dead
}

// ---------------------------------------------------------------------------------------------
// Holds (SA-129 P2, DL-02)

const SKILL_KEY_PREFIX = 'skill:'
/** A skill id as Batshit writes one: letters, digits, `_`, `-`, `.`, never a path mark like `~`. */
const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The ledger keys a held or released path may mean, in the order to try them. An agent names a
 * file the way its read shows it: a project file by its path (relative to the project, or
 * absolute), a skill file as `<skill id>/<path>` or `skill:<skill id>/<path>`. A project file is
 * tried first; a path that cannot be compared means nothing (an empty list).
 */
export function holdPathKeys(raw: string, options: DeadCopyOptions = {}): string[] {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return []
  const keys: string[] = []
  const explicitSkill = value.startsWith(SKILL_KEY_PREFIX)
  if (!explicitSkill) {
    const project = normalizeDeadCopyProjectPath(options.projectPath)
    const key = filePathKey(value, null, project)
    if (key) keys.push(key)
  }
  const skillPath = explicitSkill ? value.slice(SKILL_KEY_PREFIX.length) : value
  const slash = skillPath.indexOf('/')
  if (slash > 0 && !skillPath.startsWith('/')) {
    const skillId = skillPath.slice(0, slash)
    const file = normalizePosixPath(skillPath.slice(slash + 1))
    if (file && file !== '.' && !file.startsWith('/') && !file.startsWith('..') && SKILL_ID.test(skillId)) {
      keys.push(`${SKILL_KEY_PREFIX}${skillId}:${file}`)
    }
  }
  return keys
}

/** A held path as people and agents read it: a skill file as `<skill id>/<path>`, else the path. */
export function describeHeldPath(key: string): string {
  if (!key.startsWith(SKILL_KEY_PREFIX)) return key
  const rest = key.slice(SKILL_KEY_PREFIX.length)
  const colon = rest.indexOf(':')
  return colon > 0 ? `${rest.slice(0, colon)}/${rest.slice(colon + 1)}` : key
}

/**
 * The newest WHOLE read of each file among `results` (chat order; the caller passes one author's
 * results), keyed by the ledger's file key. A partial read, a failed read, and a read whose file
 * set is unknown never count: a hold always sits on a whole copy (DL-02).
 */
export function newestWholeReadsByFile(
  results: DeadCopyToolResult[],
  options: DeadCopyOptions = {}
): Map<string, { zipId: string; messageIndex: number }> {
  const newest = new Map<string, { zipId: string; messageIndex: number }>()
  const seen = new Set<string>()
  for (const result of results) {
    if (seen.has(result.zipId)) continue
    seen.add(result.zipId)
    const effect = describeToolResultFiles(result, options)
    if (effect.kind !== 'read') continue
    for (const [file, mode] of effect.files) {
      if (mode === 'whole') newest.set(file, { zipId: result.zipId, messageIndex: result.messageIndex })
    }
  }
  return newest
}
