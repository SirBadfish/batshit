/**
 * BL-252 / BL-253 (2026-09-25): a small quote-aware reader of a Bash command, for the one place
 * that must know exactly which commands a command text runs and where each one ends: the managed
 * `apply_patch` (`parseManagedApplyPatchCommand`). Scanning raw lines mistook quoted text for shell
 * syntax (`rg 'cd src && apply_patch'` looked like a chained command; a quoted `'<<EOF'` hid the
 * next line), and could not find where a quoted argument ends (Cooper's review of `658023429`).
 *
 * It reads the way Bash splits a command, without running or expanding anything:
 * - words with single quotes, double quotes (backslash escapes and `$`/backtick expansions inside),
 *   ANSI-C `$'…'`, backslash escapes and line continuations;
 * - the operators `&&`, `||`, `;`, `|`, `|&`, `&`, `(`, `)` and newlines between commands;
 * - redirects (`>`, `>>`, `<`, `2>&1`, `&>`, `<<<`, …) with their target word;
 * - heredocs (`<<` / `<<-`, quoted or not): the body lines after the operator's line, up to the
 *   delimiter line, belong to the command and are never read as commands;
 * - comments (`#` at the start of a word);
 * - command substitutions (`$(…)`, backticks) that the shell would run, kept as source text so a
 *   caller can read them too.
 * Anything it cannot close (an unterminated quote or heredoc) runs to the end of the text, as Bash
 * reads it. It is a reader for decisions about a command, not a shell: nothing it returns runs.
 */

export interface ShellLexWord {
  /** The word after quote and backslash removal: what the program receives when nothing expands. */
  text: string
  /**
   * The shell would change the word before running it: a `$` expansion, a command substitution,
   * ANSI-C quotes, an unquoted leading `~`, or an unquoted glob character (`*`, `?`, `[`).
   */
  expands: boolean
  /** Command substitutions the shell runs inside this word (`$(…)` or backticks), as source text. */
  substitutions: string[]
}

export interface ShellLexRedirect {
  op: string
  target: ShellLexWord | null
}

export interface ShellLexHeredoc {
  delimiter: string
  /** A quoted delimiter (`<<'EOF'`) keeps the body literal; an unquoted one expands it. */
  quoted: boolean
  stripTabs: boolean
  body: string
  /** False when no delimiter line was found and the body ran to the end of the text. */
  terminated: boolean
}

export type ShellLexSeparator = '&&' | '||' | ';' | '|' | '&' | '(' | ')' | '\n'

export interface ShellLexCommand {
  words: ShellLexWord[]
  redirects: ShellLexRedirect[]
  heredocs: ShellLexHeredoc[]
  /** What ended the command: an operator, a newline, or the end of the text (null). */
  separator: ShellLexSeparator | null
  /**
   * The operator before the command: the separator of the command before it, or `(` when a
   * subshell opens right before it; null at the start of the text. Blank lines keep the operator
   * before them (`cd x &&` then a blank line then a command is still `&&`).
   */
  precededBy: ShellLexSeparator | null
  /** Offsets in the source: where the command starts, and where its separator starts (or the text ends). */
  start: number
  end: number
}

const WORD_BREAK = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>'])
const REDIRECT_AT = /^(\d*)(<<<|<<-|<<|<>|<&|>&|>>|>\||>|<|&>>|&>)/
const EXPANDING_DOLLAR = /[A-Za-z_{0-9@*#?$!-]/

/** The index of the `)` that closes the `(` at `open`, with quotes and nesting; the text end if none. */
function closingParen(source: string, open: number): number {
  let depth = 1
  for (let cursor = open + 1; cursor < source.length; cursor += 1) {
    const char = source[cursor]
    if (char === '\\') {
      cursor += 1
    } else if (char === "'") {
      const close = source.indexOf("'", cursor + 1)
      cursor = close === -1 ? source.length : close
    } else if (char === '"') {
      let close = cursor + 1
      while (close < source.length && source[close] !== '"') close += source[close] === '\\' ? 2 : 1
      cursor = close
    } else if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0) return cursor
    }
  }
  return source.length
}

/** The index of the backtick that closes the one at `open`; the text end if none. */
function closingBacktick(source: string, open: number): number {
  let cursor = open + 1
  while (cursor < source.length && source[cursor] !== '`') cursor += source[cursor] === '\\' ? 2 : 1
  return Math.min(cursor, source.length)
}

/**
 * The command substitutions in text the shell expands the way it expands a double-quoted string
 * (the body of a heredoc with an unquoted delimiter).
 */
