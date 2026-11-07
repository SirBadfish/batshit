import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { NATIVE_BASH_APPLY_PATCH_GUIDANCE_SEPARATE_CALL, NATIVE_BASH_AFTER_PATCH_GUIDANCE, NATIVE_BASH_APPLY_PATCH_GUIDANCE, nativeToolService } from '../nativeTools'
import { __setAnchoredWriterTestHook } from '../anchoredProjectWriter'

// BL-1916: a test can make one write fail (a full disk, a permission) to prove a patch is put back.
// BL-2006: the patch reads and writes through the anchored writer, so the failures stand in at its
// test hook (a path is given as `/<path relative to the workspace>`); every other step goes to the
// real helper and the real file system.
const writeFailure = vi.hoisted(() => ({
  when: null as null | ((file: string, data: unknown) => boolean),
  readRefused: null as null | ((file: string) => boolean),
  // BL-1987: a test can act while a file is read (press Stop during the patch's planning) and see
  // every write the executor attempts.
  onRead: null as null | ((file: string) => void),
  // BL-2022: a test can act before any step of the writer (the rollback's included).
  onOp: null as null | ((op: string, file: string) => void | Promise<void>),
  writes: [] as string[]
}))
__setAnchoredWriterTestHook(async (op, paths, data) => {
  const file = `/${paths[0]}`
  await writeFailure.onOp?.(op, file)
  if (op === 'read') {
    writeFailure.onRead?.(file)
    // A test can refuse reading one file, to prove a step never loads it.
    if (writeFailure.readRefused?.(file)) throw Object.assign(new Error('EFBIG: file too large to read'), { code: 'EFBIG' })
  }
  if (op === 'write') {
    writeFailure.writes.push(file)
    if (writeFailure.when?.(file, data)) throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' })
  }
})

/**
 * BL-244 / BL-252 (2026-09-25), on the real executor and the local shell.
 *
 * BL-244: `cd <folder> && apply_patch <<'PATCH'` went to the real shell, where there is no
 * `apply_patch`, so the patch failed (under 4,000 characters) or was blocked as too long; agents
 * also probed for the program with `which`. The command is now managed, and the `cd` is followed.
 *
 * BL-252: the managed path applied the patch of any command with an `apply_patch` line and
 * dropped every other line, reporting success. Such a command is now refused before anything runs.
 */

const cleanup: string[] = []

afterEach(async () => {
  writeFailure.when = null
  writeFailure.readRefused = null
  writeFailure.onRead = null
  writeFailure.onOp = null
  writeFailure.writes = []
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true })
})

async function tempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

const addNote = (file: string, text = 'hello') =>
  `apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: ${file}\n+${text}\n*** End Patch\nPATCH`

function run(
  command: string,
  workspaceRoot: string,
  accessMode: 'dangerous' | 'plan' = 'dangerous',
  extra: Record<string, unknown> = {}
) {
  return nativeToolService.nativeBashExecute({
    command,
    backend: 'local',
    accessMode,
    requireApproval: false,
    workspaceRoot,
    ...extra
  } as any)
}

describe('managed apply_patch after cd <folder> (BL-244)', () => {
  it('applies the patch inside the folder named by `cd <folder> &&`', async () => {
    const root = await tempDir('batshit-patch-cd-')
    await mkdir(path.join(root, 'app', 'docs'), { recursive: true })

    const result = await run(`cd app && ${addNote('docs/notes.md')}`, root)

    expect(result).toMatchObject({ success: true, blocked: false })
    expect(result.managedApplyPatch).toMatchObject({ managed: true, operationsApplied: 1 })
    expect(await readFile(path.join(root, 'app', 'docs', 'notes.md'), 'utf8')).toBe('hello\n')
    expect(existsSync(path.join(root, 'docs', 'notes.md'))).toBe(false)
  })

  it('follows a cd on its own line, and an absolute cd target inside the workspace', async () => {
    const root = await tempDir('batshit-patch-cd-line-')
    await mkdir(path.join(root, 'app'), { recursive: true })

    const lineForm = await run(`set -euo pipefail\ncd app\n${addNote('a.md')}`, root)
    expect(lineForm).toMatchObject({ success: true })
    expect(await readFile(path.join(root, 'app', 'a.md'), 'utf8')).toBe('hello\n')

    const absolute = await run(`cd ${path.join(root, 'app')} && ${addNote('b.md')}`, root)
    expect(absolute).toMatchObject({ success: true })
    expect(await readFile(path.join(root, 'app', 'b.md'), 'utf8')).toBe('hello\n')
  })

  it('accepts a cd-form patch over the 4,000-character limit for plain commands', async () => {
    const root = await tempDir('batshit-patch-cd-long-')
    await mkdir(path.join(root, 'app'), { recursive: true })
    const long = 'x'.repeat(6_000)

    const result = await run(`cd app && ${addNote('long.md', long)}`, root)

    expect(result).toMatchObject({ success: true, blocked: false })
    expect(await readFile(path.join(root, 'app', 'long.md'), 'utf8')).toBe(`${long}\n`)
  })

  it('blocks a cd to a folder outside the workspace, directly, through .., or through a symlink', async () => {
    const root = await tempDir('batshit-patch-cd-root-')
    const outside = await tempDir('batshit-patch-cd-outside-')
    await symlink(outside, path.join(root, 'escape'))

    for (const target of [outside, '..', 'escape']) {
      const result = await run(`cd ${target} && ${addNote('pwned.md')}`, root)
      expect(result, target).toMatchObject({ success: false, blocked: true, errorCode: 'POLICY_BLOCKED' })
      expect(result.reason, target).toMatch(/outside the workspace, so the patch was not applied/)
    }
    expect(existsSync(path.join(outside, 'pwned.md'))).toBe(false)
    expect(existsSync(path.join(path.dirname(root), 'pwned.md'))).toBe(false)
  })

  it('refuses a cd to a folder that does not exist, and writes nothing', async () => {
    const root = await tempDir('batshit-patch-cd-missing-')

    const result = await run(`cd nope && ${addNote('a.md')}`, root)

    expect(result).toMatchObject({ success: false, blocked: false, errorCode: 'INVALID_INPUT' })
    expect(result.reason).toMatch(/does not exist/)
    expect(existsSync(path.join(root, 'nope'))).toBe(false)
    expect(existsSync(path.join(root, 'a.md'))).toBe(false)
  })

  it('still blocks the cd form in Plan mode, where command chaining is blocked', async () => {
    const root = await tempDir('batshit-patch-cd-plan-')
    await mkdir(path.join(root, 'app'), { recursive: true })

    const result = await run(`cd app && ${addNote('plan.md')}`, root, 'plan')

    expect(result).toMatchObject({ success: false, blocked: true })
    expect(existsSync(path.join(root, 'app', 'plan.md'))).toBe(false)
  })
})

