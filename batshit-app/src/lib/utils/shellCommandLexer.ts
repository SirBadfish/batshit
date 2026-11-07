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
 *
 * BL-1992 (2026-10-21): it also reads what the shell reads inside a substitution and a quote, so the
 * Never Allow check sees every command the text runs. A `$(…)` is read as commands to its own `)`
 * (quotes and the substitutions inside them, comments, heredoc bodies, `case` patterns and `${…}`;
 * counting parentheses closed it early on a `)` in any of them); a backtick body loses the
 * backslashes the shell removes before it runs it (`` `echo \`id\`` ``); `$'…'` decodes its
 * escapes (`$'tou\x63h'` is `touch`); bash's `$"…"` is the string inside it.
 */

export interface ShellLexWord {
  /** Raw word boundaries in the exact source passed to the reader, before quote removal. */
  start: number
  end: number
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
  /** Raw body boundaries, excluding the delimiter and its preceding newline. */
  bodyStart: number
  bodyEnd: number
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

/**
 * BL-1992: bash and zsh read two things differently. Inside a double-quoted `${…}`, bash reads
 * `'…'` as quotes (`"${x:-'}'}"` is one word) and zsh reads `'` as a plain character (the `}`
 * closes it); in `$'…'`, an escape neither knows keeps its backslash in bash and loses it in zsh
 * (`$'t\ouch'` runs `touch` in zsh). Each reading can hide a command the other runs, so a check
 * that must see every command reads both (`shellDialectsFor`). The default is bash.
 */
export type ShellLexDialect = 'bash' | 'zsh'

export interface ShellLexOptions {
  dialect?: ShellLexDialect
}

/** The readings a check that must see every command needs: zsh's can differ only in these forms. */
export function shellDialectsFor(source: string): ShellLexDialect[] {
  const mayDiffer = source.includes("$'") || (source.includes('${') && source.includes('"') && source.includes("'"))
  return mayDiffer ? ['bash', 'zsh'] : ['bash']
}

const WORD_BREAK = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>'])
const REDIRECT_AT = /^(\d*)(<<<|<<-|<<|<>|<&|>&|>>|>\||>|<|&>>|&>)/
const EXPANDING_DOLLAR = /[A-Za-z_{0-9@*#?$!-]/
/** Nesting deeper than this is read as running to the end of the text, never as a stack overflow. */
const MAX_NESTING = 64

/**
 * The index of the `)` that closes the `(` at `open`; the text end if none. BL-1992: the text inside
 * is read as commands, as the shell reads it, to its own `)` (`lexFrom`). Counting parentheses
 * closed it early on a `)` inside `"…"` in it, a comment, a heredoc body, a `case` pattern or
 * `${x:-)}`, and the rest of the text was then read as data.
 */
function closingParen(source: string, open: number, nesting: number, dialect: ShellLexDialect): number {
  if (nesting > MAX_NESTING) return source.length
  return lexFrom(source, open + 1, true, nesting, dialect).end
}

/** The index of the backtick that closes the one at `open`; the text end if none. */
function closingBacktick(source: string, open: number): number {
  let cursor = open + 1
  while (cursor < source.length && source[cursor] !== '`') cursor += source[cursor] === '\\' ? 2 : 1
  return Math.min(cursor, source.length)
}

/**
 * The commands inside backticks as the shell runs them: a backslash before `$`, a backtick or a
 * backslash is removed first (inside double quotes, before `"` too). BL-1992: the body was kept as
 * written, so the inner substitution of `` `echo \`id\`` `` was never read.
 */
function backtickBody(source: string, open: number, close: number, inDoubleQuotes: boolean): string {
  return source.slice(open + 1, close).replace(inDoubleQuotes ? /\\([$`\\"])/g : /\\([$`\\])/g, '$1')
}

/** The index of the `'` that closes an ANSI-C quote whose opening `'` is at `open` (`\'` does not). */
function closingAnsiC(source: string, open: number): number {
  let cursor = open + 1
  while (cursor < source.length && source[cursor] !== "'") cursor += source[cursor] === '\\' ? 2 : 1
  return Math.min(cursor, source.length)
}

const ANSI_C_LETTERS: Record<string, string> = {
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
  '\\': '\\', "'": "'", '"': '"', '?': '?'
}
const ANSI_C_NUMBER = /^(?:([0-7]{1,3})|x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8}))/

/**
 * The body of `$'…'` as the program receives it: the escapes bash and zsh share (`\n` and the other
 * letters, octal `\nnn`, `\xHH`, `\uHHHH`, `\UHHHHHHHH`, `\cX`). BL-1992: only the backslash was
 * removed before, so `$'tou\x63h'` read as `toux63h` while the shell ran `touch`.
 */
function decodeAnsiC(body: string, dialect: ShellLexDialect): string {
  let text = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    const next = body[index + 1]
    if (char !== '\\' || next === undefined) {
      text += char
      continue
    }
    const number = body.slice(index + 1).match(ANSI_C_NUMBER)
    const codePoint = number
      ? number[1] !== undefined ? parseInt(number[1], 8) & 0xff : parseInt(number[2] ?? number[3] ?? number[4], 16)
      : null
    if (Object.hasOwn(ANSI_C_LETTERS, next)) {
      text += ANSI_C_LETTERS[next]
      index += 1
    } else if (number && codePoint !== null && codePoint <= 0x10ffff) {
      text += String.fromCodePoint(codePoint)
      index += number[0].length
    } else if (next === 'c' && index + 2 < body.length) {
      text += String.fromCharCode(body.charCodeAt(index + 2) & 0x1f)
      index += 2
    } else if (dialect === 'zsh') {
      // An escape zsh does not know loses its backslash; bash keeps it (`$'\q'`).
      text += next
      index += 1
    } else {
      text += char
    }
  }
  return text
}

