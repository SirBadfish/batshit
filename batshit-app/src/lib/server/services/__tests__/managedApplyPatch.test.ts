import { describe, expect, it } from 'vitest'
import {
  extractManagedApplyPatchDocument,
  isManagedApplyPatchCommand,
  parseManagedApplyPatchCommand
} from '../managedApplyPatch'

/**
 * BL-244 / BL-252 (2026-09-25): how Batshit reads a Bash command that uses the managed
 * `apply_patch`. Measured in SA-126 B0 (32 chats): 45 patch commands began with
 * `cd <folder> &&` and went to the real shell, where there is no `apply_patch` (34 were lost);
 * 87 carried other lines, which the managed path dropped while it reported success (in 39 a test
 * run after the patch never ran).
 */

const PATCH = '*** Begin Patch\n*** Add File: notes/a.md\n+hello\n*** End Patch'
const heredoc = (marker = 'PATCH') => `apply_patch <<'${marker}'\n${PATCH}\n${marker}`

describe('parseManagedApplyPatchCommand: the shapes Batshit applies', () => {
  it.each([
    ['a quoted heredoc', heredoc(), null],
    ['a double-quoted heredoc marker', `apply_patch <<"EOF"\n${PATCH}\nEOF`, null],
    ['an unquoted heredoc marker', `apply_patch <<EOF\n${PATCH}\nEOF`, null],
    ['a tab-stripping heredoc', `apply_patch <<-'EOF'\n${PATCH}\n\t\tEOF`, null],
    ['a terminator with trailing blanks', `apply_patch <<'EOF'\n${PATCH}\nEOF   `, null],
    ['no terminator at all', `apply_patch <<'EOF'\n${PATCH}`, null],
    ['variable assignments before it', `LC_ALL=C FOO=1 apply_patch <<'P'\n${PATCH}\nP`, null],
    ['blank and comment lines around it', `\n# fix the notes\n${heredoc()}\n\n# done\n`, null],
    ['the patch as a quoted argument', `apply_patch '${PATCH}'`, null],
    ['bare patch lines', `apply_patch\n${PATCH}`, null],
    ['cd <folder> && in front', `cd src && ${heredoc()}`, 'src'],
    ['an absolute cd target', `cd /private/tmp/work-1/app && ${heredoc()}`, '/private/tmp/work-1/app'],
    ['a single-quoted cd target', `cd 'my notes' && ${heredoc()}`, 'my notes'],
    ['a double-quoted cd target', `cd "my notes" && ${heredoc()}`, 'my notes'],
    ['cd on its own line', `cd src\n${heredoc()}`, 'src'],
    ['set lines, then cd, then the patch', `set -euo pipefail\ncd /w\n${heredoc()}`, '/w'],
    ['a set line after the cd', `cd src\nset -e\n${heredoc()}`, 'src'],
    ['a relative cd with ..', `cd ../other && ${heredoc()}`, '../other'],
    ['underscores and dashes in the cd target', `cd my_app/src-2 && ${heredoc()}`, 'my_app/src-2'],
    ['a quoted patch whose closing quote is on the next line', `apply_patch '${PATCH}\n'`, null],
    ['a double-quoted patch without expansions', `apply_patch "${PATCH}"`, null],
    ['a heredoc marker with a comment after it', `apply_patch <<'PATCH' # the fix\n${PATCH}\nPATCH`, null],
    ['&& at the end of the cd line', `cd src &&\n${heredoc()}`, 'src'],
    ['cd && set -e, then the patch on the next line (seen in SA-126 B0)', `cd src && set -e\n${heredoc()}`, 'src'],
    ['set -e && cd && apply_patch on one line', `set -e && cd src && ${heredoc()}`, 'src'],
    // Cooper's second review, BL-262: parentheses in bare patch lines are data, not a subshell.
    ['bare patch lines after cd &&', `cd src && apply_patch\n${PATCH}`, 'src'],
    ['cd <folder> || exit 1, then the patch (seen in SA-126 B0)', `cd src || exit 1\n${heredoc()}`, 'src'],
    ['cd <folder> || exit && apply_patch', `cd src || exit && ${heredoc()}`, 'src']
  ])('%s', (_label, command, cdPath) => {
    const parsed = parseManagedApplyPatchCommand(command)
    expect(parsed).toEqual({ kind: 'managed', cdPath, document: PATCH })
    expect(isManagedApplyPatchCommand(command)).toBe(true)
    expect(extractManagedApplyPatchDocument(command)).toBe(PATCH)
  })

  it("reads bare patch lines as data, so code parentheses are not a subshell (Cooper's second review, BL-262)", () => {
    const document = '*** Begin Patch\n*** Add File: x.js\n+function hello() { return (1); }\n+)(\n*** End Patch'
    expect(parseManagedApplyPatchCommand(`apply_patch\n${document}`)).toEqual({ kind: 'managed', cdPath: null, document })
    // A real group around a bare patch is still refused.
    expect(parseManagedApplyPatchCommand(`(apply_patch\n${document})`).kind).toBe('refused')
    // So is a command after the bare patch.
    expect(parseManagedApplyPatchCommand(`apply_patch\n${document}\nnpm test`).kind).toBe('refused')
  })

  it('keeps a command without a patch managed, so the executor reports the missing payload', () => {
    expect(parseManagedApplyPatchCommand('apply_patch')).toEqual({ kind: 'managed', cdPath: null, document: null })
    expect(parseManagedApplyPatchCommand("apply_patch <<'P'\nhello\nP")).toEqual({
      kind: 'managed',
      cdPath: null,
      document: null
    })
  })
})

