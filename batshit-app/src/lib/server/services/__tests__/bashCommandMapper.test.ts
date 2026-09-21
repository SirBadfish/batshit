import { describe, expect, it } from 'vitest'
import {
  extractInPlaceEditTargetPaths,
  mapBashCommandToMode4Tool,
  mapBashCommandToRendererTool,
  resolveNativeBashMapping
} from '../bashCommandMapper'

describe('bashCommandMapper', () => {
  it('maps read-style commands to read renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool('cat src/main.ts')
    expect(mapped.toolName).toBe('batshit_server_read_file')
    expect(mapped.reason).toBe('read-command')
    expect(mapped.args.filePath).toBe('src/main.ts')
    expect(mapped.args.path).toBe('src/main.ts')
  })

  it('maps dot-directory markdown reads to read renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool(
      `/bin/zsh -lc "sed -n '1,220p' .config/project-notes.md"`
    )

    expect(mapped.toolName).toBe('batshit_server_read_file')
    expect(mapped.reason).toBe('read-command')
    expect(mapped.args.filePath).toBe('.config/project-notes.md')
    expect(mapped.args.path).toBe('.config/project-notes.md')
  })

  it('maps search-style commands to search renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool('rg "native_dynamic_mcp" src')
    expect(mapped.toolName).toBe('batshit_server_search_files')
    expect(mapped.reason).toBe('search-command')
  })

  it('maps list/find/tree commands to list renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool('find src -maxdepth 2 -type f')
    expect(mapped.toolName).toBe('batshit_server_list_files')
    expect(mapped.reason).toBe('list-command')
  })

  it('treats rg --files as a list-files lane instead of search_files', () => {
    const mapped = mapBashCommandToRendererTool('rg --files batshit-app/src/lib/components/chat')

    expect(mapped.toolName).toBe('batshit_server_list_files')
    expect(mapped.reason).toBe('list-command')
    expect(mapped.args.path).toBe('batshit-app/src/lib/components/chat')
    expect(mapped.args.dirPath).toBe('batshit-app/src/lib/components/chat')
  })

  it('keeps ls pipelines mapped to list renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool("ls -la docs/user-docs/architecture | sed -n '1,200p'")
    expect(mapped.toolName).toBe('batshit_server_list_files')
    expect(mapped.reason).toBe('list-command')
    expect(mapped.args.path).toBe('docs/user-docs/architecture')
    expect(mapped.args.dirPath).toBe('docs/user-docs/architecture')
  })

  it('unwraps docker sandbox bash wrappers before classifying list commands', () => {
    const mapped = mapBashCommandToRendererTool(
      'docker sandbox exec --workdir /Users/example/hello batshit-josh-49fef393f0 /bin/bash -lc ls -la /Users/example/hello'
    )

    expect(mapped.toolName).toBe('batshit_server_list_files')
    expect(mapped.reason).toBe('list-command')
    expect(mapped.args.path).toBe('/Users/example/hello')
    expect(mapped.args.dirPath).toBe('/Users/example/hello')
    expect(mapped.args.innerCommand).toBe('ls -la /Users/example/hello')
  })

  it('maps redirect writes to overwrite renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool('echo "hi" > notes.md')
    expect(mapped.toolName).toBe('batshit_server_overwrite_file')
    expect(mapped.reason).toBe('redirect-write')
    expect(mapped.args.filePath).toBe('notes.md')
    expect(mapped.args.path).toBe('notes.md')
    expect(mapped.args.content).toBe('hi')
  })

  it('does not treat fd merge redirects as file writes', () => {
    const mapped = mapBashCommandToRendererTool(
      'curl -s --connect-timeout 5 http://host.docker.internal:8000/object_info 2>&1 | head -c 500'
    )
    expect(mapped.toolName).toBe('native_bash_execute')
    expect(mapped.reason).toBe('fallback-command')
    expect(mapped.args.filePath).toBeUndefined()
  })

  it('maps cat heredoc writes to overwrite renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool(
      "cat > /tmp/demo.txt <<'EOF'\nhello\nworld\nEOF"
    )

    expect(mapped.toolName).toBe('batshit_server_overwrite_file')
    expect(mapped.reason).toBe('redirect-write')
    expect(mapped.args.filePath).toBe('/tmp/demo.txt')
    expect(mapped.args.path).toBe('/tmp/demo.txt')
    expect(mapped.args.content).toBe('hello\nworld')
  })

  it('maps heredoc writes with semicolons in body to overwrite renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool(
      "cat > /tmp/demo.md <<'EOF'\nconst x = 1;\nconst y = 2;\nEOF"
    )

    expect(mapped.toolName).toBe('batshit_server_overwrite_file')
    expect(mapped.reason).toBe('redirect-write')
    expect(mapped.args.filePath).toBe('/tmp/demo.md')
    expect(mapped.args.path).toBe('/tmp/demo.md')
    expect(mapped.args.content).toContain('const x = 1;')
  })

  it('maps setup-wrapped heredoc writes to overwrite renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool(
      "set -euo pipefail\nmkdir -p /tmp/demo\ncat > /tmp/demo/notes.txt <<'EOF'\nalpha\nbeta\nEOF\nwc -l /tmp/demo/notes.txt"
    )

    expect(mapped.toolName).toBe('batshit_server_overwrite_file')
    expect(mapped.reason).toBe('redirect-write')
    expect(mapped.args.filePath).toBe('/tmp/demo/notes.txt')
    expect(mapped.args.path).toBe('/tmp/demo/notes.txt')
    expect(mapped.args.content).toBe('alpha\nbeta')
  })

  it('maps in-place edits to edit renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool("sed -i '' 's/foo/bar/' src/main.ts")
    expect(mapped.toolName).toBe('batshit_server_edit_file')
    expect(mapped.reason).toBe('in-place-edit')
    expect(mapped.args.filePath).toBe('src/main.ts')
    expect(mapped.args.path).toBe('src/main.ts')
  })

  it('maps in-place edits even when a verification heredoc follows later in the script', () => {
    const mapped = mapBashCommandToRendererTool(
      "perl -pi -e 's/^beta$/bravo/' /tmp/demo.txt\npython3 - <<'PY'\nfrom pathlib import Path\nprint(Path('/tmp/demo.txt').read_text())\nPY"
    )
    expect(mapped.toolName).toBe('batshit_server_edit_file')
    expect(mapped.reason).toBe('in-place-edit')
    expect(mapped.args.filePath).toBe('/tmp/demo.txt')
    expect(mapped.args.path).toBe('/tmp/demo.txt')
  })

  it('maps python heredoc file mutations into the edit renderer lane', () => {
    const mapped = mapBashCommandToRendererTool(
      "python - <<'PY'\nfrom pathlib import Path\np=Path('/tmp/demo.txt')\ntext=p.read_text()\np.write_text(text.replace('beta', 'bravo'))\nprint('done')\nPY"
    )
    expect(mapped.toolName).toBe('batshit_server_edit_file')
    expect(mapped.reason).toBe('python-file-edit')
    expect(mapped.args.filePath).toBe('/tmp/demo.txt')
    expect(mapped.args.path).toBe('/tmp/demo.txt')
  })

  it('maps cd-wrapped python heredoc file mutations with relative paths into the edit renderer lane', () => {
    const mapped = mapBashCommandToRendererTool(
      "cd /tmp/demo && python3 - <<'PY'\nfrom pathlib import Path\np=Path('notes.txt')\ntext=p.read_text()\np.write_text(text.replace('beta', 'bravo'))\nprint('done')\nPY"
    )
    expect(mapped.toolName).toBe('batshit_server_edit_file')
    expect(mapped.reason).toBe('python-file-edit')
    expect(mapped.args.filePath).toBe('/tmp/demo/notes.txt')
    expect(mapped.args.path).toBe('/tmp/demo/notes.txt')
  })

  it('maps apply_patch flows to edit renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool(
      "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: docs/user-docs/architecture/local-first-boundaries.md\n*** End Patch\nPATCH"
    )
    expect(mapped.toolName).toBe('batshit_server_edit_file')
    expect(mapped.reason).toBe('apply-patch')
    expect(mapped.args.filePath).toBe('docs/user-docs/architecture/local-first-boundaries.md')
    expect(mapped.args.path).toBe('docs/user-docs/architecture/local-first-boundaries.md')
  })

  it('maps setup-wrapped apply_patch flows to edit renderer payloads', () => {
    const mapped = mapBashCommandToRendererTool(
      "set -euo pipefail\ncd /tmp/demo\napply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: NOTES.md\n@@\n-alpha\n+beta\n*** End Patch\nPATCH"
    )
    expect(mapped.toolName).toBe('batshit_server_edit_file')
    expect(mapped.reason).toBe('apply-patch')
    expect(mapped.args.filePath).toBe('NOTES.md')
    expect(mapped.args.path).toBe('NOTES.md')
  })

  it('keeps unknown command families on execute renderer fallback', () => {
    const mapped = mapBashCommandToRendererTool('npm run lint')
    expect(mapped.toolName).toBe('native_bash_execute')
    expect(mapped.reason).toBe('fallback-command')
  })

  // F-P6-5 follow-up: the count of `head -n 2 file` was taken as the path.
  it.each([
    ['head -n 2 notes.md', 'notes.md'],
    ['tail -n +3 notes.md', 'notes.md'],
    ['head -c 100 notes.md', 'notes.md'],
    ['head --lines 5 notes.md', 'notes.md'],
    ['head -5 notes.md', 'notes.md'],
    ['head --lines=5 notes.md', 'notes.md'],
    ['tail -f notes.md', 'notes.md'],
    ['cat -n notes.md', 'notes.md'],
    ['cat -n 2', '2']
  ])('reads the file, not the count, from `%s`', (command, filePath) => {
    const mapped = mapBashCommandToRendererTool(command)
    expect(mapped.toolName).toBe('batshit_server_read_file')
    expect(mapped.args.filePath).toBe(filePath)
  })

  // Public PR 114 (CodeQL js/redos): the options are skipped one at a time, never back, so a read
  // with no file after its count reads stdin and shows as a plain command, not a read of the count.
  it.each(['head -n 5 | grep x', 'tail -n +3 < notes.md'])(
    'reads no count as the file in `%s`',
    (command) => {
      const mapped = mapBashCommandToRendererTool(command)
      expect(mapped.toolName).toBe('native_bash_execute')
      expect(mapped.args.filePath).toBeUndefined()
    }
  )

  // F-P6-5 follow-up: these spellings mapped as READS, and Plan mode's safe list allows `sed`, so a
  // Plan mode agent could edit any file with them.
  it.each([
    'sed -i s/a/b/ app.js',
    'sed -i.bak s/a/b/ app.js',
    "sed -i'' s/a/b/ app.js",
    "sed -i '' s/a/b/ app.js",
    'sed -Ei s/a/b/ app.js',
    'sed -ie s/a/b/ app.js',
    'sed --in-place s/a/b/ app.js',
    'sed --in-place=.orig -e s/a/b/ app.js',
    '/usr/bin/sed -i.bak s/a/b/ app.js'
  ])('maps `%s` as an in-place edit of app.js', (command) => {
    const mapped = mapBashCommandToRendererTool(command)
    expect(mapped.toolName).toBe('batshit_server_edit_file')
    expect(mapped.reason).toBe('in-place-edit')
    expect(mapped.args.filePath).toBe('app.js')
  })

  it.each([
    "sed -n '1,5p' app.js",
    "sed -e 's/-i/x/' app.js",
    'sed -E -n 1p app.js'
  ])('keeps `%s` a read', (command) => {
    const mapped = mapBashCommandToRendererTool(command)
    expect(mapped.toolName).toBe('batshit_server_read_file')
  })
})

