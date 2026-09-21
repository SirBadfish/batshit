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

/** A shell option whose value is the next word (`-o pipefail`, `-O extglob`, `--rcfile <file>`). */
const SHELL_OPTION_WITH_VALUE = /^(?:[-+][oO]|--rcfile|--init-file)$/

/**
 * Whether the flag at `flagIndex` belongs to a shell (bug sweep item 6): the nearest word before it
 * that is not one of the shell's own options (`-e`, `--norc`, `-o pipefail`) names a shell, by path
 * or not, or `su`/`script`/`flock`, whose `-c` value is a command line too. Quotes, `(`, and command
 * separators around that word do not count.
 */
function flagFollowsShellWord(text: string, flagIndex: number): boolean {
  const words = text
    .slice(0, flagIndex)
    .split(/[\s;&|()`]+/)
    .map((word) => word.replace(/['"\\]/g, ''))
    .filter(Boolean)
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index]
    const program = word.slice(word.lastIndexOf('/') + 1).toLowerCase()
    if (SHELL_PROGRAM_NAMES.has(program) || COMMAND_OPTION_PROGRAM_NAMES.has(program)) return true
    if (index > 0 && SHELL_OPTION_WITH_VALUE.test(words[index - 1])) index -= 1
    else if (!/^[-+]/.test(word)) return false
  }
  return false
}

/**
 * The command line a shell runs from its quoted `-c` value, exactly as written between the quotes
 * (bug sweep item 6). Another program's `-c` is that program's own option (`grep -c 'foo' notes.md`
 * counts matches of `foo`; `ls -lc` lists by change time), so a value counts only when its flag
 * belongs to a shell. A `-lc` value is read first, as it always was, so Codex's `/bin/zsh -lc '…'`
 * unwraps byte for byte; a shell's `-c` in any cluster (`-ec`, `-euc`) is the same flag.
 */
function shellQuotedCommandString(text: string): string | null {
  // A flag word and its quoted value: a `-lc`, then any cluster with a `c`. Built on every call,
  // since a shared `/g` pattern carries `lastIndex` from one call to the next.
  const patterns = [/(?<!\S)-lc\s+(['"])([\s\S]*?)\1/g, /(?<!\S)-[a-zA-Z]*c[a-zA-Z]*\s+(['"])([\s\S]*?)\1/g]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[2] && flagFollowsShellWord(text, match.index ?? 0)) return match[2]
    }
  }
  return null
}

function extractShellCommand(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) return command

  const shellCommandString = shellQuotedCommandString(trimmed)
  if (shellCommandString !== null) return shellCommandString

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

/**
 * The first command of a pipeline: the text before its first `|` outside quotes (`|`, `|&`, and
 * `||` all end it). A read's operand is in its own command, never in the one it pipes into (bug
 * sweep item 7).
 */
function firstPipelineStage(command: string): string {
  let quote: string | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      if (char === '\\' && quote === '"') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '\\') index += 1
    else if (char === "'" || char === '"') quote = char
    else if (char === '|') return command.slice(0, index)
  }
  return command
}

function extractPathFromReadCommand(shellCommand: string): string | undefined {
  // The read is the pipeline's first stage: `sed -n '1,5p' app.js | grep -i foo` reads app.js, as
  // `cat app.js | grep foo` and `head app.js | grep foo` always did, and a later `| head -3` or
  // `| cat -n` lends it no count or flag for a path (bug sweep item 7).
  const readStage = firstPipelineStage(shellCommand)

  // `head -n 2 file` and `tail -n +5 file` give a count before the file; the count is not the
  // path. An option without a separate value (`cat -n`, `head -5`, `--lines=5`) is skipped whole.
  const catLikeMatch = readStage.match(
    /\b(?:cat|head|tail)\b\s+(?:(?:-[nc]|--lines|--bytes)\s+[+-]?\d+[a-zA-Z]*\s+|-[^\s]+\s+)*(?![><])(?:['"]?)([^'"`\s|><]+)(?:['"]?)/i
  )
  if (catLikeMatch?.[1]) return catLikeMatch[1].trim()

  const sedMatch = readStage.match(
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

/** One word of a command line, after the shell's quote and backslash removal. */
interface ShellWord {
  text: string
  /** The word holds a `$…` or backtick substitution, so its text is not what the shell runs. */
  dynamic: boolean
  /** This word contains an output-redirection `>` that was outside quotes/backslash escaping. */
  outputRedirect: boolean
}

const SHELL_WORD_BREAK = /\s/

/**
 * One command line split the way the shell reads it, into simple commands of words (Bug Q). Quotes
 * and backslashes are removed as the shell removes them, so a flag written in quotes (`"-i"`,
 * `-'i'`) is still that flag, while a quoted script (`'s/ -i / x /'`) stays one word whose text is
 * never a flag. Outside quotes, `;`, `&&`, `||`, `|`, `&`, a newline, and a parenthesis end a
 * simple command, but `&` inside a redirect (`2>&1`, `&>`) does not. A `$(…)` or backtick
 * substitution stays inside its word and marks it dynamic. A `#` that starts a word ends the line.
 */
function splitShellSimpleCommands(line: string): ShellWord[][] {
  const commands: ShellWord[][] = []
  let words: ShellWord[] = []
  let text = ''
  let dynamic = false
  let outputRedirect = false
  let inWord = false

  const endWord = () => {
    if (inWord) words.push({ text, dynamic, outputRedirect })
    text = ''
    dynamic = false
    outputRedirect = false
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  // Where the substitution opened by the backtick or `(` at `open` ends, quotes and nesting included.
  const substitutionEnd = (open: number): number => {
    if (line[open] === '`') {
      let cursor = open + 1
      while (cursor < line.length && line[cursor] !== '`') cursor += line[cursor] === '\\' ? 2 : 1
      return Math.min(cursor, line.length - 1)
    }
    let depth = 1
    for (let cursor = open + 1; cursor < line.length; cursor += 1) {
      const char = line[cursor]
      if (char === '\\') {
        cursor += 1
      } else if (char === "'" || char === '"') {
        let close = cursor + 1
        while (close < line.length && line[close] !== char) {
          close += char === '"' && line[close] === '\\' ? 2 : 1
        }
        cursor = close
      } else if (char === '(') {
        depth += 1
      } else if (char === ')') {
        depth -= 1
        if (depth === 0) return cursor
      }
    }
    return line.length - 1
  }

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]

    if (char === '\\') {
      if (next !== undefined && next !== '\n') text += next
      index += 1
      inWord = true
      continue
    }
    if (char === "'") {
      const close = line.indexOf("'", index + 1)
      const end = close === -1 ? line.length : close
      text += line.slice(index + 1, end)
      index = end
      inWord = true
      continue
    }
    if (char === '"') {
      let cursor = index + 1
      while (cursor < line.length && line[cursor] !== '"') {
        const inner = line[cursor]
        if (inner === '\\' && cursor + 1 < line.length && '$`"\\\n'.includes(line[cursor + 1])) {
          text += line[cursor + 1]
          cursor += 2
          continue
        }
        if (inner === '$' || inner === '`') dynamic = true
        if ((inner === '$' && line[cursor + 1] === '(') || inner === '`') {
          const end = substitutionEnd(inner === '`' ? cursor : cursor + 1)
          text += line.slice(cursor, end + 1)
          cursor = end + 1
          continue
        }
        text += inner
        cursor += 1
      }
      index = cursor
      inWord = true
      continue
    }
    if (char === '$' && next === "'") {
      // ANSI-C quotes decode escapes after parsing (`$'\\x2f'` becomes `/`). Keep the visible
      // spelling for renderer logic, but approval policy must treat the executed bytes as unknown.
      dynamic = true
      let cursor = index + 2
      while (cursor < line.length && line[cursor] !== "'") {
        if (line[cursor] === '\\' && cursor + 1 < line.length) {
          text += line[cursor + 1]
          cursor += 2
          continue
        }
        text += line[cursor]
        cursor += 1
      }
      index = cursor
      inWord = true
      continue
    }
    if ((char === '$' && next === '(') || char === '`') {
      const end = substitutionEnd(char === '`' ? index : index + 1)
      text += line.slice(index, end + 1)
      index = end
      dynamic = true
      inWord = true
      continue
    }
    if (char === '$') {
      text += char
      dynamic = true
      inWord = true
      continue
    }
    if (char === '>') outputRedirect = true
    if (char === '#' && !inWord) break
    if (SHELL_WORD_BREAK.test(char)) {
      if (char === '\n') endCommand()
      else endWord()
      continue
    }
    if (char === ';' || char === '(' || char === ')') {
      endCommand()
      continue
    }
    if (char === '|') {
      endCommand()
      if (next === '|' || next === '&') index += 1
      continue
    }
    if (char === '&') {
      if (next === '&') {
        endCommand()
        index += 1
        continue
      }
      if (line[index - 1] === '>' || line[index - 1] === '<' || next === '>') {
        text += char
        inWord = true
        continue
      }
      endCommand()
      continue
    }
    text += char
    inWord = true
  }
  endCommand()
  return commands
}

/** A command word's program name: the last path segment, lowercased (macOS runs `SED` as `sed`). */
function shellProgramName(word: ShellWord): string {
  return word.text.slice(word.text.lastIndexOf('/') + 1).toLowerCase()
}

export interface ShellSimpleCommandSummary {
  /** The first non-assignment word's basename, lowercased; null for assignment-only commands. */
  program: string | null
  /** Shell-unquoted words, retained so policy can classify each operation independently. */
  words: string[]
  /** Literal redirect destinations; null means a redirect target could not be proven. */
  outputRedirectTargets: Array<string | null>
  /** Any word contains expansion/substitution whose executed bytes are not statically known. */
  dynamic: boolean
}

/**
 * Quote-aware simple commands from one top-level shell line. Approval policy uses the mapper's
 * parser so a renderer classification and its execution gate cannot disagree about where a
 * chained operation starts. Heredoc bodies must be removed by the caller before passing lines.
 */
export function summarizeShellSimpleCommands(line: string): ShellSimpleCommandSummary[] {
  return splitShellSimpleCommands(line).map((words) => {
    const commandWord = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text))
    const outputRedirectTargets: Array<string | null> = []
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index]
      if (!word.outputRedirect) continue
      const lastRedirect = word.text.lastIndexOf('>')
      let target = lastRedirect >= 0 ? word.text.slice(lastRedirect + 1) : ''
      if (target.startsWith('|')) target = target.slice(1)
      if (!target) target = words[index + 1]?.text ?? ''
      outputRedirectTargets.push(target || null)
    }
    return {
      program: commandWord ? shellProgramName(commandWord) : null,
      words: words.map((word) => word.text),
      outputRedirectTargets,
      dynamic: words.some((word) => word.dynamic)
    }
  })
}