describe('parseManagedApplyPatchCommand: shapes refused before anything runs (BL-252)', () => {
  it.each([
    ['a test after the terminator', `${heredoc()}\nnode --test test/a.test.js 2>&1 | tail -5`, /separate call: `node --test test\/a\.test\.js 2>&1 \| tail -5`/],
    ['a command after the terminator on a cd form', `cd src && ${heredoc()}\nnpm test`, /separate call: `npm test`/],
    ['a command before the patch', `grep -n skip src/a.js\n${heredoc()}`, /separate call: `grep -n skip src\/a\.js`/],
    ['a command chained before it', `npm test && ${heredoc()}`, /whole command/],
    ['input piped into it', `cd src && cat <<'PATCH' | apply_patch\n${PATCH}\nPATCH`, /whole command/],
    ['a probe chained before it', `command -v apply_patch && ${heredoc()}`, /whole command/],
    ['a redirect on its line', `apply_patch > /dev/null 2>&1 <<'P'\n${PATCH}\nP`, /nothing else on its line/],
    ['a flag', 'apply_patch --version', /nothing else on its line/],
    ['text after the quoted argument', `apply_patch '${PATCH}' && npm test`, /whole command/],
    ['a second patch in the same command', `${heredoc('A')}\n${heredoc('B')}`, /separate call/],
    ['a variable in the cd', `cd $HOME/app && ${heredoc()}`, /must name one folder/],
    ['a tilde in the cd', `cd ~/app && ${heredoc()}`, /must name one folder/],
    ['a glob in the cd', `cd src/* && ${heredoc()}`, /must name one folder/],
    ['two words in the cd', `cd my notes && ${heredoc()}`, /must name one folder/],
    ['an option in the cd', `cd -P src && ${heredoc()}`, /must name one folder/],
    ['a quoted option in the cd', `cd '-x' && ${heredoc()}`, /must name one folder/],
    ['two cds', `cd a\ncd b && ${heredoc()}`, /must name one folder/],
    ['two chained cds', `cd a && cd b && ${heredoc()}`, /must name one folder/],
    ['a cd with a semicolon', `cd src; ${heredoc()}`, /must name one folder/],
    // Cooper's review of 658023429, P1: the patch was taken from printf's argument, not apply_patch's.
    ['a patch that is another command\'s argument', `apply_patch 'not a patch' && printf '%s' '${PATCH}'`, /separate call: `printf/],
    // P2: a quoted '<<EOF' is text, not a heredoc, so the next line is still a command.
    ['a quoted heredoc look-alike before the patch', `printf '%s\\n' '<<EOF'\n${heredoc()}`, /separate call: `printf/],
    // BL-254: the folder would be trimmed to its sibling.
    ['a cd folder with a trailing space', `cd 'app ' && ${heredoc()}`, /spaces at either end/],
    ['a cd folder with a leading space', `cd " app" && ${heredoc()}`, /spaces at either end/],
    ['a double-quoted patch with an expansion', `apply_patch "${PATCH}$HOME"`, /must not contain `\$` expansions/],
    ['apply_patch inside a command substitution', 'x=$(apply_patch --version)', /whole command/],
    ['apply_patch in an unquoted heredoc body substitution', "cat <<EOF\n$(apply_patch --version)\nEOF", /whole command/],
    ['apply_patch in a subshell', `(cd src && ${heredoc()})`, /whole command|must name one folder/],
    ['a dangling operator after a quoted patch', `apply_patch '${PATCH}' &&`, /whole command/],
    // An unclosed heredoc swallows the lines after it as data: refused, not silently ignored.
    ['a heredoc whose closing line is missing, with a command after the patch', `apply_patch <<'PATCH'\n${PATCH}\nPATCHX\nnpm test`, /must end at `\*\*\* End Patch`/],
    ['text after End Patch inside the heredoc', `apply_patch <<'PATCH'\n${PATCH}\nnpm test\nPATCH`, /must end at `\*\*\* End Patch`/],
    ['text before Begin Patch inside the heredoc', `apply_patch <<'PATCH'\nnotes first\n${PATCH}\nPATCH`, /must start at `\*\*\* Begin Patch`/],
    ['a stray operator before the patch', `; ${heredoc()}`, /whole command/],
    // Cooper's second review, BL-261: the shell would run the substitution; Batshit would skip it.
    ['cd <folder> || another command', `cd src || echo missing\n${heredoc()}`, /must name one folder/],
    ['cd <folder> || exit with an expanding code', `cd src || exit $CODE\n${heredoc()}`, /must name one folder/],
    ['an assignment with a command substitution', `CHECK=$(touch ran.txt) ${heredoc()}`, /no variable assignments that expand/],
    ['an assignment with backticks', `CHECK=\`touch ran.txt\` ${heredoc()}`, /no variable assignments that expand/],
    ['an assignment with a variable', `DIR=$HOME ${heredoc()}`, /no variable assignments that expand/],
    ['an unquoted heredoc whose patch holds a substitution', `apply_patch <<EOF\n*** Begin Patch\n*** Add File: a.md\n+$(touch ran.txt)\n*** End Patch\nEOF`, /quote the delimiter/],
    ['an unquoted heredoc whose patch holds backticks', 'apply_patch <<EOF\n*** Begin Patch\n*** Add File: a.js\n+const s = `x`\n*** End Patch\nEOF', /quote the delimiter/]
  ])('%s', (_label, command, reason) => {
    const parsed = parseManagedApplyPatchCommand(command)
    expect(parsed.kind).toBe('refused')
    expect(parsed.kind === 'refused' ? parsed.reason : '').toMatch(reason)
    expect(parsed.kind === 'refused' ? parsed.reason : '').toMatch(/Nothing ran|not applied/)
    // Still managed: the executor answers it, so no part of it reaches a shell.
    expect(isManagedApplyPatchCommand(command)).toBe(true)
    // Never auto-allowed as a managed patch: the approval check sees no patch to apply.
    expect(extractManagedApplyPatchDocument(command)).toBeNull()
  })
})