/**
 * The index of the `}` that closes a `${` whose `{` is at `open`; the text end if none. Quotes
 * inside it are quotes (`${x:-'}'}`), except a `'` inside a double-quoted one in zsh
 * (`ShellLexDialect`).
 */
function closingBrace(source: string, open: number, nesting: number, dialect: ShellLexDialect, inDoubleQuotes: boolean): number {
  if (nesting > MAX_NESTING) return source.length
  let depth = 1
  for (let cursor = open + 1; cursor < source.length; cursor += 1) {
    const char = source[cursor]
    const next = source[cursor + 1]
    if (char === '\\') {
      cursor += 1
    } else if (char === '$' && next === '(') {
      cursor = closingParen(source, cursor + 1, nesting + 1, dialect)
    } else if (char === '$' && next === '{') {
      depth += 1
      cursor += 1
    } else if (char === '$' && next === "'" && !inDoubleQuotes) {
      cursor = closingAnsiC(source, cursor + 1)
    } else if (char === '`') {
      cursor = closingBacktick(source, cursor)
    } else if (char === '"') {
      cursor = closingDoubleQuote(source, cursor, nesting + 1, dialect)
    } else if (char === "'" && !(inDoubleQuotes && dialect === 'zsh')) {
      const close = source.indexOf("'", cursor + 1)
      cursor = close === -1 ? source.length : close
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return cursor
    }
  }
  return source.length
}

/** The index of the `"` that closes the one at `open`, reading the substitutions and `${…}` inside it. */
function closingDoubleQuote(source: string, open: number, nesting: number, dialect: ShellLexDialect): number {
  if (nesting > MAX_NESTING) return source.length
  let cursor = open + 1
  while (cursor < source.length && source[cursor] !== '"') {
    const char = source[cursor]
    const next = source[cursor + 1]
    if (char === '\\') cursor += 2
    else if (char === '$' && next === '(') cursor = closingParen(source, cursor + 1, nesting + 1, dialect) + 1
    else if (char === '$' && next === '{') cursor = closingBrace(source, cursor + 1, nesting + 1, dialect, true) + 1
    else if (char === '`') cursor = closingBacktick(source, cursor) + 1
    else cursor += 1
  }
  return Math.min(cursor, source.length)
}

/**
 * The command substitutions in text the shell expands the way it expands a double-quoted string
 * (the body of a heredoc with an unquoted delimiter, and the inside of a `${…}`).
 */
export function substitutionsInExpandedText(text: string, options: ShellLexOptions = {}): string[] {
  return expandedTextSubstitutions(text, 0, options.dialect ?? 'bash', false)
}

/**
 * `skipSingleQuoted`: the inside of an unquoted `${…}`, where both shells read `'…'` as quotes.
 * Inside a double-quoted one, a substitution within `'…'` runs in both (`"${x:-'$(id)'}"`).
 */