const SED_PROGRAM_NAMES = new Set(['sed', 'gsed'])
const PERL_PROGRAM_NAME = /^perl(?:\d+(?:\.\d+)*)?$/
const SHELL_PROGRAM_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish'])
/** Programs whose `-c` (or `--command`) value is a command line the shell runs. */
const COMMAND_OPTION_PROGRAM_NAMES = new Set(['su', 'script', 'flock'])
const MAX_COMMAND_STRING_DEPTH = 3

/**
 * A sed option that edits in place. Short options cluster, so the letters before `i` are the ones
 * that take no value: GNU's `-E -n -r -s -u -z -b` and BSD's `-a -l` (GNU's `-l` wants a number,
 * so `-li` fails there, and reading it as an edit is the safe side). BSD also spells in-place `-I`,
 * and GNU accepts any unambiguous prefix of `--in-place`, which `--i` already is.
 */
function isSedInPlaceOption(option: string): boolean {
  const longOption = /^--([a-z-]+)(?:=|$)/.exec(option)
  if (longOption) return longOption[1].startsWith('i') && 'in-place'.startsWith(longOption[1])
  return /^-[abElnrsuz]*[iI]/.test(option)
}

function sedArgsEditInPlace(args: ShellWord[]): boolean {
  for (const arg of args) {
    if (arg.text === '--') return false
    if (isSedInPlaceOption(arg.text)) return true
  }
  return false
}