/**
 * Bug Q (2026-09-18): the in-place check tested the raw text, so a sed whose quoted script only
 * CONTAINS ` -i ` (a read that prints the file) was mapped as an edit, and so was any line that
 * held the letters `sed` or `perl` next to a `-i` flag of some other command. It now decides from
 * the command's words, the way the shell splits them: a flag is a whole word, quoted or not, and
 * text inside a quoted script is part of that script. The safe side must hold: every real
 * in-place spelling stays an edit, because Plan mode lets a read run.
 */
describe('in-place edits are decided from the command words (Bug Q)', () => {
  it.each([
    ["sed -I '' 's/foo/bar/' app.js notes.md", ['app.js', 'notes.md']],
    ["perl -pi -e 's/foo/bar/' app.js notes.md", ['app.js', 'notes.md']],
    [
      "printf '%s\\n' ignored | xargs /usr/bin/sed -i '' 's/foo/bar/' app.js notes.md",
      ['app.js', 'notes.md']
    ],
    ["find src -name '*.js' -exec sed -i '' 's/foo/bar/' {} +", ['src']],
    [`bash -c "sed -i '' 's/foo/bar/' app.js notes.md"`, ['app.js', 'notes.md']],
    ["sed -n '1,5p' app.js", []]
  ])('extracts every literal in-place target from `%s`', (command, expected) => {
    expect(extractInPlaceEditTargetPaths(command)).toEqual(expected)
  })

  it.each([
    "sed -i 's/foo/bar/' app.js",
    "sed -i.bak 's/foo/bar/' app.js",
    "sed -i '' 's/foo/bar/' app.js",
    "sed -i'' 's/foo/bar/' app.js",
    "sed -Ei 's/fo+/bar/' app.js",
    "sed -Ei.bak 's/fo+/bar/' app.js",
    "sed -ni 's/foo/bar/p' app.js",
    "sed --in-place 's/foo/bar/' app.js",
    "sed --in-place=.bak 's/foo/bar/' app.js",
    // GNU sed takes any unambiguous prefix of a long option.
    "sed --in 's/foo/bar/' app.js",
    // BSD sed (macOS): `-I` edits in place too, and `-a` and `-l` take no value, so they cluster.
    "sed -I '' 's/foo/bar/' app.js",
    "sed -I.bak 's/foo/bar/' app.js",
    "sed -EI '' 's/foo/bar/' app.js",
    "sed -ai '' 's/foo/bar/' app.js",
    "sed -li '' 's/foo/bar/' app.js",
    // The flag written inside quotes is still the flag once the shell removes the quotes.
    `sed "-i" 's/foo/bar/' app.js`,
    "sed '-i.bak' 's/foo/bar/' app.js",
    "sed -'i' '' 's/foo/bar/' app.js",
    `sed "--in-place" 's/foo/bar/' app.js`,
    // GNU sed reads options after the script too.
    "sed -e 's/foo/bar/' -i app.js",
    "sed 's/foo/bar/' -i app.js",
    // sed called by a full path, by another name, or past an alias.
    "/usr/bin/sed -i 's/foo/bar/' app.js",
    "/opt/homebrew/bin/gsed -i 's/foo/bar/' app.js",
    "\\sed -i 's/foo/bar/' app.js",
    "SED -i 's/foo/bar/' app.js",
    // perl's in-place forms, clustered or not, with or without a backup suffix.
    "perl -i -pe 's/foo/bar/' app.js",
    "perl -pi -e 's/foo/bar/' app.js",
    "perl -p -i -e 's/foo/bar/' app.js",
    "perl -pi.bak -e 's/foo/bar/' app.js",
    "perl -i.orig -pe 's/foo/bar/' app.js",
    "perl -0pi -e 's/foo/bar/' app.js",
    "perl -lpi -e 's/foo/bar/' app.js",
    "perl -Ilib -pi -e 's/foo/bar/' app.js",
    "perl -e 's/foo/bar/' -pi app.js",
    // `-0x0d` sets the record separator; its hex digits are a value, not the `-d` switch.
    "perl -0x0dpi -e 's/foo/bar/' app.js",
    "/usr/bin/perl -pi -e 's/foo/bar/' app.js",
    // An in-place sed that is not the first command on the line.
    "cd src && sed -i 's/foo/bar/' app.js",
    "git status; sed -i 's/foo/bar/' app.js",
    "true || sed -i 's/foo/bar/' app.js",
    "cd src\nsed -i 's/foo/bar/' app.js",
    "sudo sed -i 's/foo/bar/' app.js",
    "env LC_ALL=C sed -i 's/foo/bar/' app.js",
    "nice -n 5 perl -pi -e 's/foo/bar/' app.js",
    // A redirect may sit anywhere, and its `&` does not end the command.
    "sed &>/dev/null -i 's/foo/bar/' app.js",
    // A quoted script with escaped quotes, then the flag.
    `sed "s/\\"x\\"/y/" -i app.js`,
    // A command line the shell itself runs.
    `bash -c "sed -i 's/foo/bar/' app.js"`,
    `/bin/zsh -lc "sed -i 's/foo/bar/' app.js"`,
    // A command word the shell fills in: the words after it can still be an in-place flag.
    "SED=sed; $SED -i 's/foo/bar/' app.js",
    `"$(command -v gsed)" -i 's/foo/bar/' app.js`
  ])('maps `%s` as an in-place edit of app.js', (command) => {
    const mapped = mapBashCommandToRendererTool(command)
    expect(mapped.toolName).toBe('batshit_server_edit_file')
    expect(mapped.reason).toBe('in-place-edit')
    expect(mapped.args.filePath).toBe('app.js')
  })

  // Still edits where the line gives no clean path: an edit never becomes a read or a plain command.
  it.each([
    "find . -name '*.js' -exec sed -i 's/foo/bar/' {} +",
    "grep -l foo -r src | xargs sed -i 's/foo/bar/'",
    "(cd src && sed -i 's/foo/bar/' app.js)",
    "(sed -i 's/foo/bar/' app.js)",
    "sed -i 's/foo/bar/' app.js | cat -n",
    "sed -i 's/foo/bar/' app.js 2>/dev/null",
    `find . -name '*.js' -exec sh -c 'sed -i "s/foo/bar/" "$0"' {} \\;`,
    `eval "sed -i 's/foo/bar/' app.js"`,
    `timeout 5 bash -o pipefail -c "sed -i 's/foo/bar/' app.js"`,
    `bash -lc "sh -c 'sed -i s/foo/bar/ app.js'"`,
    // A shell reads options after `-c` too; its command line is the first word that is not one.
    `bash -lc "sh -c -e 'sed -i s/foo/bar/ app.js'"`,
    `flock /tmp/app.lock --command "sed -i 's/foo/bar/' app.js"`,
    `script -qc "sed -i 's/foo/bar/' app.js" /dev/null`
  ])('maps `%s` as an in-place edit', (command) => {
    const mapped = mapBashCommandToRendererTool(command)
    expect(mapped.toolName).toBe('batshit_server_edit_file')
    expect(mapped.reason).toBe('in-place-edit')
  })

  it.each([
    // The bug: a quoted script that merely contains the text ` -i `.
    "sed 's/ -i / x /' app.js",
    "sed -n 's/ -i / x /p' app.js",
    "sed -e 's/ -i / x /' app.js",
    `sed "s/ -i / x /" app.js`,
    "sed 's/ --in-place / x /' app.js",
    "sed -n '/ -i /p' app.js",
    "sed 's/sed -i/sed/' app.js",
    `sed "s/\\" -i \\"/x/" app.js`,
    // Codex wraps every command in a login shell.
    `/bin/zsh -lc "sed 's/ -i / x /' app.js"`,
    // Long options that are not `--in-place`.
    "sed --quiet 's/foo/bar/p' app.js",
    "sed --expression='s/foo/bar/' app.js",
    // A comment is not part of the command.
    "cat app.js # later: sed -i s/foo/bar/ app.js"
  ])('keeps `%s` a read of app.js', (command) => {
    const mapped = mapBashCommandToRendererTool(command)
    expect(mapped.toolName).toBe('batshit_server_read_file')
    expect(mapped.reason).toBe('read-command')
    expect(mapped.args.filePath).toBe('app.js')
  })

  it.each([
    // Another command's `-i` next to the letters "sed" or "perl" is not sed's or perl's flag.
    ['grep -i used notes.txt', 'batshit_server_search_files'],
    ['grep -rin perl src', 'batshit_server_search_files'],
    [`grep -rn "sed -i" docs`, 'batshit_server_search_files'],
    ["sed -n '1,5p' app.js | grep -i foo", 'batshit_server_read_file'],
    // After `--`, a word that starts with `-i` is a file name.
    ['sed -n p -- -important.txt', 'batshit_server_read_file'],
    // A word the shell fills in is sed's or perl's only when its text says so.
    [`grep "$PATTERN" -i notes.txt`, 'batshit_server_search_files'],
    ["perl -ne 'print if / -i /' app.js", 'native_bash_execute'],
    [`perl -e 'print "-i"' app.js`, 'native_bash_execute'],
    // perl's program text is never read as switches, even when it starts with `-`.
    ["perl -ne '-f $_ or print' app.js", 'native_bash_execute'],
    // A switch that takes a value ends its cluster: `-Mstrict` and `-Ilib` hold an `i`.
    ["perl -Mstrict -ne 'print' app.js", 'native_bash_execute'],
    ["perl -Ilib -ne 'print' app.js", 'native_bash_execute'],
    [`echo 'use sed -i to edit a file in place'`, 'native_bash_execute']
  ])('does not map `%s` as an edit', (command, toolName) => {
    const mapped = mapBashCommandToRendererTool(command)
    expect(mapped.toolName).toBe(toolName)
    expect(mapped.reason).not.toBe('in-place-edit')
  })

  it('maps the quoted-script read the same way on every lane', () => {
    const command = "sed 's/ -i / x /' app.js"

    expect(mapBashCommandToMode4Tool(command)).toMatchObject({
      toolName: 'batshit_server_read_file',
      args: { filePath: 'app.js' }
    })
    expect(
      resolveNativeBashMapping({ toolName: 'native_bash_execute', args: { command } })
    ).toMatchObject({ mappedToolName: 'batshit_server_read_file', reason: 'read-command' })
  })
})