function expandedTextSubstitutions(text: string, nesting: number, dialect: ShellLexDialect, skipSingleQuoted: boolean): string[] {
  const found: string[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') {
      index += 1
    } else if (char === "'" && skipSingleQuoted) {
      const close = text.indexOf("'", index + 1)
      index = close === -1 ? text.length : close
    } else if (char === '$' && text[index + 1] === '(') {
      const end = closingParen(text, index + 1, nesting + 1, dialect)
      found.push(text.slice(index + 2, end))
      index = end
    } else if (char === '`') {
      const end = closingBacktick(text, index)
      found.push(backtickBody(text, index, end, false))
      index = end
    }
  }
  return found
}

/** `<<-` strips leading tabs from every body line, as the shell does, not only from the delimiter line. */
function bodyText(text: string, stripTabs: boolean): string {
  return stripTabs ? text.split('\n').map((line) => line.replace(/^\t+/, '')).join('\n') : text
}

export function lexShellCommands(source: string, options: ShellLexOptions = {}): ShellLexCommand[] {
  return lexFrom(source, 0, false, 0, options.dialect ?? 'bash').commands
}

interface ShellLexCase {
  /** The parenthesis depth the `case` opened at: only a `)` at that depth ends one of its patterns. */
  depth: number
  state: 'subject' | 'in' | 'pattern' | 'body'
  /** `esac`, or `}` for zsh's `case x { … }`. */
  closer: string
  /** Words read in the current pattern: a `(` before the first one opens nothing. */
  patternWords: number
  /** The current pattern opened with `(`: its first word is a pattern even when it reads `esac`. */
  patternOpened: boolean
  /** `{ … }` groups open in the current body, so their `}` is not zsh's closer. */
  groups: number
}

/**
 * Reads commands from `from`. With `untilClose`, it stops at the `)` that closes the substitution
 * the text starts inside (`closingParen`) and returns its index as `end`.
 */