describe('a command that uses apply_patch in any other shape runs nothing (BL-252)', () => {
  it('a patch with no End Patch line names that fault, not the whole-command rule (BL-1990, the A3 shape)', async () => {
    const root = await tempDir('batshit-patch-no-end-')
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src', 'a.js'), 'old\n')

    const result = await run("cd src && apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: a.js\n@@\n-old\n+new\nPATCH\nnpm test", root, 'dangerous', { runCommandAfterPatch: true })

    expect(result).toMatchObject({ success: false, blocked: false, errorCode: 'INVALID_INPUT' })
    expect(result.reason).toBe("apply_patch's patch runs from `*** Begin Patch` to `*** End Patch`: it has `*** Begin Patch` but no `*** End Patch` line after it; add `*** End Patch` as the patch's last line. Nothing ran.")
    expect(result.reason).not.toMatch(/must be the whole command/)
    expect(await readFile(path.join(root, 'src', 'a.js'), 'utf8')).toBe('old\n')
  })

  it('a patch joined to another command by `;`: the patch applies and the command is named, never run here (item 2b)', async () => {
    const root = await tempDir('batshit-patch-extra-')

    // A caller that runs nothing after a patch (BL-1915); the API lane runs it (item 2b, below).
    const result = await run("apply_patch <<'PATCH'; touch ran.txt\n*** Begin Patch\n*** Add File: a.md\n+hi\n*** End Patch\nPATCH", root)

    expect(result).toMatchObject({ success: true })
    expect(result.stdout).toContain('Not run: `touch ran.txt`.')
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('hi\n')
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
  })

  it('refuses a patch piped into another command: the patch is not applied and the command does not run', async () => {
    const root = await tempDir('batshit-patch-extra-pipe-')

    const result = await run("apply_patch <<'PATCH' | tee ran.txt\n*** Begin Patch\n*** Add File: a.md\n+hi\n*** End Patch\nPATCH", root)

    expect(result).toMatchObject({ success: false, blocked: false, errorCode: 'INVALID_INPUT' })
    expect(result.reason).toMatch(/Nothing ran\. Send the patch by itself, then run the rest in a separate call: `tee ran\.txt`/)
    expect(existsSync(path.join(root, 'a.md'))).toBe(false)
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
  })

  it('refuses input piped into apply_patch instead of handing it to the shell', async () => {
    const root = await tempDir('batshit-patch-pipe-')

    const result = await run(
      "touch ran.txt && cat <<'PATCH' | apply_patch\n*** Begin Patch\n*** Add File: a.md\n+hi\n*** End Patch\nPATCH",
      root
    )

    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' })
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
    expect(existsSync(path.join(root, 'a.md'))).toBe(false)
  })

  it("refuses a patch passed to another command, not to apply_patch: nothing is applied and nothing runs (Cooper's review, P1)", async () => {
    const root = await tempDir('batshit-patch-p1-')

    const result = await run(
      "apply_patch 'not a patch' && touch ran.txt && printf '%s' '*** Begin Patch\n*** Add File: note.md\n+ok\n*** End Patch'",
      root
    )

    expect(result).toMatchObject({ success: false, blocked: false, errorCode: 'INVALID_INPUT' })
    expect(result.reason).toMatch(/apply_patch must be the whole command/)
    expect(existsSync(path.join(root, 'note.md'))).toBe(false)
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
  })

  it('refuses a cd folder with a space at one end, and writes into neither sibling (BL-254)', async () => {
    const root = await tempDir('batshit-patch-space-')
    await mkdir(path.join(root, 'app'), { recursive: true })
    await mkdir(path.join(root, 'app '), { recursive: true })

    const result = await run(`cd 'app ' && ${addNote('x.md')}`, root)

    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' })
    expect(result.reason).toMatch(/spaces at either end/)
    expect(existsSync(path.join(root, 'app', 'x.md'))).toBe(false)
    expect(existsSync(path.join(root, 'app ', 'x.md'))).toBe(false)
  })

  // Cooper's second review of f7ba560e3: a slash or `/.` after the space passed the raw check, and
  // resolving the path moved the space to its end, where the working-folder trim removed it.
  it.each([
    ['a slash, joined by &&', "cd 'app /' && ", true],
    ['a slash, joined by || exit', "cd 'app /' || exit 1\n", true],
    ['a /., joined by &&', "cd 'app /.' && ", true],
    ['a /., joined by || exit', "cd 'app /.' || exit 1\n", true],
    ['a slash, only the trimmed sibling present', "cd 'app /' && ", false],
    ['a /., only the trimmed sibling present', "cd 'app /.' || exit 1\n", false]
  ])('refuses a cd whose folder resolves to a name ending in a space (%s), and writes into neither folder (BL-254)', async (_label, prefix, spacedFolderExists) => {
    const root = await tempDir('batshit-patch-space-norm-')
    await mkdir(path.join(root, 'app'), { recursive: true })
    if (spacedFolderExists) await mkdir(path.join(root, 'app '), { recursive: true })

    const result = await run(`${prefix}${addNote('note.md')}`, root)

    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' })
    expect(result.reason).toMatch(/spaces at one end/)
    expect(existsSync(path.join(root, 'app', 'note.md'))).toBe(false)
    expect(existsSync(path.join(root, 'app ', 'note.md'))).toBe(false)
    expect(existsSync(path.join(root, 'note.md'))).toBe(false)
  })

  it.each([
    ['a command substitution', 'CHECK=$(touch ran.txt)'],
    ['backticks', 'CHECK=`touch ran.txt`']
  ])("refuses an assignment with %s before apply_patch: no patch, no marker (Cooper's second review, BL-261)", async (_label, assignment) => {
    const root = await tempDir('batshit-patch-assign-')

    const result = await run(`${assignment} ${addNote('note.md')}`, root)

    expect(result).toMatchObject({ success: false, blocked: false, errorCode: 'INVALID_INPUT' })
    expect(result.reason).toMatch(/no variable assignments that expand or run commands/)
    expect(existsSync(path.join(root, 'note.md'))).toBe(false)
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
  })

  it('still applies a patch after a literal assignment', async () => {
    const root = await tempDir('batshit-patch-literal-')

    const result = await run(`LC_ALL=C ${addNote('note.md')}`, root)

    expect(result).toMatchObject({ success: true, blocked: false })
    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('hello\n')
  })

  it("applies a bare patch whose code holds parentheses (Cooper's second review, BL-262)", async () => {
    const root = await tempDir('batshit-patch-bare-')

    const result = await run(
      'apply_patch\n*** Begin Patch\n*** Add File: x.js\n+function hello() { return 1; }\n*** End Patch',
      root
    )

    expect(result).toMatchObject({ success: true, blocked: false })
    expect(await readFile(path.join(root, 'x.js'), 'utf8')).toBe('function hello() { return 1; }\n')
  })

  it('leaves a which probe to the shell, where it finds no program', async () => {
    const root = await tempDir('batshit-patch-probe-')

    const result = await run('command -v apply_patch || echo missing', root)

    // The shell ran it (a managed result carries `managedApplyPatch`, a refusal no exit code).
    expect(result.managedApplyPatch).toBeUndefined()
    expect(result).toMatchObject({ success: true, exitCode: 0 })
  })
})

describe('commands after the patch: the patch is applied, they never run, the result names them (BL-1915)', () => {
  it('applies the patch and names one command on the line after the heredoc', async () => {
    const root = await tempDir('batshit-patch-after-one-')

    const result = await run(`${addNote('a.md')}\ntouch ran.txt`, root)

    expect(result).toMatchObject({ success: true, blocked: false, exitCode: 0 })
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('hello\n')
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
    expect(result.stdout).toBe(
      'Managed apply_patch applied 1 operation(s).\nNot run: `touch ran.txt`. Batshit applies a patch by itself and runs nothing after it in the same command; send that command on its own.'
    )
    expect(result.managedApplyPatch).toMatchObject({ managed: true, operationsApplied: 1, notRun: ['touch ran.txt'] })
  })

  it('names two commands on two lines after a cd-form patch, and runs neither', async () => {
    const root = await tempDir('batshit-patch-after-two-')
    await mkdir(path.join(root, 'app'), { recursive: true })

    const result = await run(`cd app && ${addNote('a.md')}\ntouch one.txt 2>&1 | head -3\necho two > two.txt`, root)

    expect(result).toMatchObject({ success: true })
    expect(await readFile(path.join(root, 'app', 'a.md'), 'utf8')).toBe('hello\n')
    for (const file of ['one.txt', 'two.txt', 'app/one.txt', 'app/two.txt']) expect(existsSync(path.join(root, file)), file).toBe(false)
    expect(result.stdout).toMatch(/Not run: `touch one\.txt 2>&1 \| head -3`, `echo two > two\.txt`\. .*send those commands on their own\.$/)
  })

  it('applies the patch and names the command joined to the heredoc by &&', async () => {
    const root = await tempDir('batshit-patch-after-and-')

    const result = await run("apply_patch <<'PATCH' && touch ran.txt\n*** Begin Patch\n*** Add File: a.md\n+hi\n*** End Patch\nPATCH", root)

    expect(result).toMatchObject({ success: true })
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('hi\n')
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
    expect(result.managedApplyPatch.notRun).toEqual(['touch ran.txt'])
  })

  it.each([
    ['a keyword rule', `${addNote('a.md')}\nsudo make install`, {}, /Privilege escalation/],
    ['the Never Allow list', `${addNote('a.md')}\nnpm publish`, { neverAllowList: ['*npm publish*'] }, /Never Allow/]
  ])('refuses the whole command when %s refuses a command after the patch, and writes nothing', async (_label, command, extra, reason) => {
    const root = await tempDir('batshit-patch-after-refused-')

    const result = await run(command, root, 'dangerous', extra)

    expect(result).toMatchObject({ success: false, blocked: true })
    expect(result.reason).toMatch(reason)
    expect(existsSync(path.join(root, 'a.md'))).toBe(false)
  })

  it('still scans a command after the patch when a later heredoc holds a patch end marker', async () => {
    const root = await tempDir('batshit-patch-after-marker-')

    const result = await run(`${addNote('a.md')}\nsudo make install\ncat <<'EOF'\n*** End Patch\nEOF`, root)

    expect(result).toMatchObject({ success: false, blocked: true })
    expect(result.reason).toMatch(/Privilege escalation/)
    expect(existsSync(path.join(root, 'a.md'))).toBe(false)
  })

  it.each(['heredoc', 'quoted argument', 'bare lines'])('keeps %s patch data out of added Never Allow component checks', async (shape) => {
    const root = await tempDir('batshit-patch-never-allow-data-')
    const document = '*** Begin Patch\n*** Add File: a.md\n+printf forbidden\n*** End Patch'
    const command = shape === 'heredoc' ? `apply_patch <<'PATCH'\n${document}\nPATCH` :
      shape === 'quoted argument' ? `apply_patch '${document}'` : `apply_patch\n${document}`

    const result = await run(command, root, 'dangerous', {
      neverAllowList: ['*printf forbidden*', '*[managed apply_patch payload]*']
    })

    expect(result).toMatchObject({ success: true, blocked: false })
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('printf forbidden\n')
  })

  it.each(['escaped quoted argument', 'CRLF heredoc'])('keeps a denied command visible after an %s patch and before a later data marker', async (shape) => {
    const root = await tempDir('batshit-patch-deny-actual-range-')
    const document = '*** Begin Patch\n*** Add File: a.md\n+say "hi"\n*** End Patch'
    const patch = shape === 'escaped quoted argument'
      ? `apply_patch "${document.replace(/"/g, '\\"')}"`
      : `apply_patch <<'PATCH'\n${document}\nPATCH`.replace(/\n/g, '\r\n')
    const result = await run(`${patch}\nprintf forbidden\ncat <<'DATA'\n*** End Patch\nDATA`, root, 'dangerous', {
      neverAllowList: ['*printf forbidden*']
    })
    expect(result).toMatchObject({ success: false, blocked: true })
    expect(result.reason).toMatch(/Never Allow/)
    expect(existsSync(path.join(root, 'a.md'))).toBe(false)
  })

  it.each(['escaped quoted argument', 'CRLF heredoc'])('keeps a keyword-denied command visible after an %s patch', async (shape) => {
    const root = await tempDir('batshit-patch-keyword-actual-range-')
    const document = '*** Begin Patch\n*** Add File: a.md\n+say "hi"\n*** End Patch'
    const patch = shape === 'escaped quoted argument'
      ? `apply_patch "${document.replace(/"/g, '\\"')}"`
      : `apply_patch <<'PATCH'\n${document}\nPATCH`.replace(/\n/g, '\r\n')
    const result = await run(`${patch}\nsudo make install\ncat <<'DATA'\n*** End Patch\nDATA`, root)
    expect(result).toMatchObject({ success: false, blocked: true })
    expect(result.reason).toMatch(/Privilege escalation/)
    expect(existsSync(path.join(root, 'a.md'))).toBe(false)
  })

  it('stays blocked in Plan mode, where more than one command line is blocked', async () => {
    const root = await tempDir('batshit-patch-after-plan-')

    const result = await run(`${addNote('plan.md')}\nls`, root, 'plan')

    expect(result).toMatchObject({ success: false, blocked: true })
    expect(existsSync(path.join(root, 'plan.md'))).toBe(false)
  })
})