/**
 * Bug sweep item 6 (2026-09-18): the unwrap that reads Codex's `/bin/zsh -lc '…'` took the first
 * quoted `-c` or `-lc` value anywhere on a line as the whole command, so another program's own
 * option replaced the command: `grep -c 'foo' notes.md` mapped as the command `foo`, and
 * `grep -c "sed -i" notes.md` as an in-place edit with no path. A quoted value is the command line
 * only when its flag belongs to a shell.
 */
describe("a shell's -c value is its command line, and only a shell's (item 6)", () => {
  it.each([
    ["grep -c 'foo' notes.md", 'batshit_server_search_files'],
    [`grep -c "foo" notes.md`, 'batshit_server_search_files'],
    [`grep -c "sed -i" notes.md`, 'batshit_server_search_files'],
    ["grep -rc 'TODO' src", 'batshit_server_search_files'],
    ["ls -lc '/tmp/batshit-example'", 'batshit_server_list_files'],
    ["wc -lc 'notes.md'", 'native_bash_execute'],
    ["python3 -c 'print(1)'", 'native_bash_execute'],
    ["git -c 'user.name=x' log -1", 'native_bash_execute']
  ])('keeps `%s` whole', (command, toolName) => {
    const mapped = mapBashCommandToRendererTool(command)
    expect(mapped.args.innerCommand).toBe(command)
    expect(mapped.toolName).toBe(toolName)
    expect(mapped.reason).not.toBe('in-place-edit')
  })

  it('lists the directory an `ls -lc` names', () => {
    expect(mapBashCommandToRendererTool("ls -lc '/tmp/batshit-example'").args.path).toBe('/tmp/batshit-example')
  })

  // Codex runs every command as `/bin/zsh -lc '…'`: that unwrap is unchanged, byte for byte.
  it.each([
    ["/bin/zsh -lc 'cat src/main.ts'", 'cat src/main.ts'],
    [`/bin/zsh -lc "sed -n '1,220p' .config/project-notes.md"`, "sed -n '1,220p' .config/project-notes.md"],
    [`/bin/zsh -lc "grep -c 'foo' notes.md"`, "grep -c 'foo' notes.md"],
    [`/bin/zsh -lc "sh -c 'exit 3'"`, "sh -c 'exit 3'"],
    ["/bin/bash -c 'cat app.js' 2>&1", 'cat app.js'],
    ["bash -c 'cat app.js'", 'cat app.js'],
    [`sh -c "cat app.js"`, 'cat app.js'],
    ["/bin/bash -lc 'cat app.js'", 'cat app.js'],
    ["sudo -u josh sh -c 'cat /etc/hosts'", 'cat /etc/hosts'],
    ["env LC_ALL=C bash -c 'cat app.js'", 'cat app.js'],
    ["timeout 5 bash -o pipefail -c 'cat app.js'", 'cat app.js'],
    ["bash --noprofile --norc -c 'cat app.js'", 'cat app.js'],
    // A long option is one word: `--rcfile`'s letters are not a `-c` cluster, and its value is not
    // the command.
    ["bash --rcfile '/tmp/rc' -c 'cat app.js'", 'cat app.js'],
    ["docker exec box bash -lc 'cat /x.md'", 'cat /x.md'],
    // BSD xargs's `-o` takes no value: the word after it is the shell (and `sh` after the command
    // line is its `$0`, not part of the command).
    ["xargs -o sh -c 'cat app.js' sh", 'cat app.js'],
    ["cd src && bash -c 'cat app.js'", 'cat app.js'],
    ["(bash -c 'cat app.js')", 'cat app.js'],
    // `su` and `script` run their `-c` value as a command line too (`commandEditsInPlace` reads them).
    ["su -c 'cat /etc/hosts'", 'cat /etc/hosts'],
    ["script -qc 'cat app.js' /dev/null", 'cat app.js'],
    [`ssh host "bash -c 'cat /x.md'"`, 'cat /x.md']
  ])('unwraps the command line a shell runs from `%s`', (command, inner) => {
    expect(mapBashCommandToRendererTool(command).args.innerCommand).toBe(inner)
  })

  // A shell's `-c` in a cluster is the same flag, as `commandEditsInPlace` already reads it.
  it.each(["bash -ec 'cat app.js'", "sh -euc 'cat app.js'", "bash -lic 'cat app.js'"])(
    'reads app.js from `%s`',
    (command) => {
      const mapped = mapBashCommandToRendererTool(command)
      expect(mapped.args.innerCommand).toBe('cat app.js')
      expect(mapped).toMatchObject({ toolName: 'batshit_server_read_file', args: { filePath: 'app.js' } })
    }
  )

  it("reads past another program's -c to a shell's later on the line", () => {
    expect(mapBashCommandToRendererTool("grep -c 'foo' notes.md | sh -c 'cat app.js'").args.innerCommand).toBe(
      'cat app.js'
    )
  })

  // A `-lc` value is still read before any other spelling, so a login shell inside another
  // shell's command line unwraps to its own command, as it always did.
  it('reads a nested `-lc` value first', () => {
    expect(mapBashCommandToRendererTool(`bash -c "zsh -lc 'cat app.js'"`)).toMatchObject({
      toolName: 'batshit_server_read_file',
      args: { innerCommand: 'cat app.js', filePath: 'app.js' }
    })
  })

  it('names the same lane for the Mode 4 adapters', () => {
    expect(mapBashCommandToMode4Tool("grep -c 'foo' notes.md").toolName).toBe('batshit_server_search_files')
  })
})

