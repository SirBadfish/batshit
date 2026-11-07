import { describe, expect, it } from 'vitest'
import {
  describeAfterPatchForApproval,
  extractManagedApplyPatchDocument,
  isManagedApplyPatchCommand,
  managedApplyPatchPolicySource,
  parseManagedApplyPatchCommand,
  parseManagedApplyPatchDocument
} from '$lib/utils/managedApplyPatch'

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
    expect(parsed).toEqual({ kind: 'managed', cdPath, document: PATCH,
      payloadRange: { start: expect.any(Number), end: expect.any(Number) } })
    expect(isManagedApplyPatchCommand(command)).toBe(true)
    expect(extractManagedApplyPatchDocument(command)).toBe(PATCH)
  })

  it("reads bare patch lines as data, so code parentheses are not a subshell (Cooper's second review, BL-262)", () => {
    const document = '*** Begin Patch\n*** Add File: x.js\n+function hello() { return (1); }\n+)(\n*** End Patch'
    expect(parseManagedApplyPatchCommand(`apply_patch\n${document}`)).toEqual({ kind: 'managed', cdPath: null, document,
      payloadRange: { start: 'apply_patch\n'.length, end: 'apply_patch\n'.length + document.length } })
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
    ['a command before the patch', `grep -n skip src/a.js\n${heredoc()}`, /separate call: `grep -n skip src\/a\.js`/],
    ['a command chained before it', `npm test && ${heredoc()}`, /whole command/],
    ['input piped into it', `cd src && cat <<'PATCH' | apply_patch\n${PATCH}\nPATCH`, /whole command/],
    ['a probe chained before it', `command -v apply_patch && ${heredoc()}`, /whole command/],
    ['a redirect on its line', `apply_patch > /dev/null 2>&1 <<'P'\n${PATCH}\nP`, /nothing else on its line/],
    ['a flag', 'apply_patch --version', /nothing else on its line/],
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
    // BL-1915, item 2b: after the patch, new lines, `&&`, `;` or `||` lead to commands that are
    // named (and run or not); a pipe or `&` right after the patch is refused.
    ['a pipe after the heredoc marker', `apply_patch <<'PATCH' | tee log.txt\n${PATCH}\nPATCH`, /separate call: `tee log\.txt`/],
    ['& after the heredoc marker', `apply_patch <<'PATCH' & npm test\n${PATCH}\nPATCH`, /separate call: `npm test`/],
    ['a second patch hidden in a substitution after the patch', `${heredoc()}\necho $(apply_patch --version)`, /separate call: `echo \$\(apply_patch --version\)`/],
    ['a command after a heredoc that holds no patch', `apply_patch <<'PATCH'\nhello\nPATCH\nnpm test`, /separate call: `npm test`/],
    ['text after End Patch inside the heredoc, with a command after it', `apply_patch <<'PATCH'\n${PATCH}\nnotes\nPATCH\nnpm test`, /must end at `\*\*\* End Patch`, found `notes` after it\. Nothing ran\./],
    // An unclosed heredoc swallows the lines after it as data: refused, not silently ignored.
    ['a heredoc whose closing line is missing, with a command after the patch', `apply_patch <<'PATCH'\n${PATCH}\nPATCHX\nnpm test`, /must end at `\*\*\* End Patch`/],
    ['text after End Patch inside the heredoc', `apply_patch <<'PATCH'\n${PATCH}\nnpm test\nPATCH`, /must end at `\*\*\* End Patch`, found `npm test` after it \(is the heredoc's closing line missing\?\)/],
    ['text before Begin Patch inside the heredoc', `apply_patch <<'PATCH'\nnotes first\n${PATCH}\nPATCH`, /must start at `\*\*\* Begin Patch`/],
    // BL-1990 (seen in SA-126 arm A3): a patch with no end line names that fault, with a command
    // after it or not, as a heredoc or a quoted argument.
    ['a heredoc patch with no End Patch line, and a test after it', `cd src && apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: a.js\n@@\n-old\n+new\nPATCH\nnpm test`, /runs from `\*\*\* Begin Patch` to `\*\*\* End Patch`: it has `\*\*\* Begin Patch` but no `\*\*\* End Patch` line after it; add `\*\*\* End Patch` as the patch's last line/],
    ['a heredoc patch with no End Patch line', `apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: a.md\n+hi\nPATCH`, /no `\*\*\* End Patch` line after it/],
    ['a quoted patch with no End Patch line', `apply_patch '*** Begin Patch\n*** Add File: a.md\n+hi'`, /no `\*\*\* End Patch` line after it/],
    ['an End Patch line before Begin Patch', `apply_patch <<'PATCH'\n*** End Patch\n*** Begin Patch\n*** Add File: a.md\n+hi\nPATCH`, /no `\*\*\* End Patch` line after it/],
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

describe('parseManagedApplyPatchCommand: commands after the patch are named and never run (BL-1915)', () => {
  // Faye, 2026-10-20: over every SA-126 Batshit try, 738 patch commands put the next step (most
  // often a test run) on the lines after the heredoc and 2 after `&&`; all were refused and the
  // whole patch was sent again. Now the patch is applied and the result names what was not run.
  // SA-126 item 2 (2026-10-21): `afterPatch` is what a caller that runs commands after a patch
  // (the API lane) runs once the whole patch applied; every other caller names them as above.
  it.each([
    ['one command on the line after the heredoc', `${heredoc()}\nnode --test test/a.test.js 2>&1 | tail -5`, null, ['node --test test/a.test.js 2>&1 | tail -5'], 'node --test test/a.test.js 2>&1 | tail -5'],
    ['two commands on two lines after a cd-form heredoc (one with `;`)', `cd src && ${heredoc()}\nnpm test 2>&1 | grep -E 'pass|fail'\nsed -n 1,20p a.js; tail -3 b.js`, 'src', ["npm test 2>&1 | grep -E 'pass|fail'", 'sed -n 1,20p a.js; tail -3 b.js'], "npm test 2>&1 | grep -E 'pass|fail'\nsed -n 1,20p a.js; tail -3 b.js"],
    // Item 2b (Faye, 2026-10-21): `;` right after the patch joins like a new line; `||` is named only.
    ['a semicolon after the heredoc marker', `apply_patch <<'PATCH'; npm test\n${PATCH}\nPATCH`, null, ['npm test'], 'npm test'],
    ['|| after the heredoc marker', `apply_patch <<'PATCH' || echo failed\n${PATCH}\nPATCH`, null, ['echo failed'], { reason: 'or-after-patch' }],
    ['a semicolon after a quoted patch', `apply_patch '${PATCH}'; npm test`, null, ['npm test'], { reason: 'quoted-patch' }],
    ['&& on the heredoc marker line', `cd src && apply_patch <<'PATCH' && npm test\n${PATCH}\nPATCH`, 'src', ['npm test'], 'npm test'],
    ['&& on the marker line and a line after the heredoc', `apply_patch <<'PATCH' && npm test\n${PATCH}\nPATCH\nnode x.js`, null, ['npm test', 'node x.js'], 'npm test\nnode x.js'],
    ['&& after a quoted patch', `apply_patch '${PATCH}' && npm test`, null, ['npm test'], { reason: 'quoted-patch' }],
    ['a blank and a comment line before the command', `${heredoc()}\n\n# now test\nnpm test`, null, ['npm test'], '# now test\nnpm test'],
    // Review of the fix: the patch's own heredoc body is data, even when a line in it starts with apply_patch.
    ['&& on the marker line, with a patch that mentions apply_patch', `apply_patch <<'P' && npm test\n*** Begin Patch\n*** Update File: a.md\n@@\n apply_patch is a tool\n-old\n+new\n*** End Patch\nP`, null, ['npm test'], 'npm test', '*** Begin Patch\n*** Update File: a.md\n@@\n apply_patch is a tool\n-old\n+new\n*** End Patch'],
    ['a command that writes a file (never run either)', `${heredoc()}\ncat > out.txt <<'EOF'\nhello\nEOF`, null, ["cat > out.txt <<'EOF'"], { reason: 'grammar' }]
  ])('%s', (_label, command, cdPath, notRun, tail: string | { reason: string }, document: string = PATCH) => {
    expect(parseManagedApplyPatchCommand(command)).toEqual({ kind: 'managed', cdPath, document, notRun,
      payloadRange: { start: expect.any(Number), end: expect.any(Number) },
      ...(typeof tail === 'string' ? { afterPatch: { command: tail, tail } } : { notRunReason: tail.reason }) })
    expect(isManagedApplyPatchCommand(command)).toBe(true)
    // The approval check reads the same patch.
    expect(extractManagedApplyPatchDocument(command)).toBe(document)
  })

  it('clips a long command to its first line, 120 characters', () => {
    const long = `echo ${'x'.repeat(200)}`
    const parsed = parseManagedApplyPatchCommand(`${heredoc()}\n${long}`)
    expect(parsed.kind === 'managed' ? parsed.notRun : null).toEqual([`${long.slice(0, 119)}…`])
  })

  it('leaves a patch with nothing after it without a notRun list', () => {
    expect(parseManagedApplyPatchCommand(heredoc())).toEqual({ kind: 'managed', cdPath: null, document: PATCH,
      payloadRange: { start: expect.any(Number), end: expect.any(Number) } })
    expect('notRun' in parseManagedApplyPatchCommand(heredoc())).toBe(false)
  })
})

describe('parseManagedApplyPatchCommand: what runs after the patch (SA-126 item 2)', () => {
  const after = (command: string) => {
    const parsed = parseManagedApplyPatchCommand(command)
    return parsed.kind === 'managed' ? parsed.afterPatch ?? null : 'not managed'
  }

  it('keeps the exact text: quotes, a quoted `&&`, redirects and pipes', () => {
    expect(after(`apply_patch <<'PATCH' && npx vitest run -t 'adds && subtracts' 2>&1 | tail -20\n${PATCH}\nPATCH`)).toEqual({
      command: "npx vitest run -t 'adds && subtracts' 2>&1 | tail -20",
      tail: "npx vitest run -t 'adds && subtracts' 2>&1 | tail -20"
    })
  })

  it('reads CRLF line ends as LF, as the whole parser does', () => {
    expect(after(`${heredoc()}\nnpm test\nnpm run lint`.replace(/\n/g, '\r\n'))).toEqual({ command: 'npm test\nnpm run lint', tail: 'npm test\nnpm run lint' })
  })

  it('carries the leading set lines in front of what runs, by their exact text', () => {
    expect(after(`set -euo pipefail\ncd src && ${heredoc()}\nnpm test`)).toEqual({ command: 'set -euo pipefail\nnpm test', tail: 'npm test' })
    expect(after(`set -e && apply_patch <<'PATCH' && npm test\n${PATCH}\nPATCH`)).toEqual({ command: 'set -e\nnpm test', tail: 'npm test' })
  })

  it('a dangling `&&` gates the line after the heredoc, as in a shell', () => {
    expect(after(`apply_patch <<'PATCH' &&\n${PATCH}\nPATCH\nnpm test`)).toEqual({ command: 'npm test', tail: 'npm test' })
  })

  // Item 2b (Faye, 2026-10-21, from the A3 smoke): the commands after the patch are plain shell
  // text, as a plain command may be. Each newly allowed form runs, by its exact text.
  it.each([
    ['`;`', `${heredoc()}\nnpm test; echo done`, 'npm test; echo done'],
    ['`||`', `${heredoc()}\nnpm test || cat test.log`, 'npm test || cat test.log'],
    ['a redirect', `${heredoc()}\necho '[1]' > /tmp/d2.json && node cli.js /tmp/d2.json; echo "exit $?"`, `echo '[1]' > /tmp/d2.json && node cli.js /tmp/d2.json; echo "exit $?"`],
    ['an append and an fd redirect', `${heredoc()}\nnpm test >> log.txt 2>&1`, 'npm test >> log.txt 2>&1'],
    ['a `$(…)`', `${heredoc()}\nF=$(mktemp -u /tmp/x-XXXX).json; node cli.js $F add a; rm -f $F`, 'F=$(mktemp -u /tmp/x-XXXX).json; node cli.js $F add a; rm -f $F'],
    ['a subshell', `${heredoc()}\n(cd sub && npm test) | tail -3`, '(cd sub && npm test) | tail -3'],
    ['a for loop', `${heredoc()}\nfor v in a b; do echo "--- $v"; node cli.js "$v"; done`, 'for v in a b; do echo "--- $v"; node cli.js "$v"; done'],
    ['an if', `${heredoc()}\nif npm test; then echo ok; else echo bad; fi`, 'if npm test; then echo ok; else echo bad; fi'],
    ['a `\\` continuation on a line after the patch', `${heredoc()}\nnpm test \\\n  --silent`, 'npm test \\\n  --silent'],
    ['a quoted text over several lines', `${heredoc()}\npython3 -c "\nprint(1)\nprint(2)"`, 'python3 -c "\nprint(1)\nprint(2)"'],
    ['`;` right after the patch line', `apply_patch <<'PATCH'; npm test\n${PATCH}\nPATCH`, 'npm test'],
    ['`;` inside the apply_patch line\'s part, and a closing `;`', `apply_patch <<'PATCH' && npm test; node x.js;\n${PATCH}\nPATCH`, 'npm test; node x.js;'],
    ['a subshell on the apply_patch line', `apply_patch <<'PATCH' && (cd sub && npm test)\n${PATCH}\nPATCH`, '(cd sub && npm test)'],
    // Two of the A3 smoke's refused tails, as Opus wrote them.
    ['the A3 smoke: `;` and a pipe', `${heredoc()}\nnpm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"; node src/cli.js "Café à la carte"; git status --short 2>/dev/null`, 'npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"; node src/cli.js "Café à la carte"; git status --short 2>/dev/null'],
    ['the A3 smoke: `;`, a redirect and `$?`', `${heredoc()}\nnpm test 2>&1 | tail -15; echo '["my-title"]' > /tmp/existing.json; node src/cli.js "My Title" --unique /tmp/existing.json; echo "exit=$?"`, `npm test 2>&1 | tail -15; echo '["my-title"]' > /tmp/existing.json; node src/cli.js "My Title" --unique /tmp/existing.json; echo "exit=$?"`]
  ])('runs the commands after the patch when they have %s (item 2b)', (_label, command, tail) => {
    expect(after(command)).toEqual({ command: tail, tail })
  })

  // What stays out (Faye, 2026-10-21): each one is named as not run, and the patch still applies.
  it.each([
    ['a trailing `&`', `${heredoc()}\nnpm start &`],
    ['a `&` between commands', `${heredoc()}\nnpm start & sleep 1; curl localhost:3000`],
    ['a `&` on the apply_patch line', `apply_patch <<'PATCH' && npm start & echo started\n${PATCH}\nPATCH`],
    ['a heredoc of its own', `${heredoc()}\ncat <<'EOF'\nx\nEOF`],
    ['a heredoc of its own on a later line, after `;`', `${heredoc()}\nnpm test; cat >> t.js <<'EOF'\nx\nEOF`],
    ['a `\\` continuation from the apply_patch line into the patch', `apply_patch <<'PATCH' && npm test \\\n${PATCH}\nPATCH`],
    ['a `\\` continuation from the apply_patch line over a blank line', `apply_patch <<'PATCH' && npm test \\\n\n${PATCH}\nPATCH`],
    ['an open `||` at the end', `${heredoc()}\nnpm test ||`],
    ['an open `|` at the end', `${heredoc()}\nnpm test |`],
    ['`||` right after the patch line', `apply_patch <<'PATCH' || echo failed\n${PATCH}\nPATCH`],
    ['a quoted patch', `apply_patch '${PATCH}'\nnpm test`]
  ])('runs nothing after the patch when a command has %s', (_label, command) => {
    // Named as not run with the patch applied, or (a `\\` that joins the patch's first line to
    // the command, as a shell would) the whole command refused: either way nothing after it runs.
    expect([null, 'not managed']).toContain(after(command))
    const parsed = parseManagedApplyPatchCommand(command)
    expect(parsed.kind === 'managed' || parsed.kind === 'refused').toBe(true)
  })

  it('still refuses a second patch after the patch, and a subshell around the patch', () => {
    expect(parseManagedApplyPatchCommand(`${heredoc()}\n(apply_patch <<'P2'\n${PATCH}\nP2\n)`).kind).toBe('refused')
    expect(parseManagedApplyPatchCommand(`${heredoc()}\nnpm test; apply_patch '${PATCH}'`).kind).toBe('refused')
    expect(parseManagedApplyPatchCommand(`(${heredoc()}) && npm test`).kind).toBe('refused')
  })

  it.each([
    ['a quoted patch', `apply_patch '${PATCH}'\nnpm test`, 'quoted-patch'],
    ['an Agent Browser command', `${heredoc()}\nagent-browser open https://example.com`, 'agent-browser'],
    ['a background `&`', `${heredoc()}\nnpm start & echo started`, 'grammar'],
    ['`||` right after the patch line', `apply_patch <<'PATCH' || echo failed\n${PATCH}\nPATCH`, 'or-after-patch'],
    ['an open `&&` at the end', `${heredoc()}\nnpm test &&`, 'grammar']
  ])('says why nothing runs after the patch: %s', (_label, command, reason) => {
    const parsed = parseManagedApplyPatchCommand(command)
    expect(parsed.kind === 'managed' ? [parsed.afterPatch, parsed.notRunReason] : null).toEqual([undefined, reason])
  })

  it('names a command that continues an `&&` after the heredoc (it was dropped from the list)', () => {
    const parsed = parseManagedApplyPatchCommand(`apply_patch <<'PATCH' && npm test &&\n${PATCH}\nPATCH\nnpm run lint`)
    expect(parsed.kind === 'managed' ? [parsed.notRun, parsed.afterPatch, parsed.notRunReason] : null)
      .toEqual([['npm test', 'npm run lint'], undefined, 'grammar'])
  })

  it('refuses a heredoc whose closing line is missing: the command after it is patch text', () => {
    expect(parseManagedApplyPatchCommand(`apply_patch <<PATCH\n${PATCH}\nnpm test`).kind).toBe('refused')
  })

  it('the approval card shows the first line and how many more', () => {
    expect(describeAfterPatchForApproval('npm run build\n\n# then\nnpm test')).toEqual({ firstLine: 'npm run build', moreLines: 1 })
    expect(describeAfterPatchForApproval('npm test')).toEqual({ firstLine: 'npm test', moreLines: 0 })
  })
})

describe('managedApplyPatchPolicySource', () => {
  it.each(['escaped quoted argument', 'CRLF heredoc'])('omits only the actual %s payload with later data end markers', (shape) => {
    const document = '*** Begin Patch\n*** Add File: a.md\n+say "hi"\n*** End Patch'
    const patch = shape === 'escaped quoted argument'
      ? `apply_patch "${document.replace(/"/g, '\\"')}"`
      : `apply_patch <<'PATCH'\n${document}\nPATCH`.replace(/\n/g, '\r\n')
    const suffix = "\nprintf forbidden\ncat <<'DATA'\n*** End Patch\nDATA"
    const command = patch + suffix
    expect(parseManagedApplyPatchCommand(command).kind).toBe('managed')
    const projected = managedApplyPatchPolicySource(command, '')
    expect(projected).not.toContain('+say')
    expect(projected).toContain(suffix)
    expect(projected).toContain('apply_patch')
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

describe('parseManagedApplyPatchDocument: Add File sections (BL-1915)', () => {
  const doc = (section: string) => `*** Begin Patch\n*** Add File: a.py\n${section}\n*** End Patch`
  const lenient = (section: string) => parseManagedApplyPatchDocument(doc(section), { lenientAddFile: true })
  const contentOf = (parsed: ReturnType<typeof parseManagedApplyPatchDocument>) =>
    parsed.success && parsed.operations[0].type === 'add' ? parsed.operations[0].contentLines : parsed

  it('reads a section with no + line as the file as written (SA-126: 11 of 980 sections)', () => {
    expect(contentOf(lenient('import os\n\ndef main():\n    return 1'))).toEqual(['import os', '', 'def main():', '    return 1'])
  })

  it('reads a blank line inside a + section as an empty content line (SA-126: 11 sections)', () => {
    expect(contentOf(lenient('+import os\n\n+def main():\n   \n+    return 1'))).toEqual(['import os', '', 'def main():', '', '    return 1'])
  })

  it('drops blank lines at the end of a section: they separate it from the next one', () => {
    expect(contentOf(lenient('+a\n+b\n\n'))).toEqual(['a', 'b'])
    const twoFiles = parseManagedApplyPatchDocument(
      '*** Begin Patch\n*** Add File: a.txt\nhello\n\n*** Add File: b.txt\n+bye\n*** End Patch',
      { lenientAddFile: true }
    )
    expect(twoFiles.success && twoFiles.operations).toEqual([
      { type: 'add', filePath: 'a.txt', contentLines: ['hello'] },
      { type: 'add', filePath: 'b.txt', contentLines: ['bye'] }
    ])
  })

  it.each([
    ['+ lines mixed with plain lines', '+import os\ndef main():\n+    return 1', 'def main():'],
    ['a plain file with one line that starts with +', 'x = 1\n+ y', 'x = 1'],
    ['every line starting with a space (diff context, not a file)', ' import os\n \n def main():', ' import os']
  ])('refuses %s, saying how to write it and that nothing was written', (_label, section, badLine) => {
    expect(lenient(section)).toEqual({
      success: false,
      operations: [],
      touchedPaths: [],
      message: `Invalid line in "*** Add File" section: "${badLine.trim()}": every line in an Add File section must start with \`+\` (an empty line is \`+\`). Nothing was written.`
    })
  })

  it('keeps the strict grammar by default (the artifact patch): the first line without + is refused', () => {
    expect(parseManagedApplyPatchDocument(doc('import os'))).toEqual({
      success: false,
      operations: [],
      touchedPaths: [],
      message: 'Invalid line in "*** Add File" section: "import os".'
    })
    expect(parseManagedApplyPatchDocument(doc('+a\n\n+b'))).toMatchObject({
      success: false,
      message: 'Invalid line in "*** Add File" section: "".'
    })
    expect(contentOf(parseManagedApplyPatchDocument(doc('+a\n+\n+b')))).toEqual(['a', '', 'b'])
  })
})