describe('a command after `&&` runs after the whole patch applied (SA-126 item 2)', () => {
  // The API lane's own Bash tool asks for it; every other caller keeps BL-1915's `Not run:`.
  const after = (command: string, root: string, extra: Record<string, unknown> = {}, accessMode: 'dangerous' | 'plan' = 'dangerous') =>
    run(command, root, accessMode, { runCommandAfterPatch: true, ...extra })
  const twoFiles = (tail: string) =>
    `apply_patch <<'PATCH' && ${tail}\n*** Begin Patch\n*** Add File: a.txt\n+new a\n*** Update File: b.txt\n@@\n-old b\n+new b\n*** End Patch\nPATCH`

  it('starts the command only after the last write: it reads every file the patch wrote', async () => {
    const root = await tempDir('batshit-patch-tail-order-')
    await writeFile(path.join(root, 'b.txt'), 'old b\n')

    const result = await after(twoFiles('cat a.txt b.txt'), root)

    expect(result).toMatchObject({ success: true, blocked: false, exitCode: 0 })
    expect(result.stdout).toBe('new a\nnew b\n')
    expect(result.managedApplyPatch).toMatchObject({
      managed: true,
      applied: true,
      operationsApplied: 2,
      afterPatch: { command: 'cat a.txt b.txt', tail: 'cat a.txt b.txt' },
      afterPatchStarted: true
    })
    expect(result.managedApplyPatch.notRun).toBeUndefined()
  })

  it('runs nothing after a patch that did not apply, and says so', async () => {
    const root = await tempDir('batshit-patch-tail-failed-')
    await writeFile(path.join(root, 'b.txt'), 'something else\n')

    const result = await after(twoFiles('touch ran.txt'), root)

    expect(result).toMatchObject({ success: false, blocked: false, errorCode: 'INVALID_INPUT' })
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
    expect(existsSync(path.join(root, 'a.txt'))).toBe(false)
    expect(result.reason).toMatch(/Nothing was written/)
    expect(result.reason).toContain('Not run: `touch ran.txt` (it runs only after the whole patch applies).')
    expect(result.managedApplyPatch?.applied).not.toBe(true)
  })

  it('reports a failing command with the patch still applied', async () => {
    const root = await tempDir('batshit-patch-tail-fails-')
    await writeFile(path.join(root, 'b.txt'), 'old b\n')

    const result = await after(twoFiles('grep -c "new" a.txt b.txt && grep -q missing b.txt'), root)

    expect(result).toMatchObject({ success: false, blocked: false, exitCode: 1 })
    expect(result.stdout).toBe('a.txt:1\nb.txt:1\n')
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('new a\n')
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('new b\n')
    expect(result.managedApplyPatch).toMatchObject({ applied: true, touchedPaths: expect.arrayContaining(['a.txt', 'b.txt']) })
  })

  it('runs the command in the folder of `cd <folder> &&`, as its real path', async () => {
    const root = await tempDir('batshit-patch-tail-cd-')
    await mkdir(path.join(root, 'app'), { recursive: true })

    const result = await after(`cd app && ${addNote('n.md').replace("<<'PATCH'", "<<'PATCH' && pwd && cat n.md")}`, root)

    expect(result).toMatchObject({ success: true, exitCode: 0 })
    expect(result.stdout).toBe(`${path.join(await realpath(root), 'app')}\nhello\n`)
    expect(result.cwd).toBe(path.join(await realpath(root), 'app'))
  })

  it('accepts a pipe inside the command and keeps its exact text', async () => {
    const root = await tempDir('batshit-patch-tail-pipe-')

    const result = await after(addNote('n.md').replace("<<'PATCH'", `<<'PATCH' && cat n.md 2>&1 | tr 'a-z' 'A-Z'`), root)

    expect(result).toMatchObject({ success: true, exitCode: 0, stdout: 'HELLO\n' })
    expect(result.managedApplyPatch.afterPatch).toEqual({ command: "cat n.md 2>&1 | tr 'a-z' 'A-Z'", tail: "cat n.md 2>&1 | tr 'a-z' 'A-Z'" })
  })

  it.each([
    ['a keyword rule', 'sudo make install', {}, /Privilege escalation.*the command after the patch: `sudo make install`\)\. Nothing was written and nothing ran\.$/],
    ['the Never Allow list', 'npm publish', { neverAllowList: ['npm publish'] }, /Never Allow.*the command after the patch: `npm publish`/],
    ['a Never Allow program behind a pipe', 'cat n.md | sh', { neverAllowList: ['sh'] }, /Never Allow.*the command after the patch: `cat n.md \| sh`/],
    ['the plain command limit', `echo ${'x'.repeat(4_001)}`, {}, /The command after the patch is too long \(4006 characters; limit 4000\)/],
    // Item 2b: the wider grammar changes none of these checks.
    ['a keyword rule after `;`', 'npm test; sudo make install', {}, /Privilege escalation.*the command after the patch: `npm test; sudo make install`/],
    ['the Never Allow list after `;`', 'npm test; npm publish', { neverAllowList: ['npm publish'] }, /Never Allow.*the command after the patch/],
    ['the Never Allow list after `||`', 'npm test || npm publish', { neverAllowList: ['npm publish'] }, /Never Allow.*the command after the patch/],
    // A wildcard entry inside `$(…)`; a plain one is pinned in `nativeTools.test.ts` (BL-1981).
    ['a Never Allow wildcard inside `$(…)`', 'echo $(npm publish)', { neverAllowList: ['*npm publish*'] }, /Never Allow.*the command after the patch/],
    ['the Never Allow list in a subshell', '(cd src && npm publish)', { neverAllowList: ['npm publish'] }, /Never Allow.*the command after the patch/],
    ['the plain command limit with `;`', `npm test; echo ${'x'.repeat(4_001)}`, {}, /The command after the patch is too long/]
  ])('refuses the whole call before any write when %s refuses the command', async (_label, tail, extra, reason) => {
    const root = await tempDir('batshit-patch-tail-denied-')

    const result = await after(addNote('n.md').replace("<<'PATCH'", `<<'PATCH' && ${tail}`), root, extra)

    expect(result).toMatchObject({ success: false, blocked: true })
    expect(result.reason).toMatch(reason)
    expect(existsSync(path.join(root, 'n.md'))).toBe(false)
  })

  it('refuses before any write when the command would write into protected Batshit source', async () => {
    const root = await tempDir('batshit-patch-tail-protected-')
    await mkdir(path.join(root, 'batshit-app'), { recursive: true })
    await mkdir(path.join(root, 'batshit-server'), { recursive: true })

    await mkdir(path.join(root, '_local'), { recursive: true })
    // The patch alone may write `_local/` (exempt); the command after it may not write the source.
    const patch = addNote('_local/n.md')
    expect(await run(patch.replace('_local/n.md', '_local/alone.md'), root)).toMatchObject({ success: true })

    for (const command of [
      patch.replace("<<'PATCH'", "<<'PATCH' && echo x > batshit-app/x.ts"),
      `${patch}\nnpm test\necho x > batshit-app/x.ts`,
      `${patch}\ncat _local/alone.md | tee batshit-app/x.ts`,
      // Item 2b: a redirect target is checked whatever joins the command.
      `${patch}\nnpm test; echo x > batshit-app/x.ts`,
      `${patch}\ntrue || echo x >> batshit-app/x.ts`,
      `${patch}\n(echo x > batshit-app/x.ts)`,
      `${patch}\nfor f in a; do echo x > batshit-app/x.ts; done`,
      patch.replace("<<'PATCH'", "<<'PATCH'; echo x > batshit-app/x.ts")
    ]) {
      const result = await after(command, root)
      expect(result, command).toMatchObject({ success: false, blocked: true, errorCode: 'POLICY_BLOCKED' })
    }
    expect(existsSync(path.join(root, '_local', 'n.md'))).toBe(false)
    expect(existsSync(path.join(root, 'batshit-app', 'x.ts'))).toBe(false)
  })

  it('stays blocked in Plan mode, where chaining is blocked', async () => {
    const root = await tempDir('batshit-patch-tail-plan-')

    const result = await after(addNote('plan.md').replace("<<'PATCH'", "<<'PATCH' && cat plan.md"), root, {}, 'plan')
    expect(result).toMatchObject({ success: false, blocked: true })
    expect(result.reason).toBe('Command chaining is blocked in Plan mode (the command after the patch: `cat plan.md`). Nothing was written and nothing ran.')

    const lines = await after(`${addNote('plan.md')}\ncat plan.md`, root, {}, 'plan')
    expect(lines).toMatchObject({ success: false, blocked: true })
    expect(lines.reason).toBe('Multiple shell command lines are blocked in Plan mode (the command after the patch: `cat plan.md`). Nothing was written and nothing ran.')
    expect(existsSync(path.join(root, 'plan.md'))).toBe(false)
  })

  // Item 2b (Faye, 2026-10-21): what a plain command may contain runs after the patch, by its
  // exact text, in the patch's folder, once the whole patch applied.
  it.each([
    ['`||` on the line', `${addNote('n.md').replace("<<'PATCH'", "<<'PATCH' && false || touch ran.txt")}`, ['ran.txt']],
    ['`;` on the line', `${addNote('n.md').replace("<<'PATCH'", "<<'PATCH' && true; touch ran.txt")}`, ['ran.txt']],
    ['`;` right after the patch line', `${addNote('n.md').replace("<<'PATCH'", "<<'PATCH'; touch ran.txt")}`, ['ran.txt']],
    ['`;` on a later line', `${addNote('n.md')}\ntouch ok.txt\ntrue; touch ran.txt`, ['ok.txt', 'ran.txt']],
    ['a `\\` continuation on a later line', `${addNote('n.md')}\ntouch \\\nran.txt`, ['ran.txt']],
    ['a redirect and `$?`', `${addNote('n.md')}\ncat n.md > ran.txt; echo "exit $?" >> ran.txt`, ['ran.txt']],
    ['a `$(…)` and a subshell', `${addNote('n.md')}\nF=$(echo ran.txt); (touch "$F") && test -f ran.txt`, ['ran.txt']],
    ['a for loop', `${addNote('n.md')}\nfor f in ok.txt ran.txt; do touch "$f"; done`, ['ok.txt', 'ran.txt']]
  ])('runs the commands after the patch when they have %s (item 2b)', async (_label, command, made) => {
    const root = await tempDir('batshit-patch-tail-runs-')

    const result = await after(command, root)

    expect(result).toMatchObject({ success: true, exitCode: 0, managedApplyPatch: { applied: true, afterPatchStarted: true } })
    expect(await readFile(path.join(root, 'n.md'), 'utf8')).toBe('hello\n')
    for (const file of made) expect(existsSync(path.join(root, file))).toBe(true)
  })

  it('a redirect after the patch writes what it says (the A3 smoke shape)', async () => {
    const root = await tempDir('batshit-patch-tail-redirect-')
    const result = await after(`${addNote('n.md')}\necho '["my-title"]' > existing.json && cat existing.json; echo "exit=$?"`, root)
    expect(result).toMatchObject({ success: true })
    expect(result.stdout).toBe('["my-title"]\nexit=0\n')
    expect(await readFile(path.join(root, 'existing.json'), 'utf8')).toBe('["my-title"]\n')
  })

  it.each([
    ['`&` on the line', `${addNote('n.md').replace("<<'PATCH'", "<<'PATCH' && touch ran.txt &")}`, ['touch ran.txt']],
    ['`&` between commands on a later line', `${addNote('n.md')}\ntouch ran.txt & touch ok.txt`, ['touch ran.txt & touch ok.txt']],
    ['a heredoc on a later line', `${addNote('n.md')}\ncat > ran.txt <<'EOF'\nx\nEOF`, ['cat > ran.txt <<\'EOF\'']],
    ['a heredoc after `;` on a later line', `${addNote('n.md')}\ntouch ok.txt; cat > ran.txt <<'EOF'\nx\nEOF`, ['touch ok.txt; cat > ran.txt <<\'EOF\'']]
  ])('keeps every command after the patch named and not run when one has %s', async (_label, command, notRun) => {
    const root = await tempDir('batshit-patch-tail-notrun-')

    const result = await after(command, root)

    expect(result).toMatchObject({ success: true })
    expect(await readFile(path.join(root, 'n.md'), 'utf8')).toBe('hello\n')
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
    expect(existsSync(path.join(root, 'ok.txt'))).toBe(false)
    expect(result.managedApplyPatch.notRun).toEqual(notRun)
    expect(result.managedApplyPatch.afterPatch).toBeUndefined()
    // The patch applied: never a suggestion to send it again (Faye, 2026-10-21).
    expect(result.stdout).toMatch(/the patch applied, so send (that command|those commands) on (its|their) own\.$/)
    expect(result.stdout).not.toMatch(/apply_patch <</)
  })

  it.each([
    ['a quoted patch', (root: string) => `apply_patch '*** Begin Patch\n*** Add File: n.md\n+hello\n*** End Patch'\ntouch ran.txt`,
      "Not run: `touch ran.txt`. Batshit runs commands after a patch only when the patch is a heredoc (`apply_patch <<'PATCH'`); the patch applied, so send that command on its own."],
    ['an Agent Browser command', () => `${addNote('n.md')}\nagent-browser open https://example.com`,
      'Not run: `agent-browser open https://example.com`. Batshit does not run an Agent Browser command after a patch; the patch applied, so send that command on its own.'],
    // Item 2b: a shell runs a command after `||` only when the patch failed; running it on a
    // success would invert it (Faye, 2026-10-21).
    ['`||` right after the patch', () => addNote('n.md').replace("<<'PATCH'", "<<'PATCH' || touch ran.txt"),
      'Not run: `touch ran.txt`. A command after `||` right after the patch runs, in a shell, only when the patch fails, and this patch applied, so nothing after the patch ran; send any you still need on their own.'],
    ['`||` right after the patch, with a line after `PATCH`', () => `${addNote('n.md').replace("<<'PATCH'", "<<'PATCH' || exit 1")}\ntouch ran.txt`,
      'Not run: `exit 1`, `touch ran.txt`. A command after `||` right after the patch runs, in a shell, only when the patch fails, and this patch applied, so nothing after the patch ran; send any you still need on their own.'],
    ['a background `&`', () => `${addNote('n.md')}\ntouch ran.txt &`,
      'Not run: `touch ran.txt`. After a patch Batshit runs the commands that follow it as plain shell text, except a background `&`, a heredoc of their own, a `\\` that joins the apply_patch line to the patch, or a chain left open, and here one has one of those; the patch applied, so send that command on its own.']
  ])('says the real reason nothing ran after %s', async (_label, build, line) => {
    const root = await tempDir('batshit-patch-tail-reason-')
    const result = await after(build(root), root)
    expect(result).toMatchObject({ success: true })
    expect(await readFile(path.join(root, 'n.md'), 'utf8')).toBe('hello\n')
    expect(result.stdout).toContain(line)
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
  })

  it('runs the lines after the patch once it applied, as one shell text', async () => {
    const root = await tempDir('batshit-patch-tail-lines-')
    await writeFile(path.join(root, 'b.txt'), 'old b\n')
    const patch = twoFiles('X').replace(' && X', '')

    const result = await after(`${patch}\n\n# check both\ncat a.txt\ncat b.txt | tr 'a-z' 'A-Z'`, root)

    expect(result).toMatchObject({ success: true, exitCode: 0, stdout: 'new a\nNEW B\n' })
    expect(result.managedApplyPatch.afterPatch).toEqual({
      command: "# check both\ncat a.txt\ncat b.txt | tr 'a-z' 'A-Z'",
      tail: "# check both\ncat a.txt\ncat b.txt | tr 'a-z' 'A-Z'"
    })
  })

  it('runs nothing on the lines after a patch that did not apply', async () => {
    const root = await tempDir('batshit-patch-tail-lines-failed-')
    await writeFile(path.join(root, 'b.txt'), 'something else\n')
    const patch = twoFiles('X').replace(' && X', '')

    const result = await after(`${patch}\ntouch ran.txt\ntouch ran2.txt`, root)

    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' })
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
    expect(existsSync(path.join(root, 'ran2.txt'))).toBe(false)
    expect(result.reason).toContain('Not run: `touch ran.txt` (+1 more line) (it runs only after the whole patch applies).')
  })

  it('a later line runs after an earlier one failed, as in a shell, unless the command starts with set -e', async () => {
    const plain = await tempDir('batshit-patch-tail-lines-plain-')
    const loose = await after(`${addNote('n.md')}\nfalse\ntouch ran.txt`, plain)
    expect(loose).toMatchObject({ exitCode: 0 })
    expect(existsSync(path.join(plain, 'ran.txt'))).toBe(true)

    const strict = await tempDir('batshit-patch-tail-lines-strict-')
    const stopped = await after(`set -e\n${addNote('n.md')}\nfalse\ntouch ran.txt`, strict)
    expect(stopped).toMatchObject({ success: false, exitCode: 1 })
    expect(existsSync(path.join(strict, 'n.md'))).toBe(true)
    expect(existsSync(path.join(strict, 'ran.txt'))).toBe(false)
    expect(stopped.managedApplyPatch.afterPatch).toEqual({ command: 'set -e\nfalse\ntouch ran.txt', tail: 'false\ntouch ran.txt' })
  })

  it('carries set -o pipefail into the command after the patch', async () => {
    const root = await tempDir('batshit-patch-tail-pipefail-')

    const result = await after(`set -o pipefail\n${addNote('n.md').replace("<<'PATCH'", "<<'PATCH' && false | cat")}`, root)

    expect(result).toMatchObject({ success: false, exitCode: 1 })
  })

  it('runs the `&&` part, then the lines after the patch, in that order', async () => {
    const root = await tempDir('batshit-patch-tail-mixed-')

    const result = await after(`${addNote('n.md').replace("<<'PATCH'", "<<'PATCH' && echo first")}\necho second`, root)

    expect(result).toMatchObject({ success: true, stdout: 'first\nsecond\n' })
    expect(result.managedApplyPatch.afterPatch.tail).toBe('echo first\necho second')
  })

  it('refuses before any write when a line after the patch is denied', async () => {
    const root = await tempDir('batshit-patch-tail-lines-denied-')

    const result = await after(`${addNote('n.md')}\nnpm test\nnpm publish`, root, { neverAllowList: ['npm publish'] })

    expect(result).toMatchObject({ success: false, blocked: true })
    expect(result.reason).toMatch(/Never Allow.*the command after the patch: `npm test` \(\+1 more line\)/)
    expect(existsSync(path.join(root, 'n.md'))).toBe(false)
  })

  it('never starts the command when a Stop came after the write', async () => {
    const root = await tempDir('batshit-patch-tail-stop-before-')
    const controller = new AbortController()
    writeFailure.when = (file) => {
      // The patch's last write: the Stop arrives right after it.
      if (file.includes('a.txt')) queueMicrotask(() => controller.abort())
      return false
    }

    const result = await after(addNote('a.txt').replace("<<'PATCH'", "<<'PATCH' && touch ran.txt"), root, { abortSignal: controller.signal })

    expect(result).toMatchObject({ success: false, stopped: true, exitCode: null })
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
    expect(result.managedApplyPatch).toMatchObject({ applied: true, afterPatchStarted: false })
  })

  it('writes nothing when the Stop came before the call started', async () => {
    const root = await tempDir('batshit-patch-tail-stop-first-')
    const controller = new AbortController()
    controller.abort()

    const result = await after(addNote('a.txt').replace("<<'PATCH'", "<<'PATCH' && touch ran.txt"), root, { abortSignal: controller.signal })

    // BL-1987: the result says the Stop came before any write, and that the test did not run.
    expect(result).toMatchObject({
      success: false,
      stopped: true,
      reason: 'The command was stopped before the patch wrote anything: no file changed. The commands after the patch did not run.'
    })
    expect(existsSync(path.join(root, 'a.txt'))).toBe(false)
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
  })

  it('ends a long command on a Stop and keeps the patch applied', async () => {
    const root = await tempDir('batshit-patch-tail-stop-during-')
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 400)

    const result = await after(addNote('a.txt').replace("<<'PATCH'", "<<'PATCH' && sleep 20"), root, { abortSignal: controller.signal })

    expect(Date.now() - started).toBeLessThan(10_000)
    expect(result).toMatchObject({ success: false, stopped: true, reason: 'The command was stopped.' })
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(result.managedApplyPatch).toMatchObject({ applied: true, afterPatchStarted: true })
  })

  it('keeps BL-1915 `Not run:` on a caller that does not ask for it', async () => {
    const root = await tempDir('batshit-patch-tail-noflag-')

    const result = await run(addNote('n.md').replace("<<'PATCH'", "<<'PATCH' && touch ran.txt"), root)

    expect(result).toMatchObject({ success: true })
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
    expect(result.managedApplyPatch.notRun).toEqual(['touch ran.txt'])
  })
})

