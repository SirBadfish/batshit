import { describe, expect, it } from 'vitest'
import { lexShellCommands, shellTextRunsProgram } from '../shellCommandLexer'

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
    ['apply_patches', false]
  ])('%j runs apply_patch: %s', (source, expected) => {
    expect(shellTextRunsProgram(source, 'apply_patch')).toBe(expected)
  })
})