export function substitutionsInExpandedText(text: string): string[] {
  const found: string[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') {
      index += 1
    } else if (char === '$' && text[index + 1] === '(') {
      const end = closingParen(text, index + 1)
      found.push(text.slice(index + 2, end))
      index = end
    } else if (char === '`') {
      const end = closingBacktick(text, index)
      found.push(text.slice(index + 1, end))
      index = end
    }
  }
  return found
}

/** `<<-` strips leading tabs from every body line, as the shell does, not only from the delimiter line. */
function bodyText(text: string, stripTabs: boolean): string {
  return stripTabs ? text.split('\n').map((line) => line.replace(/^\t+/, '')).join('\n') : text
}

export function lexShellCommands(source: string): ShellLexCommand[] {
  const commands: ShellLexCommand[] = []
  const pending: ShellLexHeredoc[] = []
  let index = 0
  let before: ShellLexSeparator | null = null
  const fresh = (start: number): ShellLexCommand => ({
    words: [],
    redirects: [],
    heredocs: [],
    separator: null,
    precededBy: before,
    start,
    end: start
  })
  let current = fresh(0)

  const finish = (separator: ShellLexSeparator | null, at: number) => {
    current.separator = separator
    current.end = at
    if (current.words.length || current.redirects.length || current.heredocs.length) {
      commands.push(current)
      before = separator
    } else if (separator !== '\n' || before === null) {
      // An empty command is dropped. A blank line keeps the operator before it; any other operator
      // after nothing (`(`, a stray `;`) becomes what the next command follows.
      before = separator
    }
    current = fresh(at + 1)
  }

  const skipBlanks = () => {
    while (index < source.length && (source[index] === ' ' || source[index] === '\t')) index += 1
  }

  const readWord = (): ShellLexWord | null => {
    let text = ''
    let expands = false
    const substitutions: string[] = []
    let started = false
    while (index < source.length) {
      const char = source[index]
      const next = source[index + 1]
      if (WORD_BREAK.has(char)) break
      if (char === '\\') {
        if (next === '\n') {
          index += 2
          continue
        }
        if (next !== undefined) text += next
        index += 2
        started = true
        continue
      }
      if (char === "'") {
        const close = source.indexOf("'", index + 1)
        const end = close === -1 ? source.length : close
        text += source.slice(index + 1, end)
        index = end + 1
        started = true
        continue
      }
      if (char === '$' && next === "'") {
        // ANSI-C quotes decode escapes: the bytes the program receives are not the visible ones.
        expands = true
        let cursor = index + 2
        while (cursor < source.length && source[cursor] !== "'") {
          if (source[cursor] === '\\' && cursor + 1 < source.length) {
            text += source[cursor + 1]
            cursor += 2
            continue
          }
          text += source[cursor]
          cursor += 1
        }
        index = cursor + 1
        started = true
        continue
      }
      if (char === '"') {
        let cursor = index + 1
        while (cursor < source.length && source[cursor] !== '"') {
          const inner = source[cursor]
          if (inner === '\\' && cursor + 1 < source.length && '$`"\\\n'.includes(source[cursor + 1])) {
            if (source[cursor + 1] !== '\n') text += source[cursor + 1]
            cursor += 2
            continue
          }
          if (inner === '$' && source[cursor + 1] === '(') {
            const end = closingParen(source, cursor + 1)
            substitutions.push(source.slice(cursor + 2, end))
            text += source.slice(cursor, end + 1)
            expands = true
            cursor = end + 1
            continue
          }
          if (inner === '`') {
            const end = closingBacktick(source, cursor)
            substitutions.push(source.slice(cursor + 1, end))
            text += source.slice(cursor, end + 1)
            expands = true
            cursor = end + 1
            continue
          }
          if (inner === '$' && EXPANDING_DOLLAR.test(source[cursor + 1] ?? '')) expands = true
          text += inner
          cursor += 1
        }
        index = cursor + 1
        started = true
        continue
      }
      if (char === '$' && next === '(') {
        const end = closingParen(source, index + 1)
        substitutions.push(source.slice(index + 2, end))
        text += source.slice(index, end + 1)
        expands = true
        index = end + 1
        started = true
        continue
      }
      if (char === '`') {
        const end = closingBacktick(source, index)
        substitutions.push(source.slice(index + 1, end))
        text += source.slice(index, end + 1)
        expands = true
        index = end + 1
        started = true
        continue
      }
      if (char === '$' && EXPANDING_DOLLAR.test(next ?? '')) expands = true
      if (!started && char === '~') expands = true
      if (char === '*' || char === '?' || char === '[') expands = true
      text += char
      index += 1
      started = true
    }
    return started ? { text, expands, substitutions } : null
  }

  const readHeredocBodies = () => {
    // `index` is just past the newline that ended the operator's line.
    for (const heredoc of pending) {
      let lineStart = index
      let found = false
      while (lineStart < source.length) {
        const newline = source.indexOf('\n', lineStart)
        const lineEnd = newline === -1 ? source.length : newline
        const line = source.slice(lineStart, lineEnd)
        // Bash wants the delimiter alone on its line; trailing blanks are forgiven here, and a
        // line after them is then read as a command, never silently kept as data.
        const candidate = (heredoc.stripTabs ? line.replace(/^\t+/, '') : line).replace(/[ \t]+$/, '')
        if (candidate === heredoc.delimiter) {
          heredoc.body = bodyText(source.slice(index, lineStart === index ? index : lineStart - 1), heredoc.stripTabs)
          heredoc.terminated = true
          index = newline === -1 ? source.length : newline + 1
          found = true
          break
        }
        lineStart = newline === -1 ? source.length : newline + 1
      }
      if (!found) {
        heredoc.body = bodyText(source.slice(index), heredoc.stripTabs)
        heredoc.terminated = false
        index = source.length
      }
    }
    pending.length = 0
  }

  while (index < source.length) {
    skipBlanks()
    if (index >= source.length) break
    const char = source[index]
    const next = source[index + 1]

    if (char === '#') {
      const newline = source.indexOf('\n', index)
      index = newline === -1 ? source.length : newline
      continue
    }
    if (char === '\\' && next === '\n') {
      index += 2
      continue
    }
    if (char === '\n') {
      const at = index
      index += 1
      finish('\n', at)
      if (pending.length) readHeredocBodies()
      current.start = index
      continue
    }

    // At a token start, so a leading number is the redirect's file descriptor only when it touches
    // the operator (`2>&1`); `2 > x` reads the word `2` first.
    const redirect = source.slice(index).match(REDIRECT_AT)
    if (redirect) {
      const op = redirect[2]
      if (current.words.length === 0 && current.redirects.length === 0 && current.heredocs.length === 0) current.start = index
      index += redirect[0].length
      skipBlanks()
      if (op === '<<' || op === '<<-') {
        const rawStart = index
        const word = readWord()
        const raw = source.slice(rawStart, index)
        const heredoc: ShellLexHeredoc = {
          delimiter: word?.text ?? '',
          quoted: /['"\\]/.test(raw),
          stripTabs: op === '<<-',
          body: '',
          terminated: false
        }
        current.heredocs.push(heredoc)
        pending.push(heredoc)
      } else {
        current.redirects.push({ op: `${redirect[1]}${op}`, target: readWord() })
      }
      continue
    }

    if (char === '&' && next === '&') {
      finish('&&', index)
      index += 2
      current.start = index
      continue
    }
    if (char === '|' && next === '|') {
      finish('||', index)
      index += 2
      current.start = index
      continue
    }
    if (char === '|') {
      finish('|', index)
      index += next === '&' ? 2 : 1
      current.start = index
      continue
    }
    if (char === ';') {
      finish(';', index)
      index += next === ';' ? 2 : 1
      current.start = index
      continue
    }
    if (char === '&' || char === '(' || char === ')') {
      finish(char as ShellLexSeparator, index)
      index += 1
      current.start = index
      continue
    }

    if (current.words.length === 0 && current.redirects.length === 0 && current.heredocs.length === 0) current.start = index
    const word = readWord()
    if (word) current.words.push(word)
    else index += 1 // a character no rule claims; never loop on it
  }
  finish(null, source.length)
  return commands
}

/** The command's program word (after `NAME=value` assignments), or null. */
export function shellProgramWord(command: ShellLexCommand): { word: ShellLexWord; index: number } | null {
  const index = command.words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text))
  return index === -1 ? null : { word: command.words[index], index }
}

/**
 * True when the text runs a program with this name anywhere the shell would run it: as a command,
 * after any operator, in a subshell, or inside a command substitution (in a word, a redirect
 * target, or the body of a heredoc whose delimiter is unquoted). Quoted text, heredoc data, and
 * arguments (`which apply_patch`, `grep apply_patch x`) never count.
 */
export function shellTextRunsProgram(source: string, program: string, depth = 0): boolean {
  if (depth > 4) return false
  for (const command of lexShellCommands(source)) {
    const name = shellProgramWord(command)?.word.text ?? ''
    if (name === program || name.endsWith(`/${program}`)) return true
    const words = [...command.words, ...command.redirects.flatMap((redirect) => (redirect.target ? [redirect.target] : []))]
    for (const word of words) {
      for (const inner of word.substitutions) if (shellTextRunsProgram(inner, program, depth + 1)) return true
    }
    for (const heredoc of command.heredocs) {
      if (heredoc.quoted) continue
      for (const inner of substitutionsInExpandedText(heredoc.body)) {
        if (shellTextRunsProgram(inner, program, depth + 1)) return true
      }
    }
  }
  return false
}