describe('the patch is reported applied before the commands after it run (BL-1978)', () => {
  const after = (command: string, root: string, extra: Record<string, unknown> = {}) =>
    run(command, root, 'dangerous', { runCommandAfterPatch: true, ...extra })

  it('once, after the last write and before the commands start, with the facts the result carries', async () => {
    const root = await tempDir('batshit-patch-reported-')
    const seen: Array<{ facts: Record<string, any>; patched: string; ran: boolean }> = []
    const command = `apply_patch <<'PATCH' && touch ran.txt\n*** Begin Patch\n*** Add File: a.txt\n+new a\n*** End Patch\nPATCH`
    const result = await after(command, root, {
      onPatchApplied: (facts: Record<string, any>) => {
        seen.push({ facts, patched: readFileSync(path.join(root, 'a.txt'), 'utf8'), ran: existsSync(path.join(root, 'ran.txt')) })
      }
    })
    expect(result).toMatchObject({ success: true })
    expect(seen).toHaveLength(1)
    expect(seen[0].patched).toBe('new a\n')
    expect(seen[0].ran).toBe(false)
    expect(seen[0].facts).toMatchObject({
      command,
      mappedToolName: result.mappedToolName,
      mappedReason: result.mappedReason,
      managedApplyPatch: { managed: true, applied: true, operationsApplied: 1, touchedPaths: ['a.txt'], afterPatch: { command: 'touch ran.txt', tail: 'touch ran.txt' } }
    })
    // The reported facts are the result's own, less whether the commands started.
    const { afterPatchStarted: _started, ...resultPatch } = result.managedApplyPatch
    expect(seen[0].facts.managedApplyPatch).toEqual(resultPatch)
  })

  it('never for a patch alone, a patch that does not apply, or a caller that runs nothing after it', async () => {
    const root = await tempDir('batshit-patch-not-reported-')
    const onPatchApplied = vi.fn()
    await after(addNote('alone.txt'), root, { onPatchApplied })
    await after(`apply_patch <<'PATCH' && touch ran.txt\n*** Begin Patch\n*** Update File: missing.txt\n@@\n-x\n+y\n*** End Patch\nPATCH`, root, { onPatchApplied })
    await run(`apply_patch <<'PATCH' && touch ran.txt\n*** Begin Patch\n*** Add File: cli.txt\n+x\n*** End Patch\nPATCH`, root, 'dangerous', { onPatchApplied })
    expect(onPatchApplied).not.toHaveBeenCalled()
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
  })
})

