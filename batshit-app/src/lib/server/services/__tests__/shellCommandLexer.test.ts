import { describe, expect, it } from 'vitest'
import { lexShellCommands, shellDialectsFor, shellTextRunsProgram, substitutionsInExpandedText } from '$lib/utils/shellCommandLexer'

/**
 * BL-252 / BL-253 (2026-09-25): the quote-aware reader behind the managed apply_patch decision.
 * Each case is a way raw-line scanning got a command wrong (Cooper's review of `658023429`).
 */

const words = (source: string) => lexShellCommands(source).map((command) => command.words.map((word) => word.text))

describe('lexShellCommands', () => {
  it('splits commands at operators outside quotes, and keeps quoted operators as text', () => {
    expect(words("rg -n 'cd src && apply_patch' README.md")).toEqual([['rg', '-n', 'cd src && apply_patch', 'README.md']])
    expect(words('a && b || c; d | e & f')).toEqual([['a'], ['b'], ['c'], ['d'], ['e'], ['f']])
    expect(lexShellCommands('a && b || c; d | e & f').map((command) => command.separator)).toEqual(['&&', '||', ';', '|', '&', null])
    expect(words('echo "x; y && z" \'a | b\'')).toEqual([['echo', 'x; y && z', 'a | b']])
  })

  it('reads quotes and escapes the way the shell removes them', () => {
    expect(words(`printf '%s\\n' "a \\"b\\" c" d\\ e`)).toEqual([['printf', '%s\\n', 'a "b" c', 'd e']])
    expect(words("echo 'one\ntwo'")).toEqual([['echo', 'one\ntwo']])
    expect(words('echo a \\\n b')).toEqual([['echo', 'a', 'b']])
  })

  it('retains raw word ranges before quote and escape removal', () => {
    const source = 'printf "a \\"b\\" c"\nprintf done'
    const word = lexShellCommands(source)[0].words[1]
    expect(word.text).toBe('a "b" c')
    expect(source.slice(word.start, word.end)).toBe('"a \\"b\\" c"')
  })

  it('retains the raw tab-stripped heredoc body range without consuming later commands', () => {
    const source = "cat <<-'EOF'\n\tbody\n\tEOF\nprintf done"
    const heredoc = lexShellCommands(source)[0].heredocs[0]
    expect(heredoc.body).toBe('body')
    expect(source.slice(heredoc.bodyStart, heredoc.bodyEnd)).toBe('\tbody')
    expect(source.slice(heredoc.bodyEnd)).toContain('\n\tEOF\nprintf done')
  })

  it('treats a quoted <<EOF as text, so the next line is still a command', () => {
    const commands = lexShellCommands("printf '%s\\n' '<<EOF'\napply_patch <<'P'\nbody\nP")
    expect(commands.map((command) => command.words[0]?.text)).toEqual(['printf', 'apply_patch'])
    expect(commands[0].heredocs).toEqual([])
    expect(commands[1].heredocs[0]).toMatchObject({ delimiter: 'P', quoted: true, body: 'body', terminated: true })
  })

  it('keeps heredoc bodies out of the command list, and reads the operator line to its end', () => {
    const commands = lexShellCommands("cat <<'EOF' | wc -l\napply_patch is data here\nEOF\necho done")
    expect(commands.map((command) => command.words[0]?.text)).toEqual(['cat', 'wc', 'echo'])
    expect(commands[0].heredocs[0]).toMatchObject({ delimiter: 'EOF', quoted: true, body: 'apply_patch is data here' })
    expect(commands[0].separator).toBe('|')
  })

  it('strips tabs for <<-, forgives trailing blanks on the closing line, and runs an unclosed heredoc to the end', () => {
    expect(lexShellCommands('cat <<-X\n\tbody\n\tX\nls')[0].heredocs[0]).toMatchObject({ body: 'body', terminated: true })
    expect(lexShellCommands('cat <<X\nbody\nX  \nls').map((command) => command.words[0]?.text)).toEqual(['cat', 'ls'])
    expect(lexShellCommands('cat <<X\nbody\nls')[0].heredocs[0]).toMatchObject({ body: 'body\nls', terminated: false })
  })

  it('reads redirects and their targets, and a file descriptor only when it touches the operator', () => {
    const [command] = lexShellCommands('node --test a.js 2>&1 >out.txt')
    expect(command.words.map((word) => word.text)).toEqual(['node', '--test', 'a.js'])
    expect(command.redirects.map((redirect) => [redirect.op, redirect.target?.text])).toEqual([
      ['2>&', '1'],
      ['>', 'out.txt']
    ])
    expect(lexShellCommands('echo 2 > x')[0].words.map((word) => word.text)).toEqual(['echo', '2'])
  })

  it('marks words the shell would change, and keeps the substitutions it would run', () => {
    const [command] = lexShellCommands('echo $HOME ~/x *.md "a$(date)b" `id` \'$literal\' plain')
    expect(command.words.map((word) => word.expands)).toEqual([false, true, true, true, true, true, false, false])
    expect(command.words[4].substitutions).toEqual(['date'])
    expect(command.words[5].substitutions).toEqual(['id'])
  })

  it('drops comments and blank lines, and a blank line keeps the operator before it', () => {
    const commands = lexShellCommands('# note\ncd x &&\n\napply_patch # trailing\n')
    expect(commands.map((command) => command.words[0]?.text)).toEqual(['cd', 'apply_patch'])
    expect(commands[1].precededBy).toBe('&&')
  })

  it('records a subshell opening before a command', () => {
    const commands = lexShellCommands('(cd x && ls)')
    expect(commands[0].precededBy).toBe('(')
    expect(commands[1].separator).toBe(')')
  })
})