/**
 * Whether perl's switches ask for in-place editing. Switches cluster (`-pi`, `-0pi`, `-lpi.bak`),
 * and a switch that takes a value ends its cluster (`-Ilib`, `-Mstrict`, `-ne` then its program),
 * so `i` counts only when it is reached as a switch. A bare `-e`, `-E`, or `-I` takes the next word,
 * so a program's text is never read as a switch. Every other word after perl is read, even past the
 * script's name, which errs on the side of an edit.
 */
function perlArgsEditInPlace(args: ShellWord[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index].text
    if (word === '--') return false
    if (!word.startsWith('-') || word.startsWith('--')) continue

    for (let cursor = 1; cursor < word.length; cursor += 1) {
      const letter = word[cursor]
      if (letter === 'i') return true
      if (letter === '0' && (word[cursor + 1] === 'x' || word[cursor + 1] === 'X')) {
        // `-0x0d`: the hexadecimal number is the value of `-0`, and its letters are not switches.
        // Octal digits (`-0777`, `-l015`) are never switch letters, so they need no skipping.
        cursor += 1
        while (/[0-9a-fA-F]/.test(word[cursor + 1] ?? '')) cursor += 1
        continue
      }
      if (letter === 'e' || letter === 'E' || letter === 'I') {
        if (cursor === word.length - 1) index += 1
        break
      }
      // These take the rest of the word as their value.
      if ('CdDFmMVx'.includes(letter)) break
    }
  }
  return false
}