describe('a Stop while the patch is being planned writes nothing (BL-1987)', () => {
  const twoUpdates = `apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: a.txt\n@@\n-old a\n+new a\n*** Update File: b.txt\n@@\n-old b\n+new b\n*** End Patch\nPATCH`

  async function seed(prefix: string) {
    const root = await tempDir(prefix)
    await writeFile(path.join(root, 'a.txt'), 'old a\n')
    await writeFile(path.join(root, 'b.txt'), 'old b\n')
    writeFailure.writes = []
    return root
  }

  it('a Stop while the first file is read: the planning ends there, nothing is read after it or written', async () => {
    const root = await seed('batshit-patch-stop-plan-first-')
    const stop = new AbortController()
    const read: string[] = []
    writeFailure.onRead = (file) => {
      read.push(path.basename(file))
      if (file.endsWith(`${path.sep}a.txt`)) stop.abort('user')
    }
    const result = await run(twoUpdates, root, 'dangerous', { abortSignal: stop.signal })
    expect(result).toMatchObject({ success: false, stopped: true, reason: 'The command was stopped before the patch wrote anything: no file changed.' })
    expect(read).not.toContain('b.txt')
    expect(writeFailure.writes).toEqual([])
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('old a\n')
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('old b\n')
  })

  it('a Stop while the last file is read: the check before the first write stops it', async () => {
    const root = await seed('batshit-patch-stop-plan-last-')
    const stop = new AbortController()
    writeFailure.onRead = (file) => {
      if (file.endsWith(`${path.sep}b.txt`)) stop.abort('user')
    }
    const result = await run(twoUpdates, root, 'dangerous', { abortSignal: stop.signal })
    expect(result).toMatchObject({ success: false, stopped: true, reason: 'The command was stopped before the patch wrote anything: no file changed.' })
    expect(result.managedApplyPatch).toBeUndefined()
    expect(writeFailure.writes).toEqual([])
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('old a\n')
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('old b\n')
  })

  it('with commands after the patch, neither the patch nor the commands run (SA-126 item 2)', async () => {
    const root = await seed('batshit-patch-stop-plan-tail-')
    const stop = new AbortController()
    writeFailure.onRead = (file) => {
      if (file.endsWith(`${path.sep}b.txt`)) stop.abort('user')
    }
    const result = await run(`${twoUpdates}\ntouch ran.txt`, root, 'dangerous', { abortSignal: stop.signal, runCommandAfterPatch: true })
    expect(result).toMatchObject({
      success: false,
      stopped: true,
      reason: 'The command was stopped before the patch wrote anything: no file changed. The commands after the patch did not run.'
    })
    expect(writeFailure.writes).toEqual([])
    expect(existsSync(path.join(root, 'ran.txt'))).toBe(false)
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('old a\n')
  })

  it('a Stop after the writes began does not cut the patch: it is applied whole (BL-1916)', async () => {
    const root = await seed('batshit-patch-stop-during-write-')
    const stop = new AbortController()
    writeFailure.when = (file) => {
      if (file.endsWith(`${path.sep}a.txt`)) stop.abort('user')
      return false
    }
    const result = await run(twoUpdates, root, 'dangerous', { abortSignal: stop.signal })
    expect(result).toMatchObject({ success: true, managedApplyPatch: { applied: true } })
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('new a\n')
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('new b\n')
  })
})