/**
 * BL-1992 (2026-10-21): what the shell reads inside a substitution and a quote. Each case hid a
 * command from the Never Allow scan; the real-shell runs are in `nativeTools.test.ts`.
 */
describe('lexShellCommands reads substitutions and quotes as the shell does (BL-1992)', () => {
  const firstSubstitutions = (source: string, dialect?: 'bash' | 'zsh') =>
    lexShellCommands(source, { dialect })[0].words.flatMap((word) => word.substitutions)

  it('removes the backslashes the shell removes from a backtick body before it runs it', () => {
    expect(firstSubstitutions('echo `echo \\`id\\``')).toEqual(['echo `id`'])
    expect(firstSubstitutions('echo `echo \\\\x \\$HOME`')).toEqual(['echo \\x $HOME'])
    // Inside double quotes, `\"` loses its backslash too.
    expect(firstSubstitutions('echo "`echo \\"x\\"`"')).toEqual(['echo "x"'])
    expect(substitutionsInExpandedText('a `echo \\`id\\`` b')).toEqual(['echo `id`'])
  })

  it.each([
    ['a `)` inside "…"', 'echo "$(echo ")"; id)"', 'echo ")"; id'],
    ['a "…" with a substitution holding a `)`', 'echo $(echo "$(echo ")"; id)")', 'echo "$(echo ")"; id)"'],
    ["a `)` inside '…'", "echo \"$(echo ')'; id)\"", "echo ')'; id"],
    ['a comment', 'echo "$( # )\nid\n)"', ' # )\nid\n'],
    ['a heredoc body', 'echo "$(cat <<X\n)\nX\nid\n)"', 'cat <<X\n)\nX\nid\n'],
    ['a `case` pattern', 'echo "$(case x in x) id;; esac)"', 'case x in x) id;; esac'],
    ['a `case` pattern after `(`', 'echo "$(case x in (x) id;; esac)"', 'case x in (x) id;; esac'],
    ['two `case` patterns', 'echo "$(case y in x) :;; y) id;; esac)"', 'case y in x) :;; y) id;; esac'],
    ['a zsh `case x { … }` with a group', 'echo "$(case y { x) { :; } ;; y) id;; })"', 'case y { x) { :; } ;; y) id;; }'],
    ['a zsh `case x { … }` whose first pattern opens with `(`', 'echo "$(case y { (x) { :; } ;; y) id;; })"', 'case y { (x) { :; } ;; y) id;; }'],
    ['a quoted `}` inside `${…}`', 'echo "$(echo ${x:-"}"}; id)"', 'echo ${x:-"}"}; id'],
    ['a `(esac)` pattern (review)', 'echo "$(case e in (esac) :;; e) id;; esac)"', 'case e in (esac) :;; e) id;; esac'],
    ['a `${x:-)}`', 'echo "$(echo ${x:-)}; id)"', 'echo ${x:-)}; id'],
    ['a double-quoted `${…}` holding `")"`', 'echo "$(echo "${x:-")"}"; id)"', 'echo "${x:-")"}"; id'],
    ["a `$')'`", "echo \"$(echo $')'; id)\"", "echo $')'; id"]
  ])('reads a `$(…)` to its own `)` past %s', (_label, source, inner) => {
    expect(firstSubstitutions(source)).toEqual([inner])
  })

  it('decodes ANSI-C escapes as the program receives them', () => {
    const texts = (source: string, dialect?: 'bash' | 'zsh') => lexShellCommands(source, { dialect })[0].words.map((word) => word.text)
    expect(texts("$'tou\\x63h' $'\\164ouch' $'tou\\u0063h' $'tou\\U00000063h' $'\\cA' $'a\\nb' $'\\''")).toEqual([
      'touch', 'touch', 'touch', 'touch', '\x01', 'a\nb', "'"
    ])
    // An escape neither shell knows: bash keeps the backslash, zsh drops it (`$'t\ouch'` runs touch in zsh).
    expect(texts("$'t\\ouch'")).toEqual(['t\\ouch'])
    expect(texts("$'t\\ouch'", 'zsh')).toEqual(['touch'])
    // A code point past Unicode stays as written instead of throwing.
    expect(texts("$'\\U110000'")).toEqual(['\\U110000'])
  })

  it("reads bash's `$\"…\"` as the string inside it", () => {
    expect(lexShellCommands('$"touch" x t$"ouch"')[0].words.map((word) => [word.text, word.expands])).toEqual([
      ['touch', true], ['x', false], ['touch', true]
    ])
  })

  it('reads `${…}` as one piece of a word, and its substitutions', () => {
    expect(words('echo ${x:-a b} ${y:-)} z')).toEqual([['echo', '${x:-a b}', '${y:-)}', 'z']])
    expect(firstSubstitutions('echo ${x:-$(id)} "${y:-$(date)}"')).toEqual(['id', 'date'])
    // Single quotes are quotes inside an unquoted `${…}` in both shells; inside a double-quoted
    // one, a substitution in them runs in both.
    expect(firstSubstitutions("echo ${x:-'$(id)'}")).toEqual([])
    expect(firstSubstitutions("echo \"${x:-'$(id)'}\"")).toEqual(['id'])
  })

  it("reads a `'` inside a double-quoted `${…}` as bash does by default, and as zsh does when asked", () => {
    const source = `echo "\${x:-'}" ; id ; "'}"`
    expect(words(source)).toHaveLength(1)
    expect(lexShellCommands(source, { dialect: 'zsh' }).map((command) => command.words[0]?.text)).toEqual(['echo', 'id', "'}"])
    expect(shellDialectsFor(source)).toEqual(['bash', 'zsh'])
    expect(shellDialectsFor("echo $'x'")).toEqual(['bash', 'zsh'])
    expect(shellDialectsFor('echo "$(id)" ${x}')).toEqual(['bash'])
  })

  it('reads nesting deeper than any real command as running to the end, without overflowing', () => {
    const deep = `${'echo $('.repeat(5000)}id${')'.repeat(5000)}`
    expect(() => lexShellCommands(deep)).not.toThrow()
    expect(() => substitutionsInExpandedText(deep)).not.toThrow()
  })

  it('reads the commands around a `case` as before: each pattern still ends at its `)`', () => {
    const commands = lexShellCommands('case "$1" in -h) echo help;; *) echo run;; esac')
    expect(commands.map((command) => command.words[0]?.text)).toEqual(['case', 'echo', '*', 'echo', 'esac'])
    expect(commands.map((command) => command.separator)).toEqual([')', ';', ')', ';', null])
  })
})

describe('shellTextRunsProgram', () => {
  it.each([
    ['apply_patch <<X\nX', true],
    ['cd src && apply_patch', true],
    ['./apply_patch x', true],
    ['x=$(apply_patch --version)', true],
    ['echo "$(apply_patch)"', true],
    ['cat <<EOF\n$(apply_patch)\nEOF', true],
    ['cat <(apply_patch)', true],
    ['which apply_patch', false],
    ['command -v apply_patch', false],
    ["rg -n 'cd src && apply_patch' README.md", false],
    ["cat <<'EOF'\n$(apply_patch)\nEOF", false],
    ["echo '$(apply_patch)'", false],
    ['# apply_patch\nls', false],
    ['apply_patches', false],
    // BL-1992: forms the lexer used to read as data.
    ['echo `echo \\`apply_patch\\``', true],
    ['echo "$(case x in x) apply_patch;; esac)"', true],
    ['echo "$(echo ")"; apply_patch)"', true],
    ["$'apply\\x5fpatch'", true]
  ])('%j runs apply_patch: %s', (source, expected) => {
    expect(shellTextRunsProgram(source, 'apply_patch')).toBe(expected)
  })
})