/** The command line in a shell's `-c` value (`bash -c '…'`, `zsh -lc "…"`), or null. */
function shellCommandStringArg(args: ShellWord[]): ShellWord | null {
  for (let index = 0; index < args.length; index += 1) {
    if (!/^-[a-zA-Z]*c[a-zA-Z]*$/.test(args[index].text)) continue
    return args.slice(index + 1).find((arg) => !/^[-+]/.test(arg.text)) ?? null
  }
  return null
}

/** The command line in `su -c '…'`, `script -qc '…'`, or `flock <lock> --command '…'`, or null. */
function commandOptionArg(args: ShellWord[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index].text
    if (/^-[a-zA-Z]*c$/.test(text) || text === '--command') return args[index + 1]?.text ?? null
    if (text.startsWith('--command=')) return text.slice('--command='.length)
  }
  return null
}

/**
 * Whether a command line edits a file in place with sed or perl (Bug Q). It decides from the
 * command's words, never from the raw text: a quoted sed script that only contains ` -i ` is a
 * read, and another command's `-i` next to the letters `sed` or `perl` is not an edit. Every real
 * in-place spelling must stay an edit, because Plan mode lets a read run: sed or perl named by a
 * path, called through `sudo`, `env`, `xargs`, or `find -exec`, run by a shell's `-c`, by `eval`,
 * or from a variable (`$SED -i`, whose text still says what it runs).
 */
export function commandEditsInPlace(line: string, depth = 0): boolean {
  if (depth > MAX_COMMAND_STRING_DEPTH) return false

  for (const words of splitShellSimpleCommands(line)) {
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index]
      const args = words.slice(index + 1)

      if (word.dynamic) {
        if (/sed|perl/i.test(word.text) && (sedArgsEditInPlace(args) || perlArgsEditInPlace(args))) {
          return true
        }
        continue
      }

      const program = shellProgramName(word)
      if (SED_PROGRAM_NAMES.has(program) && sedArgsEditInPlace(args)) return true
      if (PERL_PROGRAM_NAME.test(program) && perlArgsEditInPlace(args)) return true

      const commandString =
        SHELL_PROGRAM_NAMES.has(program)
          ? shellCommandStringArg(args)?.text
          : program === 'eval'
            ? args.map((arg) => arg.text).join(' ')
            : COMMAND_OPTION_PROGRAM_NAMES.has(program)
              ? commandOptionArg(args)
              : null
      if (commandString && commandEditsInPlace(commandString, depth + 1)) return true
    }
  }
  return false
}

function isLiteralInPlaceTarget(word: ShellWord): boolean {
  const text = word.text.trim()
  if (!text || word.dynamic || text.startsWith('-')) return false
  if (text === '{}' || text === '+' || text === ';' || text === '\\;') return false
  if (/^(?:\d*[<>]|&>)/.test(text)) return false
  return true
}

function sedInPlaceTargetPaths(args: ShellWord[]): string[] {
  const operands: ShellWord[] = []
  let hasScriptSource = false

  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]
    const text = word.text

    if (text === '--') {
      operands.push(...args.slice(index + 1))
      break
    }

    if (text.startsWith('-') && text !== '-') {
      if (text === '--expression' || text === '--file') {
        hasScriptSource = true
        index += 1
        continue
      }
      if (text.startsWith('--expression=') || text.startsWith('--file=')) {
        hasScriptSource = true
        continue
      }

      if (isSedInPlaceOption(text)) {
        // BSD sed accepts an empty backup suffix as the following word (`-i ''`, `-I ''`).
        // Preserve that empty shell word in the parser, but never mistake it for the script.
        if (/^-[abElnrsuz]*[iI]$/.test(text) && args[index + 1]?.text === '') index += 1
        continue
      }

      const scriptOption = /^-[abElnrsuz]*([ef])(.*)$/.exec(text)
      if (scriptOption) {
        hasScriptSource = true
        if (!scriptOption[2]) index += 1
      }
      continue
    }

    operands.push(word)
  }

  if (!hasScriptSource) operands.shift()
  return operands.filter(isLiteralInPlaceTarget).map((word) => word.text)
}