describe('a patch is applied whole or not at all (BL-1916)', () => {
  const patch = (...sections: string[]) =>
    `apply_patch <<'PATCH'\n*** Begin Patch\n${sections.join('\n')}\n*** End Patch\nPATCH`

  async function seed(root: string, files: Record<string, string>) {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true })
      await writeFile(path.join(root, name), content)
    }
  }

  async function snapshot(root: string, names: string[]) {
    return Object.fromEntries(
      await Promise.all(names.map(async (name) => [name, existsSync(path.join(root, name)) ? await readFile(path.join(root, name), 'utf8') : null]))
    )
  }

  it('writes nothing when a later hunk does not match: the earlier Add, Update, Delete and Move stay unwritten', async () => {
    const root = await tempDir('batshit-patch-atomic-hunk-')
    await seed(root, { 'keep.txt': 'one\ntwo\n', 'gone.txt': 'bye\n', 'move.txt': 'm\n', 'bad.txt': 'real\n' })
    const before = await snapshot(root, ['new/deep/a.txt', 'keep.txt', 'gone.txt', 'move.txt', 'moved.txt', 'bad.txt'])

    const result = await run(
      patch(
        '*** Add File: new/deep/a.txt\n+fresh',
        '*** Update File: keep.txt\n@@\n-one\n+ONE',
        '*** Delete File: gone.txt',
        '*** Update File: move.txt\n*** Move to: moved.txt',
        '*** Update File: bad.txt\n@@\n-not there\n+x'
      ),
      root
    )

    expect(result).toMatchObject({ success: false, blocked: false, errorCode: 'INVALID_INPUT' })
    expect(result.reason).toBe(
      'Failed to apply hunk "@@" in bad.txt: context did not match. Nothing was written: Batshit applies a patch only when all of it applies.'
    )
    expect(await snapshot(root, Object.keys(before))).toEqual(before)
    expect(existsSync(path.join(root, 'new'))).toBe(false)
  })

  it('writes nothing when a later Add File names a file that exists, and says to update it instead', async () => {
    const root = await tempDir('batshit-patch-atomic-exists-')
    await seed(root, { 'keep.txt': 'one\n', 'there.txt': 'mine\n' })

    const result = await run(patch('*** Update File: keep.txt\n@@\n-one\n+ONE', '*** Add File: there.txt\n+theirs'), root)

    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' })
    expect(result.reason).toBe(
      'Cannot add file "there.txt" because it already exists; use `*** Update File` to change it. Nothing was written: Batshit applies a patch only when all of it applies.'
    )
    expect(await snapshot(root, ['keep.txt', 'there.txt'])).toEqual({ 'keep.txt': 'one\n', 'there.txt': 'mine\n' })
  })

  it('then applies the resent patch in full', async () => {
    const root = await tempDir('batshit-patch-atomic-resend-')
    await seed(root, { 'b.txt': 'old\n' })
    const bad = patch('*** Add File: a.txt\n+new', '*** Update File: b.txt\n@@\n-wrong\n+x')
    const good = patch('*** Add File: a.txt\n+new', '*** Update File: b.txt\n@@\n-old\n+x')

    expect(await run(bad, root)).toMatchObject({ success: false })
    const resent = await run(good, root)

    expect(resent).toMatchObject({ success: true })
    expect(resent.managedApplyPatch).toMatchObject({ operationsApplied: 2, touchedPaths: ['a.txt', 'b.txt'] })
    expect(await snapshot(root, ['a.txt', 'b.txt'])).toEqual({ 'a.txt': 'new\n', 'b.txt': 'x\n' })
  })

  it('applies operations that build on each other in order (an Add, then an Update of it, then a Move)', async () => {
    const root = await tempDir('batshit-patch-atomic-chain-')

    const result = await run(
      patch('*** Add File: a.txt\n+one', '*** Update File: a.txt\n@@\n-one\n+two', '*** Update File: a.txt\n*** Move to: b/c.txt'),
      root
    )

    expect(result).toMatchObject({ success: true })
    expect(await snapshot(root, ['a.txt', 'b/c.txt'])).toEqual({ 'a.txt': null, 'b/c.txt': 'two\n' })
  })

  it('updates a file through a link, and refuses a patch that names one file by two paths', async () => {
    const root = await tempDir('batshit-patch-atomic-link-')
    await seed(root, { 'real.md': 'one\n' })
    await symlink(path.join(root, 'real.md'), path.join(root, 'link.md'))

    const through = await run(patch('*** Update File: link.md\n@@\n-one\n+two'), root)
    expect(through).toMatchObject({ success: true })
    expect(await readFile(path.join(root, 'real.md'), 'utf8')).toBe('two\n')

    const twice = await run(patch('*** Update File: link.md\n@@\n-two\n+three', '*** Update File: real.md\n@@\n-two\n+four'), root)
    expect(twice).toMatchObject({ success: false })
    expect(twice.reason).toMatch(/is the same file as another path in this patch.*Nothing was written/)
    expect(await readFile(path.join(root, 'real.md'), 'utf8')).toBe('two\n')
  })

  it('puts every file back when a write fails part way: an updated file, a deleted file, a link, new folders', async () => {
    const root = await tempDir('batshit-patch-atomic-rollback-')
    await seed(root, { 'keep.txt': 'one\n', 'gone.txt': 'bye\n', 'target.txt': 't\n' })
    await symlink(path.join(root, 'target.txt'), path.join(root, 'link.txt'))
    writeFailure.when = (file) => file.endsWith(`${path.sep}last.txt`)

    const result = await run(
      patch(
        '*** Update File: keep.txt\n@@\n-one\n+ONE',
        '*** Delete File: gone.txt',
        '*** Delete File: link.txt',
        '*** Add File: new/deep/a.txt\n+fresh',
        '*** Add File: last.txt\n+never'
      ),
      root
    )

    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' })
    expect(result.reason).toBe(
      'Writing "last.txt" failed (EIO: i/o error, write). Batshit put back every file the patch had changed, so nothing was written.'
    )
    expect(result.managedApplyPatch).toBeUndefined()
    expect(await snapshot(root, ['keep.txt', 'gone.txt', 'target.txt', 'last.txt'])).toEqual({
      'keep.txt': 'one\n',
      'gone.txt': 'bye\n',
      'target.txt': 't\n',
      'last.txt': null
    })
    expect(await readFile(path.join(root, 'link.txt'), 'utf8')).toBe('t\n')
    expect((await lstat(path.join(root, 'link.txt'))).isSymbolicLink()).toBe(true)
    expect(existsSync(path.join(root, 'new'))).toBe(false)
    // No temporary copy of a removed file is left behind.
    expect((await readdir(root)).filter((name) => name.includes('batshit-patch'))).toEqual([])
  })

  it('puts back a file changed through a link, and a file removed then added again with its mode', async () => {
    const root = await tempDir('batshit-patch-atomic-rollback-two-')
    await seed(root, { 'target.txt': 'one\n', 'run.sh': 'echo old\n' })
    await symlink(path.join(root, 'target.txt'), path.join(root, 'link.txt'))
    await chmod(path.join(root, 'run.sh'), 0o755)
    writeFailure.when = (file) => file.endsWith(`${path.sep}last.txt`)

    const result = await run(
      patch(
        '*** Update File: link.txt\n@@\n-one\n+two',
        '*** Delete File: run.sh',
        '*** Add File: run.sh\n+echo new',
        '*** Add File: last.txt\n+never'
      ),
      root
    )

    expect(result).toMatchObject({ success: false })
    expect(result.reason).toMatch(/put back every file the patch had changed/)
    expect(await snapshot(root, ['target.txt', 'run.sh', 'last.txt'])).toEqual({ 'target.txt': 'one\n', 'run.sh': 'echo old\n', 'last.txt': null })
    expect((await lstat(path.join(root, 'link.txt'))).isSymbolicLink()).toBe(true)
    expect((await stat(path.join(root, 'run.sh'))).mode & 0o777).toBe(0o755)
  })

  it('a Delete then an Add of a link makes a new file at the name and leaves the link target alone (BL-2006 review)', async () => {
    const root = await tempDir('batshit-patch-atomic-link-readd-')
    await seed(root, { 'real.txt': 'real\n' })
    await symlink(path.join(root, 'real.txt'), path.join(root, 'link.txt'))

    const result = await run(patch('*** Delete File: link.txt', '*** Add File: link.txt\n+new'), root)

    expect(result).toMatchObject({ success: true })
    expect((await lstat(path.join(root, 'link.txt'))).isSymbolicLink()).toBe(false)
    expect(await snapshot(root, ['link.txt', 'real.txt'])).toEqual({ 'link.txt': 'new\n', 'real.txt': 'real\n' })
    expect((await readdir(root)).filter((name) => name.includes('batshit-patch'))).toEqual([])
  })

  it('puts a link back after a Delete then an Add of it when a later write fails, and says so truly', async () => {
    const root = await tempDir('batshit-patch-atomic-link-readd-fail-')
    await seed(root, { 'real.txt': 'real\n' })
    await symlink(path.join(root, 'real.txt'), path.join(root, 'link.txt'))
    writeFailure.when = (file) => file.endsWith(`${path.sep}last.txt`)

    const result = await run(patch('*** Delete File: link.txt', '*** Add File: link.txt\n+new', '*** Add File: last.txt\n+never'), root)

    expect(result).toMatchObject({ success: false })
    expect(result.reason).toBe(
      'Writing "last.txt" failed (EIO: i/o error, write). Batshit put back every file the patch had changed, so nothing was written.'
    )
    expect((await lstat(path.join(root, 'link.txt'))).isSymbolicLink()).toBe(true)
    expect(await snapshot(root, ['real.txt', 'last.txt'])).toEqual({ 'real.txt': 'real\n', 'last.txt': null })
    expect((await readdir(root)).filter((name) => name.includes('batshit-patch'))).toEqual([])
  })

  it('a Delete, an Add and an Update of a link write the new file at the name every time, never the old target', async () => {
    const root = await tempDir('batshit-patch-atomic-link-readd-update-')
    await seed(root, { 'real.txt': 'real\n' })
    await symlink(path.join(root, 'real.txt'), path.join(root, 'link.txt'))

    const result = await run(patch('*** Delete File: link.txt', '*** Add File: link.txt\n+new', '*** Update File: link.txt\n@@\n-new\n+NEW'), root)

    expect(result).toMatchObject({ success: true })
    expect((await lstat(path.join(root, 'link.txt'))).isSymbolicLink()).toBe(false)
    expect(await snapshot(root, ['link.txt', 'real.txt'])).toEqual({ 'link.txt': 'NEW\n', 'real.txt': 'real\n' })
  })

  it('the same three steps and a failing write: the link comes back and its target was never touched', async () => {
    const root = await tempDir('batshit-patch-atomic-link-readd-update-fail-')
    await seed(root, { 'real.txt': 'real\n' })
    await symlink(path.join(root, 'real.txt'), path.join(root, 'link.txt'))
    writeFailure.when = (file) => file.endsWith(`${path.sep}last.txt`)

    const result = await run(
      patch('*** Delete File: link.txt', '*** Add File: link.txt\n+new', '*** Update File: link.txt\n@@\n-new\n+NEW', '*** Add File: last.txt\n+never'),
      root
    )

    expect(result).toMatchObject({ success: false })
    expect(result.reason).toMatch(/put back every file the patch had changed, so nothing was written\.$/)
    expect((await lstat(path.join(root, 'link.txt'))).isSymbolicLink()).toBe(true)
    expect(await snapshot(root, ['real.txt', 'last.txt'])).toEqual({ 'real.txt': 'real\n', 'last.txt': null })
    expect((await readdir(root)).filter((name) => name.includes('batshit-patch'))).toEqual([])
  })

  it('an Add, a Delete and an Add of one path, then a failure: the rollback removes the name once, never a file that appeared there (BL-2022)', async () => {
    const root = await tempDir('batshit-patch-atomic-readd-rollback-')
    writeFailure.when = (file) => file.endsWith(`${path.sep}last.txt`)
    // Right after the rollback first removes a.txt, a parallel command puts its own file there.
    let removedOnce = false
    let planted = false
    writeFailure.onOp = async (op, file) => {
      if (removedOnce && !planted) {
        planted = true
        await writeFile(path.join(root, 'a.txt'), 'theirs\n')
      }
      if (op === 'unlink' && file === '/a.txt') removedOnce = true
    }

    const result = await run(patch('*** Add File: a.txt\n+one', '*** Delete File: a.txt', '*** Add File: a.txt\n+two', '*** Add File: last.txt\n+never'), root)

    expect(result).toMatchObject({ success: false })
    expect(planted).toBe(true)
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('theirs\n')
    expect((await readdir(root)).filter((name) => name.includes('batshit-patch'))).toEqual([])
  })

  it('deletes a file without reading it (a large file is never loaded), and leaves no copy behind', async () => {
    const root = await tempDir('batshit-patch-atomic-delete-')
    await seed(root, { 'huge.bin': 'pretend this is 3 GB\n', 'keep.txt': 'one\n' })
    writeFailure.readRefused = (file) => file.endsWith(`${path.sep}huge.bin`)

    const result = await run(patch('*** Delete File: huge.bin', '*** Update File: keep.txt\n@@\n-one\n+two'), root)

    expect(result).toMatchObject({ success: true })
    expect(await snapshot(root, ['huge.bin', 'keep.txt'])).toEqual({ 'huge.bin': null, 'keep.txt': 'two\n' })
    expect((await readdir(root)).sort()).toEqual(['keep.txt'])
  })

  it('refuses a path under a file before writing anything, and reports nothing as left changed', async () => {
    const root = await tempDir('batshit-patch-atomic-notdir-')
    await seed(root, { 'a.txt': 'file\n', 'keep.txt': 'one\n' })

    const result = await run(patch('*** Update File: keep.txt\n@@\n-one\n+two', '*** Add File: a.txt/b.txt\n+x'), root)

    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' })
    expect(result.reason).toBe('Cannot write "a.txt/b.txt": a folder in its path is a file. Nothing was written: Batshit applies a patch only when all of it applies.')
    expect(result.managedApplyPatch).toBeUndefined()
    expect(await snapshot(root, ['a.txt', 'keep.txt'])).toEqual({ 'a.txt': 'file\n', 'keep.txt': 'one\n' })
  })

  it.each([
    ['a Delete, then an Add of the same path', { 'a.txt': 'old\n' }, ['*** Delete File: a.txt', '*** Add File: a.txt\n+new'], { 'a.txt': 'new\n' }],
    ['an Update, then a Delete of the same file', { 'a.txt': 'old\n' }, ['*** Update File: a.txt\n@@\n-old\n+mid', '*** Delete File: a.txt'], { 'a.txt': null }],
    ['two Updates of one file', { 'a.txt': 'one\ntwo\n' }, ['*** Update File: a.txt\n@@\n-one\n+ONE', '*** Update File: a.txt\n@@\n-two\n+TWO'], { 'a.txt': 'ONE\nTWO\n' }],
    ['an Update with a Move, then an Update of the destination', { 'a.txt': 'one\n' }, ['*** Update File: a.txt\n*** Move to: b.txt', '*** Update File: b.txt\n@@\n-one\n+two'], { 'a.txt': null, 'b.txt': 'two\n' }]
  ])('applies %s as the operations read in order', async (_label, files, sections, expected) => {
    const root = await tempDir('batshit-patch-atomic-order-')
    await seed(root, files)

    const result = await run(patch(...sections), root)

    expect(result).toMatchObject({ success: true })
    expect(await snapshot(root, Object.keys(expected))).toEqual(expected)
    expect((await readdir(root)).filter((name) => name.includes('batshit-patch'))).toEqual([])
  })

  it('never lets one name in another letter case overwrite a file the patch just added', async () => {
    const root = await tempDir('batshit-patch-atomic-case-')
    await writeFile(path.join(root, 'probe.txt'), 'x')
    const caseInsensitive = existsSync(path.join(root, 'PROBE.TXT'))
    await rm(path.join(root, 'probe.txt'))

    const result = await run(patch('*** Add File: a.txt\n+lower', '*** Add File: A.txt\n+upper'), root)

    if (caseInsensitive) {
      expect(result).toMatchObject({ success: false })
      expect(result.reason).toMatch(/^Writing "A\.txt" failed \(a file is already at that name: .*another letter case\)\. Batshit put back every file the patch had changed, so nothing was written\.$/)
      expect(await readdir(root)).toEqual([])
    } else {
      expect(result).toMatchObject({ success: true })
      expect(await snapshot(root, ['a.txt', 'A.txt'])).toEqual({ 'a.txt': 'lower\n', 'A.txt': 'upper\n' })
    }
  })

  it('names the files it could not put back, for the model and the dead-copy ledger', async () => {
    const root = await tempDir('batshit-patch-atomic-partial-')
    await seed(root, { 'keep.txt': 'one\n' })
    // The new file fails, and so does putting keep.txt back (the restore writes the saved bytes).
    writeFailure.when = (file, data) => file.endsWith(`${path.sep}b.txt`) || (file.endsWith(`${path.sep}keep.txt`) && Buffer.isBuffer(data))

    const result = await run(patch('*** Update File: keep.txt\n@@\n-one\n+ONE', '*** Add File: b.txt\n+new'), root)

    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' })
    expect(result.reason).toBe(
      'Writing "b.txt" failed (EIO: i/o error, write), and Batshit could not put back keep.txt: that path is left changed. Read it before you patch again.'
    )
    expect(result.managedApplyPatch).toEqual({ managed: true, partial: true, changedPaths: [path.join(await realpath(root), 'keep.txt')] })
    expect(await readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('ONE\n')
  })
})

