import { afterEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { NATIVE_BASH_APPLY_PATCH_GUIDANCE, nativeToolService } from '../nativeTools'

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
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true })
})

async function tempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

const addNote = (file: string, text = 'hello') =>
  `apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: ${file}\n+${text}\n*** End Patch\nPATCH`

function run(command: string, workspaceRoot: string, accessMode: 'dangerous' | 'plan' = 'dangerous') {
  return nativeToolService.nativeBashExecute({
    command,
    backend: 'local',
    accessMode,
    requireApproval: false,
    workspaceRoot
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
  it('refuses a patch followed by another command: the patch is not applied and the command does not run', async () => {
    const root = await tempDir('batshit-patch-extra-')

    const result = await run(`${addNote('a.md')}\ntouch ran.txt`, root)

    expect(result).toMatchObject({ success: false, blocked: false, errorCode: 'INVALID_INPUT' })
    expect(result.reason).toMatch(/apply_patch must be the whole command/)
    expect(result.reason).toMatch(/Nothing ran\. Send the patch by itself, then run the rest in a separate call: `touch ran\.txt`/)
    expect(result.exitCode).toBeUndefined()
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
    expect(NATIVE_BASH_APPLY_PATCH_GUIDANCE).toMatch(/built into this tool.*no need to check for it/)
    expect(NATIVE_BASH_APPLY_PATCH_GUIDANCE).toMatch(/whole command, optionally after `cd <folder> &&`/)
    expect(NATIVE_BASH_APPLY_PATCH_GUIDANCE).toMatch(/Run anything else, such as tests, in a separate call/)
  })

  it('the managed CLI helper’s bash tool carries the same text: its commands take the same path', () => {
    const helper = readFileSync(path.resolve(__dirname, '../../../../../scripts/mode4-controls-mcp.cjs'), 'utf8')
    expect(helper).toContain(NATIVE_BASH_APPLY_PATCH_GUIDANCE)
  })
})