/**
 * Bug sweep item 7 (2026-09-18): a sed read took the LAST word of its whole line as its path, so a
 * sed read piped into another command read that command's last word (`sed -n '1,5p' app.js |
 * grep -i foo` was a read of `foo`), and a later `cat`, `head`, or `tail` in the pipe lent its count
 * or flag (`| head -3` was a read of `-3`). A read's path comes from its own pipeline stage, as it
 * already did for `cat app.js | grep foo` and `head app.js | grep foo`.
 */
describe('a piped read takes its path from its own stage (item 7)', () => {
  it.each([
    // How `cat`, `head`, and `tail` were already read.
    'cat app.js | grep foo',
    'head app.js | grep foo',
    'tail -n 3 app.js | grep foo',
    // sed, the same way.
    "sed -n '1,5p' app.js | grep -i foo",
    'sed -n 1,5p app.js | head -3',
    'sed -n 1,5p app.js | head -n 3',
    'sed -n 1,5p app.js | cat -n',
    'sed -n 1,5p app.js | tail -1',
    `sed -n "s/x/|/p" app.js | grep y`,
    'sed -n 1,5p app.js |& grep y',
    `/bin/zsh -lc "sed -n '1,5p' app.js | grep -i foo"`
  ])('maps `%s` as a read of app.js', (command) => {
    expect(mapBashCommandToRendererTool(command)).toMatchObject({
      toolName: 'batshit_server_read_file',
      reason: 'read-command',
      args: { filePath: 'app.js', path: 'app.js' }
    })
  })

  it.each([
    "sed -n '/a|b/p' app.js",
    // An escaped quote does not end a double-quoted script, and an escaped `|` is sed's own.
    `sed -n "s/\\"|/x/p" app.js | grep y`,
    'sed -n /foo\\|bar/p app.js | head -3'
  ])("never splits `%s` at a `|` that is sed's own", (command) => {
    expect(mapBashCommandToRendererTool(command).args.filePath).toBe('app.js')
  })
})