describe('a hunk that matches more than one place is placed by its @@ line or refused (BL-2156)', () => {
  const twoFunctions = 'function a() {\n  return null\n}\nfunction b() {\n  return null\n}\n'
  const patch = (hunk: string) => `apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: f.js\n${hunk}\n*** End Patch\nPATCH`

  async function seeded(prefix: string) {
    const root = await tempDir(prefix)
    await writeFile(path.join(root, 'f.js'), twoFunctions)
    return root
  }

  it.each([
    ['its @@ line', '@@ function b() {'],
    ['a unified-diff header’s section name', '@@ -4,3 +4,3 @@ function b() {'],
    ['the start of its @@ line', '@@ function b()']
  ])('changes the match under %s, not the first one', async (_label, header) => {
    const root = await seeded('batshit-patch-anchor-')
    const result = await run(patch(`${header}\n-  return null\n+  return 42`), root)
    expect(result).toMatchObject({ success: true })
    expect(await readFile(path.join(root, 'f.js'), 'utf8')).toBe('function a() {\n  return null\n}\nfunction b() {\n  return 42\n}\n')
  })

  it('refuses a hunk with no @@ line that picks one, and writes nothing', async () => {
    const root = await seeded('batshit-patch-ambiguous-')
    const result = await run(patch('@@\n-  return null\n+  return 42'), root)
    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' })
    expect(result.reason).toBe(
      'Failed to apply hunk "@@" in f.js: its lines match 2 places. Add unchanged lines around the change, or start the hunk with an `@@` line naming the function or class it is in, so it matches one place. Nothing was written: Batshit applies a patch only when all of it applies.'
    )
    expect(await readFile(path.join(root, 'f.js'), 'utf8')).toBe(twoFunctions)
  })

  it('refuses when its @@ line names no line before a match', async () => {
    const root = await seeded('batshit-patch-anchor-miss-')
    const result = await run(patch('@@ function c() {\n-  return null\n+  return 42'), root)
    expect(result).toMatchObject({ success: false })
    expect(result.reason).toContain('its lines match 2 places and its `@@` line does not pick one.')
    expect(await readFile(path.join(root, 'f.js'), 'utf8')).toBe(twoFunctions)
  })

  const twoClasses =
    'class Cart {\n  constructor() {\n    this.items = []\n  }\n}\nclass Wishlist {\n  constructor() {\n    this.items = []\n  }\n}\n'
  const update = (file: string, hunks: string) => `apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: ${file}\n${hunks}\n*** End Patch\nPATCH`

  it('stacked @@ lines narrow in order: the class first, then the method inside it', async () => {
    const root = await tempDir('batshit-patch-stacked-')
    await writeFile(path.join(root, 'c.js'), twoClasses)
    const result = await run(update('c.js', '@@ class Wishlist {\n@@ constructor() {\n-    this.items = []\n+    this.items = new Map()'), root)
    expect(result).toMatchObject({ success: true })
    expect(await readFile(path.join(root, 'c.js'), 'utf8')).toBe(twoClasses.replace(/(class Wishlist[\s\S]*?)this\.items = \[\]/, '$1this.items = new Map()'))
  })

  it('refuses an @@ line that names more than one place (a repeated method), and writes nothing', async () => {
    const root = await tempDir('batshit-patch-repeated-anchor-')
    await writeFile(path.join(root, 'c.js'), twoClasses)
    const result = await run(update('c.js', '@@ constructor() {\n-    this.items = []\n+    this.items = new Map()'), root)
    expect(result).toMatchObject({ success: false })
    expect(result.reason).toContain('its lines match 2 places and its `@@` line does not pick one.')
    expect(await readFile(path.join(root, 'c.js'), 'utf8')).toBe(twoClasses)
  })

  it('an @@ line that only starts two lines picks neither; the whole line picks one', async () => {
    const twoParsers =
      'export function parseConfigFile(path) {\n  return JSON.parse(text)\n}\nexport function parseConfig(text) {\n  return JSON.parse(text)\n}\n'
    const root = await tempDir('batshit-patch-prefix-anchor-')
    await writeFile(path.join(root, 'p.ts'), twoParsers)
    const refused = await run(update('p.ts', '@@ export function parseConfig\n-  return JSON.parse(text)\n+  return JSON.parse(text) as Config'), root)
    expect(refused).toMatchObject({ success: false })
    expect(await readFile(path.join(root, 'p.ts'), 'utf8')).toBe(twoParsers)

    const placed = await run(update('p.ts', '@@ export function parseConfig(text) {\n-  return JSON.parse(text)\n+  return JSON.parse(text) as Config'), root)
    expect(placed).toMatchObject({ success: true })
    expect(await readFile(path.join(root, 'p.ts'), 'utf8')).toBe(twoParsers.replace(/(parseConfig\(text\)[\s\S]*?JSON\.parse\(text\))/, '$1 as Config'))
  })

  it('two hunks under the same @@ line both land in that function', async () => {
    const file = 'function b() {\n  x = 1\n  return null\n}\nfunction c() {\n  return null\n}\n'
    const root = await tempDir('batshit-patch-same-anchor-')
    await writeFile(path.join(root, 'f.js'), file)
    const result = await run(update('f.js', '@@ function b() {\n-  x = 1\n+  x = 2\n@@ function b() {\n-  return null\n+  return 42'), root)
    expect(result).toMatchObject({ success: true })
    expect(await readFile(path.join(root, 'f.js'), 'utf8')).toBe('function b() {\n  x = 2\n  return 42\n}\nfunction c() {\n  return null\n}\n')
  })

  const dogAndCat = ['Dog', 'Cat']
    .map((name) => `class ${name}(Animal):\n    def __init__(self):\n        super().__init__()\n\n    def speak(self):\n        return self.sound\n        # end\n`)
    .join('\n\n')
  // The format's own shape: three unchanged lines above the change, which reach above the method's `@@` line.
  const speakHunk = '         super().__init__()\n \n     def speak(self):\n-        return self.sound\n+        return "woof"\n         # end'

  it.each(['Dog', 'Cat'])('stacked @@ lines with unchanged lines above the method change %s, the class they name', async (name) => {
    const root = await tempDir('batshit-patch-context-above-')
    await writeFile(path.join(root, 'a.py'), dogAndCat)
    const result = await run(update('a.py', `@@ class ${name}(Animal):\n@@     def speak(self):\n${speakHunk}`), root)
    expect(result).toMatchObject({ success: true })
    const blocks = (await readFile(path.join(root, 'a.py'), 'utf8')).split('\n\n\n')
    expect(blocks.map((block) => block.includes('return "woof"'))).toEqual(dogAndCat.split('\n\n\n').map((block) => block.startsWith(`class ${name}`)))
  })

  it('refuses a repeated method @@ line even when its unchanged lines start above it', async () => {
    const root = await tempDir('batshit-patch-context-above-refused-')
    await writeFile(path.join(root, 'a.py'), dogAndCat)
    const result = await run(update('a.py', `@@     def speak(self):\n${speakHunk}`), root)
    expect(result).toMatchObject({ success: false })
    expect(await readFile(path.join(root, 'a.py'), 'utf8')).toBe(dogAndCat)
  })

  it('reads each @@ line once, so stacked @@ lines on a 50,000-line file answer at once', async () => {
    // BL-2156 confirm review 2: scanning to the end of the file for every outer line took about 15 s here.
    const big = Array.from({ length: 10_000 }, (_, index) => `class K${index} {\n  render() {\n    return null\n  }\n}\n`).join('')
    const root = await tempDir('batshit-patch-large-stacked-')
    await writeFile(path.join(root, 'big.js'), big)
    const result = await run(update('big.js', '@@ }\n@@ render() {\n-    return null\n+    return 1'), root)
    expect(result).toMatchObject({ success: false })
    expect(result.reason).toContain('its `@@` line does not pick one')
  })

  it('a hunk whose lines match one place applies there as before, whatever its @@ line says', async () => {
    const root = await seeded('batshit-patch-unique-')
    const result = await run(patch('@@ something else\n function b() {\n-  return null\n+  return 42'), root)
    expect(result).toMatchObject({ success: true })
    expect(await readFile(path.join(root, 'f.js'), 'utf8')).toBe('function a() {\n  return null\n}\nfunction b() {\n  return 42\n}\n')
  })
})