function lexFrom(
  source: string,
  from: number,
  untilClose: boolean,
  nesting: number,
  dialect: ShellLexDialect
): { commands: ShellLexCommand[]; end: number } {
  const commands: ShellLexCommand[] = []
  const pending: ShellLexHeredoc[] = []
  let index = from
  let before: ShellLexSeparator | null = null
  // BL-1992: parentheses opened inside the text, and the `case` statements open in it: a pattern's
  // `)` (`case x in x) …`) ends the pattern, not a subshell or the substitution.
  let depth = 0
  const cases: ShellLexCase[] = []
  const caseAtDepth = () => {
    const top = cases[cases.length - 1]
    return top !== undefined && top.depth === depth ? top : null
  }
  const fresh = (start: number): ShellLexCommand => ({
    words: [],
    redirects: [],
    heredocs: [],
    separator: null,
    precededBy: before,
    start,
    end: start
  })
  let current = fresh(from)

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
    const start = index
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
        const close = closingAnsiC(source, index + 1)
        text += decodeAnsiC(source.slice(index + 2, close), dialect)
        index = close + 1
        started = true
        continue
      }
      if (char === '$' && next === '"') {
        // BL-1992: bash's `$"…"` is the double-quoted string, translated for the locale (`$"touch"`
        // runs `touch`); zsh reads a plain `$` before it (`$touch`), which runs no such program.
        expands = true
        index += 1
        continue
      }
      if (char === '$' && next === '{') {
        // BL-1992: `${…}` is one piece of the word, so a `)` or quote inside it (`${x:-)}`) neither
        // ends the word nor closes an enclosing `$(…)`.
        const close = closingBrace(source, index + 1, nesting + 1, dialect, false)
        substitutions.push(...expandedTextSubstitutions(source.slice(index + 2, close), nesting + 1, dialect, true))
        text += source.slice(index, close + 1)
        expands = true
        index = close + 1
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
            const end = closingParen(source, cursor + 1, nesting + 1, dialect)
            substitutions.push(source.slice(cursor + 2, end))
            text += source.slice(cursor, end + 1)
            expands = true
            cursor = end + 1
            continue
          }
          if (inner === '$' && source[cursor + 1] === '{') {
            const end = closingBrace(source, cursor + 1, nesting + 1, dialect, true)
            substitutions.push(...expandedTextSubstitutions(source.slice(cursor + 2, end), nesting + 1, dialect, false))
            text += source.slice(cursor, end + 1)
            expands = true
            cursor = end + 1
            continue
          }
          if (inner === '`') {
            const end = closingBacktick(source, cursor)
            substitutions.push(backtickBody(source, cursor, end, true))
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
        const end = closingParen(source, index + 1, nesting + 1, dialect)
        substitutions.push(source.slice(index + 2, end))
        text += source.slice(index, end + 1)
        expands = true
        index = end + 1
        started = true
        continue
      }
      if (char === '`') {
        const end = closingBacktick(source, index)
        substitutions.push(backtickBody(source, index, end, false))
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
    return started ? { text, expands, substitutions, start, end: Math.min(index, source.length) } : null
  }

  const readHeredocBodies = () => {
    // `index` is just past the newline that ended the operator's line.
    for (const heredoc of pending) {
      heredoc.bodyStart = index
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
          heredoc.bodyEnd = lineStart === index ? index : lineStart - 1
          heredoc.body = bodyText(source.slice(index, heredoc.bodyEnd), heredoc.stripTabs)
          heredoc.terminated = true
          index = newline === -1 ? source.length : newline + 1
          found = true
          break
        }
        lineStart = newline === -1 ? source.length : newline + 1
      }
      if (!found) {
        heredoc.bodyEnd = source.length
        heredoc.body = bodyText(source.slice(index), heredoc.stripTabs)
        heredoc.terminated = false
        index = source.length
      }
    }
    pending.length = 0
  }

  // How a word moves an open `case` along: `case`, its word, `in` (or zsh's `{`), then patterns
  // and bodies until `esac` (or `}`) as a command's first word.
  const noteCaseWord = (raw: string, atStart: boolean) => {
    const open = caseAtDepth()
    if (open) {
      if (open.state === 'subject') {
        open.state = 'in'
        return
      }
      if (open.state === 'in') {
        if (raw === 'in' || raw === '{') {
          open.state = 'pattern'
          open.closer = raw === '{' ? '}' : 'esac'
          open.patternWords = 0
          open.patternOpened = false
        }
        return
      }
      if (open.state === 'pattern') {
        // `esac` (or `}`) ends the `case` only as a pattern's first word with no `(` before it:
        // `(esac)` is a pattern (BL-1992 review).
        if (atStart && raw === open.closer && open.patternWords === 0 && !open.patternOpened) cases.pop()
        else open.patternWords += 1
        return
      }
      if (atStart && raw === '{') open.groups += 1
      else if (atStart && raw === '}' && open.groups > 0) open.groups -= 1
      else if (atStart && raw === open.closer) {
        cases.pop()
        return
      }
    }
    if (atStart && raw === 'case') cases.push({ depth, state: 'subject', closer: 'esac', patternWords: 0, patternOpened: false, groups: 0 })
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
          bodyStart: source.length,
          bodyEnd: source.length,
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
      // `;;`, `;&`, `;;&` and zsh's `;|` end a `case` body: the next word is a pattern.
      const open = caseAtDepth()
      if (open?.state === 'body' && (next === ';' || next === '&' || next === '|')) {
        open.state = 'pattern'
        open.patternWords = 0
        open.patternOpened = false
        open.groups = 0
      }
      finish(';', index)
      index += next === ';' ? 2 : 1
      current.start = index
      continue
    }
    if (char === ')') {
      const open = caseAtDepth()
      if (open?.state === 'pattern') open.state = 'body'
      else if (depth > 0) depth -= 1
      else if (untilClose) return { commands, end: index }
    }
    if (char === '(') {
      // A `(` before a pattern (`case x in (x) …`) opens nothing.
      const open = caseAtDepth()
      if (open?.state === 'pattern' && open.patternWords === 0 && !open.patternOpened) open.patternOpened = true
      else depth += 1
    }
    if (char === '&' || char === '(' || char === ')') {
      finish(char as ShellLexSeparator, index)
      index += 1
      current.start = index
      continue
    }

    if (current.words.length === 0 && current.redirects.length === 0 && current.heredocs.length === 0) current.start = index
    const atStart = current.words.length === 0
    const word = readWord()
    if (word) {
      current.words.push(word)
      noteCaseWord(source.slice(word.start, word.end), atStart)
    } else index += 1 // a character no rule claims; never loop on it
  }
  finish(null, source.length)
  return { commands, end: source.length }
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