function perlInPlaceTargetPaths(args: ShellWord[]): string[] {
  const operands: ShellWord[] = []
  let hasProgramOption = false

  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]
    const text = word.text

    if (text === '--') {
      operands.push(...args.slice(index + 1))
      break
    }

    if (!text.startsWith('-') || text === '-') {
      operands.push(word)
      continue
    }

    for (let cursor = 1; cursor < text.length; cursor += 1) {
      const letter = text[cursor]
      if (letter === 'e' || letter === 'E') {
        hasProgramOption = true
        if (cursor === text.length - 1) index += 1
        break
      }
      if (letter === 'I') {
        if (cursor === text.length - 1) index += 1
        break
      }
      if ('CdDFmMVx'.includes(letter)) break
    }
  }

  if (!hasProgramOption) operands.shift()
  return operands.filter(isLiteralInPlaceTarget).map((word) => word.text)
}

function collectInPlaceEditTargetPaths(line: string, depth: number): string[] {
  if (depth > MAX_COMMAND_STRING_DEPTH) return []

  const targets: string[] = []
  for (const words of splitShellSimpleCommands(line)) {
    let simpleCommandEditsInPlace = false

    for (let index = 0; index < words.length; index += 1) {
      const word = words[index]
      const args = words.slice(index + 1)

      if (word.dynamic) {
        if (/sed/i.test(word.text) && sedArgsEditInPlace(args)) {
          simpleCommandEditsInPlace = true
          targets.push(...sedInPlaceTargetPaths(args))
        }
        if (/perl/i.test(word.text) && perlArgsEditInPlace(args)) {
          simpleCommandEditsInPlace = true
          targets.push(...perlInPlaceTargetPaths(args))
        }
        continue
      }

      const program = shellProgramName(word)
      if (SED_PROGRAM_NAMES.has(program) && sedArgsEditInPlace(args)) {
        simpleCommandEditsInPlace = true
        targets.push(...sedInPlaceTargetPaths(args))
        continue
      }
      if (PERL_PROGRAM_NAME.test(program) && perlArgsEditInPlace(args)) {
        simpleCommandEditsInPlace = true
        targets.push(...perlInPlaceTargetPaths(args))
        continue
      }

      const commandString =
        SHELL_PROGRAM_NAMES.has(program)
          ? shellCommandStringArg(args)?.text
          : program === 'eval'
            ? args.map((arg) => arg.text).join(' ')
            : COMMAND_OPTION_PROGRAM_NAMES.has(program)
              ? commandOptionArg(args)
              : null
      if (commandString && commandEditsInPlace(commandString, depth + 1)) {
        simpleCommandEditsInPlace = true
        targets.push(...collectInPlaceEditTargetPaths(commandString, depth + 1))
      }
    }

    // `find ... -exec sed -i ... {} +` names its mutable population before `-exec`; the
    // placeholder itself is not a path the protected-source scan can resolve.
    if (simpleCommandEditsInPlace) {
      const findIndex = words.findIndex((word) => shellProgramName(word) === 'find')
      if (findIndex !== -1) {
        for (const word of words.slice(findIndex + 1)) {
          if (word.text.startsWith('-')) break
          if (isLiteralInPlaceTarget(word)) targets.push(word.text)
        }
      }
    }
  }

  return targets
}

/** Every literal file operand named by a recognized in-place sed/perl edit. */
export function extractInPlaceEditTargetPaths(line: string): string[] {
  return Array.from(new Set(collectInPlaceEditTargetPaths(line, 0)))
}

/** The file an in-place edit names: the last word of its line, unless that word is an option. */
function extractInPlaceEditTargetPath(shellCommand: string): string | undefined {
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
    let output = ''
    const body = trimmed.slice(2, -1)
    for (let index = 0; index < body.length; index += 1) {
      const char = body[index]
      if (char !== '\\') {
        output += char
        continue
      }

      const next = body[index + 1]
      if (!next) {
        output += char
        continue
      }

      index += 1
      switch (next) {
        case 'n':
          output += '\n'
          break
        case 't':
          output += '\t'
          break
        case 'r':
          output += '\r'
          break
        case '\\':
        case "'":
          output += next
          break
        default:
          output += `\\${next}`
      }
    }
    return output
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

  // An in-place edit stays an edit even when its line names no clean path (`… | cat -n`): read or
  // plain-command mapping would let Plan mode run it.
  const inPlaceEditLines = [...commandLines, primaryCommand].filter((line) => commandEditsInPlace(line))
  if (inPlaceEditLines.length > 0) {
    const inPlaceEditPath = inPlaceEditLines
      .map((line) => extractInPlaceEditTargetPath(line))
      .find((value) => Boolean(value))
    return {
      toolName: 'batshit_server_edit_file',
      args: inPlaceEditPath
        ? { ...normalized, filePath: inPlaceEditPath, path: inPlaceEditPath }
        : normalized,
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