describe('Add File sections without + prefixes (BL-1915)', () => {
  it('writes a section with no + line as the file as written, blank lines and indentation kept', async () => {
    const root = await tempDir('batshit-patch-verbatim-')

    const result = await run("apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: a.py\nimport os\n\ndef main():\n    return 1\n*** End Patch\nPATCH", root)

    expect(result).toMatchObject({ success: true })
    expect(await readFile(path.join(root, 'a.py'), 'utf8')).toBe('import os\n\ndef main():\n    return 1\n')
  })

  it('refuses a section that mixes + lines with plain lines, and writes nothing', async () => {
    const root = await tempDir('batshit-patch-mixed-')

    const result = await run("apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: a.py\n+import os\ndef main():\n*** End Patch\nPATCH", root)

    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' })
    expect(result.reason).toBe(
      'Invalid line in "*** Add File" section: "def main():": every line in an Add File section must start with `+` (an empty line is `+`). Nothing was written.'
    )
    expect(existsSync(path.join(root, 'a.py'))).toBe(false)
  })
})

describe('the length limit points at the patch for a large file (BL-1915)', () => {
  it('refuses a heredoc write over 4,000 characters and says how to send the file instead', async () => {
    const root = await tempDir('batshit-patch-length-')
    const command = `cat > big.py <<'EOF'\n${'x = 1\n'.repeat(800)}EOF`

    const result = await run(command, root)

    expect(result).toMatchObject({ success: false, blocked: true })
    expect(result.reason).toBe(
      `Command is too long (${command.length} characters; limit 4000). To write a file, send it as \`apply_patch\` \`*** Add File\`, every line prefixed with \`+\`; do not resend the heredoc. A patch may be 200000 characters long. Split any other work into smaller commands.`
    )
    expect(existsSync(path.join(root, 'big.py'))).toBe(false)
  })

  it('lands a 12,000-character file sent as Add File on the first call', async () => {
    const root = await tempDir('batshit-patch-length-add-')
    const lines = Array.from({ length: 750 }, (_, index) => `value_${String(index).padStart(4, '0')} = ${index}`)

    const result = await run(`apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: big.py\n${lines.map((line) => `+${line}`).join('\n')}\n*** End Patch\nPATCH`, root)

    expect(result).toMatchObject({ success: true })
    expect((await readFile(path.join(root, 'big.py'), 'utf8')).length).toBeGreaterThan(12_000)
  })
})

describe('the tool text tells the model how to send apply_patch (BL-244)', () => {
  it('is in the API lane bash tool description', async () => {
    const root = await tempDir('batshit-patch-text-')
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: root,
      providerSettings: {
        nativeTools: {
          bashEnabled: true,
          executionBackend: 'local',
          bashPolicyMode: 'workspace',
          bashAccessMode: 'dangerous',
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          agentBrowserEnabled: false
        }
      },
      toolApprovalMode: 'none'
    } as any)
    const description: string = (tools as any).native_bash_execute.description

    expect(description).toContain(NATIVE_BASH_APPLY_PATCH_GUIDANCE)
    // BL-244: built in, so no `which` probe (B0 lost 37 chats' requests to it).
    expect(NATIVE_BASH_APPLY_PATCH_GUIDANCE).toMatch(/apply_patch is built in \(not a program on the PATH\)/)
    // With typed file tools on the prompt prefers `edit_file` for one file, so this text never
    // says "edit files with apply_patch" (the tool-descriptions review, 2026-10-23).
    expect(NATIVE_BASH_APPLY_PATCH_GUIDANCE).not.toMatch(/Edit files with/)
    // SA-126 item 2: a test after the patch runs in the same call, and the text says how.
    expect(NATIVE_BASH_APPLY_PATCH_GUIDANCE).toContain("apply_patch <<'PATCH' && npm test")
    expect(NATIVE_BASH_APPLY_PATCH_GUIDANCE).not.toMatch(/in a separate call/)
    // Josh (2026-10-23): small diffs, as Pi steers its edit tool. It leans on BL-2156: a hunk that
    // matches more than one place is placed only when its @@ lines pick one match. Josh (2026-11-05):
    // one patch for the planned changes comes first, so "small" is never read as "small patches".
    expect(NATIVE_BASH_APPLY_PATCH_GUIDANCE).toContain('Put all the changes you have planned into one patch, even across several files. Keep each change precise: only the lines that change, with just enough unchanged lines around them to match one place. Never rewrite a whole file to change a few lines.')
    expect(NATIVE_BASH_APPLY_PATCH_GUIDANCE).not.toMatch(/Keep each change small/)
    // BL-1915: how to write a large file the first time.
    expect(NATIVE_BASH_APPLY_PATCH_GUIDANCE).toContain(
      'To create a file, use `*** Add File: <path>` with every line, blank lines included, starting with `+`. A plain command over 4,000 characters is refused, so write a long file this way.'
    )
    // Josh (2026-10-23): the whole description is under 60 percent of its old 1,811 characters.
    expect(description.length).toBeLessThan(1_100)
  })

  it.each([
    ['Dangerous mode', { bashAccessMode: 'dangerous' }, {}, true],
    ['Agent mode with approval cards', { bashAccessMode: 'agent', bashAgentApprovalCardsEnabled: true }, { toolApprovalMode: 'all' }, true],
    ['Agent mode without approval cards', { bashAccessMode: 'agent', bashAgentApprovalCardsEnabled: false }, { toolApprovalMode: 'none' }, false],
    ['a group chat', { bashAccessMode: 'agent', bashAgentApprovalCardsEnabled: true }, { toolApprovalMode: 'all', groupMemberRun: true }, false],
    ['Plan mode', { bashAccessMode: 'plan' }, {}, false]
  ])('tells the model a test after the patch runs only where it can: %s', async (_label, nativeTools, extra, runs) => {
    const root = await tempDir('batshit-patch-text-mode-')
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: root,
      providerSettings: {
        nativeTools: {
          bashEnabled: true, executionBackend: 'local', bashPolicyMode: 'workspace',
          fetchZipEnabled: false, dynamicMcpEnabled: false, webSearchEnabled: false, agentBrowserEnabled: false,
          ...nativeTools
        }
      },
      toolApprovalMode: 'none',
      ...extra
    } as any)
    const description: string = (tools as any).native_bash_execute.description
    expect(description).toContain(runs ? NATIVE_BASH_APPLY_PATCH_GUIDANCE : NATIVE_BASH_APPLY_PATCH_GUIDANCE_SEPARATE_CALL)
    expect(description.includes(NATIVE_BASH_AFTER_PATCH_GUIDANCE)).toBe(runs)
  })

  // SA-139 R5 removed the managed CLI helper and its copy of this text; the API lane's own Bash
  // tool keeps the separate-call text where a call after a patch can never run.
  it('the separate-call text is the same text, but tests in a separate call', () => {
    expect(NATIVE_BASH_APPLY_PATCH_GUIDANCE_SEPARATE_CALL).toMatch(/Run anything else, such as tests, in a separate call/)
    expect(NATIVE_BASH_APPLY_PATCH_GUIDANCE).toContain(NATIVE_BASH_AFTER_PATCH_GUIDANCE)
    expect(NATIVE_BASH_APPLY_PATCH_GUIDANCE_SEPARATE_CALL).toBe(
      NATIVE_BASH_APPLY_PATCH_GUIDANCE.replace(NATIVE_BASH_AFTER_PATCH_GUIDANCE, 'Run anything else, such as tests, in a separate call. ')
    )
  })
})