describe('resolveNativeBashMapping', () => {
  it('returns mapped renderer metadata for native_bash_execute calls', () => {
    const resolved = resolveNativeBashMapping({
      toolName: 'native_bash_execute',
      args: {
        command: 'cd docs && ls architecture'
      }
    })

    expect(resolved).not.toBeNull()
    expect(resolved?.mappedToolName).toBe('batshit_server_list_files')
    expect(resolved?.reason).toBe('list-command')
    expect(resolved?.mappedArgs.path).toBe('architecture')
    expect(resolved?.mappedArgs.originalToolName).toBe('native_bash_execute')
  })

  it('maps sandbox-wrapped native bash list commands back into list_files', () => {
    const resolved = resolveNativeBashMapping({
      toolName: 'native_bash_execute',
      args: {
        command:
          'docker sandbox exec --workdir /Users/example/hello batshit-josh-49fef393f0 /bin/bash -lc ls -la /Users/example/hello'
      }
    })

    expect(resolved).not.toBeNull()
    expect(resolved?.mappedToolName).toBe('batshit_server_list_files')
    expect(resolved?.reason).toBe('list-command')
    expect(resolved?.mappedArgs.path).toBe('/Users/example/hello')
    expect(resolved?.mappedArgs.originalToolName).toBe('native_bash_execute')
  })

  it('returns mapped renderer metadata for managed CLI bash helper calls', () => {
    const resolved = resolveNativeBashMapping({
      toolName: 'mcp.batshit_cli_internal_tools.batshit_server_bash_execute',
      args: {
        command: 'cat docs/example.md'
      }
    })

    expect(resolved).not.toBeNull()
    expect(resolved?.mappedToolName).toBe('batshit_server_read_file')
    expect(resolved?.reason).toBe('read-command')
    expect(resolved?.mappedArgs.path).toBe('docs/example.md')
    expect(resolved?.mappedArgs.originalToolName).toBe(
      'mcp.batshit_cli_internal_tools.batshit_server_bash_execute'
    )
  })

  it('returns mapped renderer metadata for Claude managed CLI bash helper calls', () => {
    const resolved = resolveNativeBashMapping({
      toolName: 'mcp__batshit_cli_internal_tools__batshit_server_bash_execute',
      args: {
        command: 'rg "zip-control" batshit-app/src'
      }
    })

    expect(resolved).not.toBeNull()
    expect(resolved?.mappedToolName).toBe('batshit_server_search_files')
    expect(resolved?.reason).toBe('search-command')
    expect(resolved?.mappedArgs.originalToolName).toBe(
      'mcp__batshit_cli_internal_tools__batshit_server_bash_execute'
    )
  })

  it('returns null for non-native tools', () => {
    const resolved = resolveNativeBashMapping({
      toolName: 'batshit_server_execute_command',
      args: {
        command: 'pwd'
      }
    })
    expect(resolved).toBeNull()
  })
})

describe('mapBashCommandToMode4Tool', () => {
  it('preserves shared rg search classification for Mode 4 adapters', () => {
    const mapped = mapBashCommandToMode4Tool('rg "tool-result" batshit-app/src')

    expect(mapped.toolName).toBe('batshit_server_search_files')
    expect(mapped.reason).toBe('search-command')
  })

  it('preserves shared rg --files classification for Mode 4 adapters', () => {
    const mapped = mapBashCommandToMode4Tool('rg --files batshit-app/src/lib/components/chat')

    expect(mapped.toolName).toBe('batshit_server_list_files')
    expect(mapped.reason).toBe('list-command')
    expect(mapped.args.path).toBe('batshit-app/src/lib/components/chat')
  })

  it('maps unknown shell commands back to Mode 4 execute_command telemetry', () => {
    const mapped = mapBashCommandToMode4Tool('npm run check')

    expect(mapped.toolName).toBe('batshit_server_execute_command')
    expect(mapped.reason).toBe('fallback-command')
  })
})