describe('parseManagedApplyPatchCommand: ordinary shell commands', () => {
  it.each([
    ['a which probe', 'which apply_patch'],
    ['a command -v probe', 'command -v apply_patch'],
    ['a type probe', 'type apply_patch'],
    ['a search for the word', 'grep -rn apply_patch docs/'],
    ['an echo of the word', 'echo apply_patch'],
    ['a heredoc body that mentions it', "cat > notes.md <<'EOF'\napply_patch is built in\nEOF"],
    ['a plain cd', 'cd src && ls'],
    ['a cd Batshit could not follow, without apply_patch', 'cd $HOME && ls'],
    ['a longer name', 'apply_patches --list'],
    // Cooper's review, P2: quoted text is data, not a chained command.
    ['a search whose pattern holds a chained apply_patch', "rg -n 'cd src && apply_patch' README.md"],
    ['a double-quoted mention', 'echo "run apply_patch now; then test"'],
    ['multi-line quoted text with apply_patch on its own line', "echo 'first\napply_patch <<X\nsecond'"],
    ['a comment that mentions it', '# apply_patch later\nls'],
    ['a quoted heredoc body with a substitution in it', "cat <<'EOF'\n$(apply_patch --version)\nEOF"]
  ])('%s', (_label, command) => {
    expect(parseManagedApplyPatchCommand(command)).toEqual({ kind: 'none' })
    expect(isManagedApplyPatchCommand(command)).toBe(false)
    expect(extractManagedApplyPatchDocument(command)).toBeNull()
  })
})
