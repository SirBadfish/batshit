import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { chmod, link, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { AnchoredProjectWriter, AnchoredWriteError, __setAnchoredWriterTestHook } from '../anchoredProjectWriter'
import { verifyFileReadProofSeal } from '../fileReadProofSeal'
import {
  __setTypedFileBeforeCommitForTests,
  __setTypedFileTestHook,
  agentTypedFileToolsValue,
  applyTypedEdits,
  buildTypedFileTools,
  formatTypedFileResultForModel,
  globalTypedFileToolsValue,
  resolveTypedFileToolsGrant,
  sliceTypedRead,
  TYPED_FILE_MAX_BYTES,
  TYPED_FILE_TOOLS_FACTORY_DEFAULT,
  TYPED_READ_MAX_CHARS,
  typedEditFile,
  typedFileNeverAllowEntry,
  typedReadFile,
  typedReadResultFromBytes,
  typedWriteFile,
  type TypedFileEnvironment
} from '../typedFileTools'

/**
 * SA-136 P2: the typed file tools on the real disk. The gates from the story's P2 list come
 * first (ambiguous and overlapping edits, all-or-nothing, outside the workspace, links, Plan mode,
 * the read's range and total, the kept mode, a race, the staged file removed), then the Stop and
 * the progress reports a stopped reply keeps (BL-1978), then the pure text rules.
 */

const pathRace = vi.hoisted(() => ({
  afterLstat: null as null | ((name: string) => void | Promise<void>),
  beforeOpen: null as null | ((name: string) => void | Promise<void>)
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const lstat = (async (file: any, ...rest: any[]) => {
    const info = await (actual.lstat as any)(file, ...rest)
    await pathRace.afterLstat?.(String(file))
    return info
  }) as typeof actual.lstat
  const open = (async (file: any, ...rest: any[]) => {
    await pathRace.beforeOpen?.(String(file))
    return (actual.open as any)(file, ...rest)
  }) as typeof actual.open
  return { ...actual, lstat, open, default: { ...actual, lstat, open } }
})

const cleanup: string[] = []

afterEach(async () => {
  __setAnchoredWriterTestHook(null)
  pathRace.afterLstat = null
  pathRace.beforeOpen = null
  for (const stage of ['afterResolve', 'afterRead', 'beforeStage', 'afterTempOpen', 'beforeCommit', 'afterCommit'] as const) __setTypedFileTestHook(stage, null)
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true })
})

async function workspace(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sa136-typed-')))
  cleanup.push(dir)
  return dir
}

function env(root: string, extra: Partial<TypedFileEnvironment> = {}): TypedFileEnvironment & { reports: Record<string, any>[] } {
  const reports: Record<string, any>[] = []
  return { workspaceRoot: root, cwd: root, accessMode: 'agent', commandBackend: 'local', onProgress: (facts) => reports.push(facts), reports, ...extra }
}

/** Every hidden staged file left in a folder. */
async function stagedFiles(folder: string): Promise<string[]> {
  return (await readdir(folder)).filter((name) => name.includes('.batshit-write-'))
}

describe('edit_file: all or nothing (SA-136 P2 gates)', () => {
  it('refuses the whole call when one oldText matches several places, and names the count', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.ts'), 'let x = 1\nlet x = 1\nlet y = 2\n')
    const result = await typedEditFile({ path: 'a.ts', edits: [{ oldText: 'let y = 2', newText: 'let y = 3' }, { oldText: 'let x = 1', newText: 'let x = 9' }] }, env(root))
    expect(result.success).toBe(false)
    expect(result.reason).toBe('edits[1].oldText matches 2 places in a.ts; it must match exactly once. Add nearby lines to make it unique. Nothing was written.')
    expect(result.typedFileEdit).toEqual({ v: 1, outcome: 'unapplied' })
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('let x = 1\nlet x = 1\nlet y = 2\n')
  })

  it('refuses overlapping edits, naming both, and writes nothing', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.ts'), 'alpha beta gamma\n')
    const result = await typedEditFile({ path: 'a.ts', edits: [{ oldText: 'beta gamma', newText: 'B G' }, { oldText: 'alpha beta', newText: 'A B' }] }, env(root))
    expect(result.reason).toBe('edits[0] and edits[1] change overlapping text in a.ts. Merge them into one edit. Nothing was written.')
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('alpha beta gamma\n')
  })

  it('leaves the file untouched when a later edit does not match (no partial apply)', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.ts'), 'one\ntwo\n')
    const result = await typedEditFile({ path: 'a.ts', edits: [{ oldText: 'one', newText: 'ONE' }, { oldText: 'three', newText: 'THREE' }] }, env(root))
    expect(result.reason).toBe('edits[1].oldText is not in a.ts. The file may have changed; read it again. Nothing was written.')
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('one\ntwo\n')
    expect(await stagedFiles(root)).toEqual([])
  })

  it('applies every edit against the original text, returns the diff, and reports committing then applied', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.ts'), 'a\nb\nc\nd\n')
    const call = env(root)
    const result = await typedEditFile({ path: 'a.ts', edits: [{ oldText: 'd', newText: 'D' }, { oldText: 'b\n', newText: 'B\nb2\n' }] }, call)
    expect(result.success).toBe(true)
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('a\nB\nb2\nc\nD\n')
    expect(result.typedFileEdit).toEqual({ v: 1, outcome: 'applied', editsApplied: 2, totalLines: 5, bytes: 11, lineEnding: 'lf' })
    expect(result.diff).toContain('+   2 | B')
    expect(call.reports.map((report) => report.typedFileEdit.outcome)).toEqual(['unknown', 'applied'])
    expect(call.reports[0].typedFileEdit.stage).toBe('committing')
    expect(call.reports[1]).toMatchObject({ tool: 'edit_file', path: 'a.ts', filePath: 'a.ts', diff: result.diff })
    expect(formatTypedFileResultForModel(result)).toBe('edit_file: a.ts: 2 edits applied; it has 5 lines now.')
  })

  it('keeps CRLF and a byte-order mark when the model sends LF text', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'w.txt'), '﻿one\r\ntwo\r\n')
    const result = await typedEditFile({ path: 'w.txt', edits: [{ oldText: 'one\ntwo', newText: 'one\nTWO' }] }, env(root))
    expect(result.success).toBe(true)
    expect(await readFile(path.join(root, 'w.txt'), 'utf8')).toBe('﻿one\r\nTWO\r\n')
  })

  it('refuses a file that does not exist, a binary file and a file over the size limit', async () => {
    const root = await workspace()
    expect((await typedEditFile({ path: 'none.ts', edits: [{ oldText: 'a', newText: 'b' }] }, env(root))).reason).toBe(
      'No file at none.ts; edit_file changes an existing file. To create it, use write_file. Nothing was written.'
    )
    await writeFile(path.join(root, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]))
    expect((await typedEditFile({ path: 'bin.dat', edits: [{ oldText: 'a', newText: 'b' }] }, env(root))).reason).toBe(
      'bin.dat is not UTF-8 text; edit_file changes text only. Nothing was written.'
    )
    await writeFile(path.join(root, 'big.log'), '')
    await truncate(path.join(root, 'big.log'), TYPED_FILE_MAX_BYTES + 1)
    expect((await typedEditFile({ path: 'big.log', edits: [{ oldText: 'a', newText: 'b' }] }, env(root))).reason).toBe(
      'big.log is 10,000,001 bytes; read_file and edit_file take files up to 10,000,000 bytes. Use Bash. Nothing was written.'
    )
  })
})

describe('the workspace, links and protected targets', () => {
  it('refuses a write outside the workspace before any write, through .. or an absolute path', async () => {
    const outer = await workspace()
    const root = path.join(outer, 'project')
    await mkdir(root)
    for (const target of ['../escape.txt', path.join(outer, 'escape.txt'), '../newdir/escape.txt']) {
      const result = await typedWriteFile({ path: target, content: 'x' }, env(root))
      expect(result.success).toBe(false)
      expect(result.blocked).toBe(true)
      expect(result.reason).toMatch(/is outside the workspace \(.*project\)\. Nothing was written\.$/)
    }
    expect((await readdir(outer)).sort()).toEqual(['project'])
    expect(await readdir(root)).toEqual([])
  })

  it('refuses a folder link inside the workspace that leads outside it', async () => {
    const outer = await workspace()
    const root = path.join(outer, 'project')
    await mkdir(root)
    await mkdir(path.join(outer, 'secret'))
    await symlink(path.join(outer, 'secret'), path.join(root, 'out'))
    const result = await typedWriteFile({ path: 'out/key.txt', content: 'x' }, env(root))
    expect(result.reason).toMatch(/^out\/key\.txt is outside the workspace/)
    expect(await readdir(path.join(outer, 'secret'))).toEqual([])
  })

  it('refuses a link at the file itself for all three tools and never touches what it points to', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'real.ts'), 'keep\n')
    await symlink(path.join(root, 'real.ts'), path.join(root, 'alias.ts'))
    const expected = 'alias.ts is a symbolic link; Batshit does not read or write through links. Use the path it points to.'
    expect((await typedReadFile({ path: 'alias.ts' }, env(root))).reason).toBe(`${expected} Nothing was read.`)
    expect((await typedWriteFile({ path: 'alias.ts', content: 'x' }, env(root))).reason).toBe(`${expected} Nothing was written.`)
    expect((await typedEditFile({ path: 'alias.ts', edits: [{ oldText: 'keep', newText: 'x' }] }, env(root))).reason).toBe(`${expected} Nothing was written.`)
    expect(await readFile(path.join(root, 'real.ts'), 'utf8')).toBe('keep\n')
  })

  it('refuses a protected target with the managed patch reason', async () => {
    const root = await workspace()
    const seen: string[] = []
    const call = env(root, { protectedWriteReason: (target) => (seen.push(target), 'Writing Batshit product source is blocked.') })
    const result = await typedWriteFile({ path: 'src/x.ts', content: 'x' }, call)
    expect(result.reason).toBe('Writing Batshit product source is blocked. Nothing was written.')
    expect(seen).toEqual([path.join(root, 'src', 'x.ts')])
    expect(await readdir(root)).toEqual([])
  })
})

describe('Plan mode', () => {
  it('refuses a write or an edit of a non-Markdown file and allows a Markdown one', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.ts'), 'x\n')
    const plan = env(root, { accessMode: 'plan' })
    expect((await typedWriteFile({ path: 'b.ts', content: 'x' }, plan)).reason).toBe(
      'Plan mode allows write_file and edit_file only on Markdown (.md) files. Blocked: b.ts. Nothing was written.'
    )
    expect((await typedEditFile({ path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] }, plan)).blocked).toBe(true)
    expect((await typedWriteFile({ path: 'notes/plan.md', content: '# Plan\n' }, plan)).success).toBe(true)
    expect(await readFile(path.join(root, 'notes', 'plan.md'), 'utf8')).toBe('# Plan\n')
    expect((await typedReadFile({ path: 'a.ts' }, plan)).success).toBe(true)
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('x\n')
  })
})

describe('write_file: one step, mode kept', () => {
  it('creates a file and its missing folders, then replaces it keeping its mode', async () => {
    const root = await workspace()
    const created = await typedWriteFile({ path: 'deep/er/a.sh', content: '#!/bin/sh\necho one\n' }, env(root))
    expect(created.typedFileWrite).toEqual({ v: 1, outcome: 'applied', created: true, totalLines: 2, bytes: 19, lineEnding: 'lf' })
    expect(formatTypedFileResultForModel(created)).toBe('write_file: wrote deep/er/a.sh (created; 2 lines, 19 bytes).')
    const file = path.join(root, 'deep', 'er', 'a.sh')
    await chmod(file, 0o751)
    const replaced = await typedWriteFile({ path: 'deep/er/a.sh', content: '#!/bin/sh\necho two\n' }, env(root))
    expect(replaced.typedFileWrite.created).toBe(false)
    expect((await stat(file)).mode & 0o777).toBe(0o751)
    expect(await readFile(file, 'utf8')).toBe('#!/bin/sh\necho two\n')
    expect(await stagedFiles(path.dirname(file))).toEqual([])
  })

  it('keeps an edited file executable', async () => {
    const root = await workspace()
    const file = path.join(root, 'run.sh')
    await writeFile(file, 'echo a\n')
    await chmod(file, 0o755)
    expect((await typedEditFile({ path: 'run.sh', edits: [{ oldText: 'a', newText: 'b' }] }, env(root))).success).toBe(true)
    expect((await stat(file)).mode & 0o777).toBe(0o755)
  })

  it('says a hard-linked file became a new file and its other name keeps the old text', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.txt'), 'old\n')
    await link(path.join(root, 'a.txt'), path.join(root, 'b.txt'))
    const result = await typedWriteFile({ path: 'a.txt', content: 'new\n' }, env(root))
    expect(formatTypedFileResultForModel(result)).toBe('write_file: wrote a.txt (replaced; 1 line, 4 bytes). It had 1 other hard link, which keeps the old text.')
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('old\n')
  })

  it('refuses content over 200,000 characters before anything', async () => {
    const root = await workspace()
    const result = await typedWriteFile({ path: 'big.txt', content: 'x'.repeat(200_001) }, env(root))
    expect(result.reason).toBe('content is 200,001 characters; the limit is 200,000 per call. Write the first part, then add the rest with edit_file. Nothing was written.')
    expect(await readdir(root)).toEqual([])
  })
})

describe('a file the app may not write (review of P2a)', () => {
  it('is refused for a write and an edit, as a managed patch fails there; the file is unchanged', async () => {
    const root = await workspace()
    const file = path.join(root, 'locked.txt')
    await writeFile(file, 'keep\n')
    await chmod(file, 0o444)
    const expected = 'locked.txt is read-only for Batshit; it does not replace a file it may not write. Nothing was written.'
    expect((await typedWriteFile({ path: 'locked.txt', content: 'x' }, env(root))).reason).toBe(expected)
    expect((await typedEditFile({ path: 'locked.txt', edits: [{ oldText: 'keep', newText: 'x' }] }, env(root))).reason).toBe(expected)
    expect(await readFile(file, 'utf8')).toBe('keep\n')
    await chmod(file, 0o644)
  })
})

describe('an edit with a long diff (review of P2a)', () => {
  it('applies in full and gives the model only the confirmation while keeping the full diff', async () => {
    const root = await workspace()
    const oldText = Array.from({ length: 2_000 }, (_, i) => `old line ${i}`).join('\n')
    const newText = Array.from({ length: 2_000 }, (_, i) => `new line ${i}`).join('\n')
    await writeFile(path.join(root, 'big.txt'), `${oldText}\n`)
    const result = await typedEditFile({ path: 'big.txt', edits: [{ oldText, newText }] }, env(root))
    expect(result.success).toBe(true)
    expect(await readFile(path.join(root, 'big.txt'), 'utf8')).toBe(`${newText}\n`)
    const text = formatTypedFileResultForModel(result)
    expect(text).toBe('edit_file: big.txt: 1 edit applied; it has 2,000 lines now.')
    expect(result.diff.length).toBeGreaterThan(20_000)
    expect(result.diff).toContain('+ 2000 | new line 1999')
  })
})

describe('races and the staged file (SA-136 D6)', () => {
  it('refuses when another program changed the file after this call read it, and removes the staged file', async () => {
    const root = await workspace()
    const file = path.join(root, 'a.ts')
    await writeFile(file, 'one\n')
    __setTypedFileBeforeCommitForTests(async () => {
      await writeFile(file, 'someone else\n')
    })
    const call = env(root)
    const result = await typedEditFile({ path: 'a.ts', edits: [{ oldText: 'one', newText: 'mine' }] }, call)
    expect(result.errorCode).toBe('FILE_CHANGED')
    expect(result.reason).toBe('a.ts changed on disk after this call read it (another program or another call wrote it). Read it again. Nothing was written.')
    expect(await readFile(file, 'utf8')).toBe('someone else\n')
    expect(await stagedFiles(root)).toEqual([])
    expect(call.reports).toEqual([])
  })

  it('refuses when a file appeared at a new path meanwhile, and removes the folders it made', async () => {
    const root = await workspace()
    __setTypedFileBeforeCommitForTests(async () => {
      await writeFile(path.join(root, 'new', 'a.ts'), 'theirs\n')
    })
    const result = await typedWriteFile({ path: 'new/a.ts', content: 'mine\n' }, env(root))
    expect(result.reason).toBe('A file appeared at new/a.ts while this call ran. Nothing was written.')
    expect(await readFile(path.join(root, 'new', 'a.ts'), 'utf8')).toBe('theirs\n')
    expect(await stagedFiles(path.join(root, 'new'))).toEqual([])
  })

  it('refuses when the folder was replaced between staging and the rename', async () => {
    const root = await workspace()
    await mkdir(path.join(root, 'dir'))
    await writeFile(path.join(root, 'dir', 'a.ts'), 'one\n')
    __setTypedFileBeforeCommitForTests(async () => {
      await rename(path.join(root, 'dir'), path.join(root, 'moved'))
      await mkdir(path.join(root, 'dir'))
    })
    const result = await typedEditFile({ path: 'dir/a.ts', edits: [{ oldText: 'one', newText: 'two' }] }, env(root))
    expect(result.reason).toBe('A folder in dir/a.ts was replaced while this call ran. Nothing was written.')
    expect(await readdir(path.join(root, 'dir'))).toEqual([])
    expect(await readFile(path.join(root, 'moved', 'a.ts'), 'utf8')).toBe('one\n')
  })
})

describe('a folder swapped for a link to outside the workspace (the managed patch race)', () => {
  it('is caught right before the rename for a write and an edit: nothing lands outside', async () => {
    const outer = await workspace()
    const root = path.join(outer, 'project')
    const outside = path.join(outer, 'outside')
    await mkdir(path.join(root, 'dir'), { recursive: true })
    await mkdir(outside)
    await writeFile(path.join(root, 'dir', 'a.txt'), 'old\n')
    await writeFile(path.join(outside, 'a.txt'), 'old\n')
    const swap = async () => {
      await rename(path.join(root, 'dir'), path.join(root, 'dir-moved'))
      await symlink(outside, path.join(root, 'dir'))
    }
    __setTypedFileBeforeCommitForTests(swap)
    const edit = await typedEditFile({ path: 'dir/a.txt', edits: [{ oldText: 'old', newText: 'new' }] }, env(root))
    expect(edit.reason).toMatch(/^A folder in dir\/a\.txt was replaced while this call ran\. Nothing was written\. Batshit could not verify cleanup of dir\/\.a\.txt\.batshit-write-[a-f0-9]{8} \(anchored write refused \(parent:ELOOP\); removal is unverified\)\.$/)
    expect(await readFile(path.join(outside, 'a.txt'), 'utf8')).toBe('old\n')
    expect(await stagedFiles(outside)).toEqual([])

    await rm(path.join(root, 'dir'))
    await rename(path.join(root, 'dir-moved'), path.join(root, 'dir'))
    __setTypedFileBeforeCommitForTests(swap)
    const write = await typedWriteFile({ path: 'dir/b.txt', content: 'x' }, env(root))
    expect(write.errorCode).toBe('FILE_CHANGED')
    expect(await readdir(outside)).toEqual(['a.txt'])
  })
})

describe('a folder swapped for a link and back (an ABA race against the commit-time checks)', () => {
  async function layout() {
    const outer = await workspace()
    const root = path.join(outer, 'project')
    const outside = path.join(outer, 'outside')
    await mkdir(path.join(root, 'dir'), { recursive: true })
    await mkdir(outside)
    await writeFile(path.join(root, 'dir', 'a.txt'), 'inside\n')
    await writeFile(path.join(outside, 'a.txt'), 'SECRET\n')
    const toOutside = async () => {
      await rename(path.join(root, 'dir'), path.join(root, 'dir-real'))
      await symlink(outside, path.join(root, 'dir'))
    }
    let swapped = false
    const originalToOutside = toOutside
    const swap = async () => { await originalToOutside(); swapped = true }
    const back = async () => {
      if (!swapped) return
      swapped = false
      await rm(path.join(root, 'dir'))
      await rename(path.join(root, 'dir-real'), path.join(root, 'dir'))
    }
    return { root, outside, toOutside: swap, back }
  }

  it('a read that opened the outside file is refused when the path no longer leads to it', async () => {
    const { root, toOutside, back } = await layout()
    __setTypedFileTestHook('afterResolve', toOutside)
    __setTypedFileTestHook('afterRead', back)
    const result = await typedReadFile({ path: 'dir/a.txt' }, env(root))
    await back()
    expect(result.success).toBe(false)
    expect(result.reason).toBe('A folder in dir/a.txt was replaced while this call ran. Nothing was read.')
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('an edit that read the outside file is refused the same way, and writes nothing anywhere', async () => {
    const { root, outside, toOutside, back } = await layout()
    __setTypedFileTestHook('afterResolve', toOutside)
    __setTypedFileTestHook('afterRead', back)
    const result = await typedEditFile({ path: 'dir/a.txt', edits: [{ oldText: 'SECRET', newText: 'X' }] }, env(root))
    await back()
    expect(result.reason).toBe('A folder in dir/a.txt was replaced while this call ran. Nothing was written.')
    expect(await readFile(path.join(outside, 'a.txt'), 'utf8')).toBe('SECRET\n')
    expect(await readFile(path.join(root, 'dir', 'a.txt'), 'utf8')).toBe('inside\n')
  })

  it('a staged file cannot be created through the swapped folder: no hidden file is left outside', async () => {
    const { root, outside, toOutside, back } = await layout()
    // The swap comes after the folder was checked and before the staged file is created in it.
    __setTypedFileTestHook('beforeStage', toOutside)
    __setTypedFileTestHook('afterTempOpen', back)
    const result = await typedWriteFile({ path: 'dir/new.txt', content: 'PAYLOAD' }, env(root))
    await back()
    expect(result.reason).toBe('A folder in dir/new.txt was replaced while this call ran. Nothing was written.')
    const leftOutside = (await readdir(outside)).filter((name) => name !== 'a.txt')
    expect(leftOutside).toHaveLength(0)
    expect(await readdir(path.join(root, 'dir'))).toEqual(['a.txt'])
  })
})

describe('the staged file itself replaced before the rename', () => {
  it('is refused: only the text this call staged is ever renamed into place', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.ts'), 'old\n')
    __setTypedFileTestHook('beforeCommit', async () => {
      const [name] = await stagedFiles(root)
      await rm(path.join(root, name))
      await writeFile(path.join(root, name), 'not what the model sent\n')
    })
    const result = await typedEditFile({ path: 'a.ts', edits: [{ oldText: 'old', newText: 'new' }] }, env(root))
    expect(result.reason).toMatch(/^A folder in a\.ts was replaced while this call ran\. Nothing was written\./)
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('old\n')
  })
})

describe('another folder moved into the same path, holding a hard link to the staged file', () => {
  it('is refused: the rename happens only in the folder the file was staged in', async () => {
    const root = await workspace()
    await mkdir(path.join(root, 'dir'))
    await mkdir(path.join(root, 'other'))
    __setTypedFileTestHook('beforeCommit', async () => {
      const [name] = await stagedFiles(path.join(root, 'dir'))
      await link(path.join(root, 'dir', name), path.join(root, 'other', name))
      await rename(path.join(root, 'dir'), path.join(root, 'dir-was'))
      await rename(path.join(root, 'other'), path.join(root, 'dir'))
    })
    const result = await typedWriteFile({ path: 'dir/new.txt', content: 'x' }, env(root))
    expect(result.reason).toMatch(/^A folder in dir\/new\.txt was replaced while this call ran\. Nothing was written\./)
    expect((await readdir(path.join(root, 'dir'))).filter((name) => !name.includes('.batshit-write-'))).toEqual([])
  })
})

describe('Stop (SA-136 D6, BL-1978)', () => {
  it('a Stop before the call writes nothing and reports nothing', async () => {
    const root = await workspace()
    const stop = new AbortController()
    stop.abort()
    const call = env(root, { abortSignal: stop.signal })
    const result = await typedWriteFile({ path: 'a/b.ts', content: 'x' }, call)
    expect(result).toMatchObject({ success: false, stopped: true, errorCode: 'STOPPED', reason: 'Stopped before anything was written. Nothing was written.' })
    expect(await readdir(root)).toEqual([])
    expect(call.reports).toEqual([])
  })

  it('a Stop while the text is staged is checked right before the rename: nothing written, staged file and folders removed', async () => {
    const root = await workspace()
    const stop = new AbortController()
    __setTypedFileBeforeCommitForTests(() => stop.abort())
    const call = env(root, { abortSignal: stop.signal })
    const result = await typedWriteFile({ path: 'a/b.ts', content: 'x' }, call)
    expect(result).toMatchObject({ success: false, stopped: true, typedFileWrite: { v: 1, outcome: 'unapplied' } })
    expect(await readdir(root)).toEqual([])
    expect(call.reports).toEqual([])
  })

  it('a Stop after the rename leaves the call applied, with the applied report', async () => {
    const root = await workspace()
    const stop = new AbortController()
    const call = env(root, { abortSignal: stop.signal })
    call.onProgress = (facts) => {
      call.reports.push(facts)
      stop.abort()
    }
    const result = await typedWriteFile({ path: 'a.ts', content: 'x\n' }, call)
    expect(result.success).toBe(true)
    expect(call.reports.at(-1)).toMatchObject({ typedFileWrite: { outcome: 'applied', created: true } })
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('x\n')
  })
})

describe('read_file', () => {
  it('reads a whole file and says the lines shown and the total', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.ts'), 'one\ntwo\nthree\n')
    const result = await typedReadFile({ path: 'a.ts' }, env(root))
    expect(result).toMatchObject({ success: true, filePath: 'a.ts', content: 'one\ntwo\nthree\n', lineCount: 3 })
    expect(result.typedFileRead).toEqual({ v: 1, startLine: 1, endLine: 3, totalLines: 3, whole: true, truncated: false, empty: false, bytes: 14, lineEnding: 'lf' })
    expect(formatTypedFileResultForModel(result)).toBe('read_file: a.ts (lines 1–3 of 3)\none\ntwo\nthree\n')
  })

  it('reads a range and reports the total; a range past the end shows no lines', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.ts'), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'))
    const range = await typedReadFile({ path: 'a.ts', offset: 4, limit: 3 }, env(root))
    expect(range.content).toBe('line 4\nline 5\nline 6\n')
    expect(range.typedFileRead).toMatchObject({ startLine: 4, endLine: 6, totalLines: 10, whole: false, truncated: false })
    expect(formatTypedFileResultForModel(range)).toMatch(/^read_file: a\.ts \(lines 4–6 of 10\)\n/)
    const past = await typedReadFile({ path: 'a.ts', offset: 20 }, env(root))
    expect(past.content).toBe('')
    expect(formatTypedFileResultForModel(past)).toBe('read_file: a.ts (no lines: the file has 10 lines)\n')
    const asksForAll = await typedReadFile({ path: 'a.ts', offset: 1, limit: 50 }, env(root))
    expect(asksForAll.typedFileRead.whole).toBe(true)
  })

  it('cuts a large file at whole lines under the cap and says where to read on', async () => {
    const root = await workspace()
    const line = `${'x'.repeat(99)}\n`
    await writeFile(path.join(root, 'big.txt'), line.repeat(1_000))
    const result = await typedReadFile({ path: 'big.txt' }, env(root))
    expect(result.content.length).toBe(TYPED_READ_MAX_CHARS)
    expect(result.typedFileRead).toMatchObject({ startLine: 1, endLine: 900, totalLines: 1_000, whole: false, truncated: true })
    expect(formatTypedFileResultForModel(result).split('\n')[0]).toBe(
      'read_file: big.txt (lines 1–900 of 1,000; cut at 90,000 characters, read on with offset=901)'
    )
  })

  it('refuses binary text, a missing file and a folder; an empty file is whole', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'bin'), Buffer.from([0xff, 0xfe, 0x00]))
    expect((await typedReadFile({ path: 'bin' }, env(root))).reason).toBe('bin is not UTF-8 text; read_file reads text only. Nothing was read.')
    expect((await typedReadFile({ path: 'none' }, env(root))).reason).toBe('No file at none. Nothing was read.')
    await mkdir(path.join(root, 'src'))
    expect((await typedReadFile({ path: 'src' }, env(root))).reason).toBe('src is a folder, not a file. Nothing was read.')
    await writeFile(path.join(root, 'empty'), '')
    const empty = await typedReadFile({ path: 'empty' }, env(root))
    expect(empty.typedFileRead).toMatchObject({ empty: true, whole: true, totalLines: 0 })
    expect(formatTypedFileResultForModel(empty)).toBe('read_file: empty (empty file)\n')
  })

  it('reads a file outside the project folder only inside the workspace', async () => {
    const outer = await workspace()
    await writeFile(path.join(outer, 'secret'), 'no\n')
    const root = path.join(outer, 'project')
    await mkdir(root)
    expect((await typedReadFile({ path: '../secret' }, env(root))).reason).toBe(
      `${path.join(outer, 'secret')} is outside the workspace (${root}). Nothing was read.`
    )
  })
})

describe('Never Allow (P1 settle: the entry names the tool)', () => {
  it('reads a plain entry by its first word and a regex entry against the bare names', () => {
    for (const entry of ['apply_patch', 'apply_patch*', 'apply_patch *.env', 'apply*', '*', 're:^apply', 'write_file', 'EDIT_FILE']) {
      expect(typedFileNeverAllowEntry([entry], 'edit_file'), entry).not.toBeNull()
      expect(typedFileNeverAllowEntry([entry], 'write_file'), entry).not.toBeNull()
    }
    for (const entry of ['rm*', 'cat*', 're:\\.env', 'read_file', 'patch', '']) {
      expect(typedFileNeverAllowEntry([entry], 'write_file'), entry).toBeNull()
    }
    expect(typedFileNeverAllowEntry(['read_file'], 'read_file')).toEqual({ entry: 'read_file', name: 'read_file' })
    expect(typedFileNeverAllowEntry(['apply_patch*', 'cat*'], 'read_file')).toBeNull()
    expect(typedFileNeverAllowEntry(['/^write/g'], 'write_file')).toEqual({ entry: '/^write/g', name: 'write_file' })
  })

  it('refuses the call with the entry it matched, before any write', async () => {
    const root = await workspace()
    const result = await typedWriteFile({ path: 'a.ts', content: 'x' }, env(root, { neverAllowList: ['rm*', 'apply_patch*'] }))
    expect(result).toMatchObject({ blocked: true, errorCode: 'POLICY_BLOCKED' })
    expect(result.reason).toBe('Blocked by your bash Never Allow list: the entry "apply_patch*" names apply_patch, which also covers write_file and edit_file. Nothing was written.')
    expect(await readdir(root)).toEqual([])
    await writeFile(path.join(root, 'r.ts'), 'x\n')
    expect((await typedReadFile({ path: 'r.ts' }, env(root, { neverAllowList: ['read_file*'] }))).reason).toBe(
      'Blocked by your bash Never Allow list: the entry "read_file*" names read_file. Nothing was read.'
    )
  })
})

describe('the AI SDK tools', () => {
  it('keeps the other-hard-link notice in a concise successful edit reply', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.txt'), 'old\n')
    await link(path.join(root, 'a.txt'), path.join(root, 'other.txt'))
    const tools = buildTypedFileTools({ accessMode: 'agent', resolveEnvironment: async () => env(root) })
    const output = await tools.edit_file.execute({ path: 'a.txt', edits: [{ oldText: 'old', newText: 'new' }] }, { toolCallId: 'edit-links', messages: [] })
    expect(await tools.edit_file.toModelOutput({ output })).toEqual({
      type: 'text', value: 'edit_file: a.txt: 1 edit applied; it has 1 lines now. It had 1 other hard link, which keeps the old text.'
    })
    expect(output.diff).toContain('+   1 | new')
    expect(await readFile(path.join(root, 'other.txt'), 'utf8')).toBe('old\n')
  })

  it.each([
    { outcome: 'unapplied', reason: 'No match. Nothing was written.' },
    { outcome: 'unapplied', stopped: true, reason: 'Stopped before the edit. Nothing was written.' },
    { outcome: 'unknown', stopped: true, reason: 'Stopped while committing; the outcome is unknown.' },
    { outcome: 'applied', stopped: true, reason: 'The edit applied, but the call did not return.' },
    { outcome: 'unknown', reason: undefined }
  ])('preserves the failure reply for $outcome, stopped=$stopped, reason=$reason', async ({ outcome, stopped, reason }) => {
    const tools = buildTypedFileTools({ accessMode: 'agent', resolveEnvironment: async () => { throw new Error('formatting must not execute a tool') } })
    const output = { tool: 'edit_file', path: 'a.txt', success: false, stopped, reason, diff: 'not a success receipt', typedFileEdit: { v: 1, outcome, editsApplied: 1 } }
    expect(await tools.edit_file.toModelOutput({ output })).toEqual({ type: 'text', value: `edit_file: ${reason ?? 'the call failed.'}` })
  })

  it('runs each call in its own environment, adds the Plan sentence, and gives the model lean text', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.md'), 'hello\n')
    const plan = buildTypedFileTools({ accessMode: 'plan', resolveEnvironment: async () => env(root, { accessMode: 'plan' }) })
    expect(plan.write_file.description).toMatch(/Plan mode: only \.md files\.$/)
    expect(plan.read_file.description).not.toMatch(/Plan mode/)
    const output = await plan.read_file.execute({ path: 'a.md' }, { toolCallId: 't1', messages: [] })
    expect(await plan.read_file.toModelOutput({ output })).toEqual({ type: 'text', value: 'read_file: a.md (lines 1–1 of 1)\nhello\n' })
    const blocked = buildTypedFileTools({ accessMode: 'agent', resolveEnvironment: async () => ({ blocked: true, reason: 'No active project is selected.' }) })
    expect(await blocked.edit_file.execute({ path: 'a.md', edits: [{ oldText: 'a', newText: 'b' }] }, { toolCallId: 't2', messages: [] })).toMatchObject({
      success: false,
      blocked: true,
      reason: 'No active project is selected. Nothing was written.',
      typedFileEdit: { v: 1, outcome: 'unapplied' }
    })
  })
})

describe('pure rules', () => {
  it('slices lines as countTextLines counts them, CR and CRLF included', () => {
    expect(sliceTypedRead('a\r\nb\rc', 2, 1)).toMatchObject({ content: 'b\r', startLine: 2, endLine: 2, totalLines: 3 })
    expect(sliceTypedRead('a\nb', undefined, undefined)).toMatchObject({ content: 'a\nb', totalLines: 2, truncated: false })
    expect(sliceTypedRead('', 1, 1)).toMatchObject({ empty: true, totalLines: 0 })
    expect(sliceTypedRead(`${'y'.repeat(50)}\nz\n`, 1, undefined, 20)).toMatchObject({ content: 'y'.repeat(20), partialLine: true, truncated: true, endLine: 1 })
  })

  it('counts overlapping matches, allows touching edits, and refuses empty and no-op edits', () => {
    expect(applyTypedEdits('aaa', [{ oldText: 'aa', newText: 'b' }], 'f')).toEqual({ ok: false, reason: 'edits[0].oldText matches 2 places in f; it must match exactly once. Add nearby lines to make it unique. Nothing was written.' })
    expect(applyTypedEdits('abcd', [{ oldText: 'cd', newText: 'CD' }, { oldText: 'ab', newText: 'AB' }], 'f')).toEqual({ ok: true, text: 'ABCD' })
    expect(applyTypedEdits('abc', [{ oldText: '', newText: 'x' }], 'f')).toMatchObject({ ok: false, reason: expect.stringMatching(/^edits\[0\]\.oldText is empty\. To create or replace a whole file, use write_file\./) })
    expect(applyTypedEdits('abc', [{ oldText: 'b', newText: 'b' }], 'f')).toMatchObject({ ok: false, reason: expect.stringMatching(/changes nothing/) })
    expect(applyTypedEdits('a\r\nb\nc', [{ oldText: 'b\nc', newText: 'B\nC' }], 'f')).toEqual({ ok: true, text: 'a\r\nB\nC' })
  })

  it('resolves the grant: agent, then global, then the factory value; Bash stays the caller’s upper bound', () => {
    expect(TYPED_FILE_TOOLS_FACTORY_DEFAULT).toBe(false)
    expect(resolveTypedFileToolsGrant(null, null)).toBe(false)
    expect(resolveTypedFileToolsGrant(null, true)).toBe(true)
    expect(resolveTypedFileToolsGrant(false, true)).toBe(false)
    expect(resolveTypedFileToolsGrant(true, false)).toBe(true)
    expect(agentTypedFileToolsValue({ nativeTools: { typedFileToolsEnabled: null } })).toBeNull()
    expect(agentTypedFileToolsValue({ nativeTools: { typedFileToolsEnabled: false } })).toBe(false)
    expect(agentTypedFileToolsValue({ typedFileToolsEnabled: true })).toBeNull()
    expect(agentTypedFileToolsValue({ batshitNativeTools: { typedFileToolsEnabled: 'true' } })).toBe(true)
    expect(globalTypedFileToolsValue({ global_tool_grid_settings: { typed_file_tools: true } })).toBe(true)
    expect(globalTypedFileToolsValue({ global_tool_grid_settings: {} })).toBeNull()
    expect(globalTypedFileToolsValue(null)).toBeNull()
  })
})

describe('typedReadResultFromBytes: the read result without the file (for SA-137 refreshed typed copies)', () => {
  it('equals what read_file returned (apart from its own proof), and so does its model text', async () => {
    const root = await workspace()
    const files: Record<string, string> = {
      'plain.ts': 'a\nb\nc\n',
      'crlf.txt': 'one\r\ntwo\r\nthree',
      'empty.txt': '',
      'long.txt': Array.from({ length: 3_000 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`).join('\n') + '\n',
      'wide.txt': 'y'.repeat(TYPED_READ_MAX_CHARS + 50) + '\nshort\n',
      'bom.txt': '\ufeffbom first\nsecond\n'
    }
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text)
    const owner = { userId: 'u', agentId: 'a', sessionId: 's', messageId: 'm', toolCallId: 'call_helper' }
    const inputs = [
      { path: 'plain.ts' }, { path: 'plain.ts', offset: 2 }, { path: 'plain.ts', offset: 2, limit: 1 }, { path: 'plain.ts', offset: 9 },
      { path: 'crlf.txt' }, { path: 'empty.txt' }, { path: 'long.txt' }, { path: 'long.txt', offset: 100, limit: 20 },
      { path: 'wide.txt' }, { path: 'wide.txt', offset: 2 }, { path: 'bom.txt' }
    ]
    for (const input of inputs) {
      const returned = (await typedReadFile(input, env(root, { readProofOwner: owner }))) as Record<string, any>
      expect(returned.success, input.path).toBe(true)
      const { fileReadProof: _proof, ...withoutProof } = returned
      const rebuilt = typedReadResultFromBytes(input, returned.filePath, await readFile(path.join(root, input.path)))
      expect(rebuilt, JSON.stringify(input)).toEqual(withoutProof)
      expect(formatTypedFileResultForModel(rebuilt as any)).toBe(formatTypedFileResultForModel(returned as any))
    }
  })

  it('builds the exact result for a known file and range', () => {
    expect(typedReadResultFromBytes({ path: './src/plain.ts', offset: 2 }, 'src/plain.ts', Buffer.from('a\nb\nc\n'))).toEqual({
      success: true,
      tool: 'read_file',
      path: './src/plain.ts',
      filePath: 'src/plain.ts',
      content: 'b\nc\n',
      lineCount: 2,
      typedFileRead: { v: 1, startLine: 2, endLine: 3, totalLines: 3, whole: false, truncated: false, empty: false, bytes: 6, lineEnding: 'lf' }
    })
  })

  it('returns null for bytes read_file refuses: a NUL byte, invalid UTF-8, over the size limit', () => {
    expect(typedReadResultFromBytes({ path: 'nul.txt' }, 'nul.txt', Buffer.from('a\u0000b\n'))).toBeNull()
    expect(typedReadResultFromBytes({ path: 'bad.txt' }, 'bad.txt', Buffer.from([0x61, 0xff, 0xfe, 0x0a]))).toBeNull()
    expect(typedReadResultFromBytes({ path: 'big.txt' }, 'big.txt', Buffer.alloc(TYPED_FILE_MAX_BYTES + 1, 0x61))).toBeNull()
    expect(typedReadResultFromBytes({ path: 'max.txt' }, 'max.txt', Buffer.alloc(TYPED_FILE_MAX_BYTES, 0x61))).not.toBeNull()
  })
})

describe('anchored typed custody (SA-136 P2c)', () => {
  async function layout() {
    const outer = await workspace()
    const root = path.join(outer, 'project')
    const outside = path.join(outer, 'outside')
    await mkdir(path.join(root, 'dir'), { recursive: true })
    await mkdir(outside)
    await writeFile(path.join(root, 'dir', 'a.txt'), 'inside\n')
    await writeFile(path.join(outside, 'a.txt'), 'SECRET\n')
    let swaps = 0
    let swapped = false
    const swap = async () => {
      swaps += 1
      await rename(path.join(root, 'dir'), path.join(root, 'dir-held'))
      await symlink(outside, path.join(root, 'dir'))
      swapped = true
    }
    const back = async () => {
      if (!swapped) return
      await rm(path.join(root, 'dir'))
      await rename(path.join(root, 'dir-held'), path.join(root, 'dir'))
      swapped = false
    }
    return { root, outside, swap, back, swaps: () => swaps }
  }

  it('discriminator: the old path checks leak outside bytes when the final file stat precedes the second swap', async () => {
    const fixture = await layout()
    let finalStatReached = false
    __setTypedFileTestHook('afterResolve', fixture.swap)
    __setTypedFileTestHook('afterRead', () => {
      // Old custody: the opened file and atPath stat are both outside. Restore the folder only
      // after that stat returns, before the separate parent realpath check. New custody refuses
      // the link before read; the initial attack still runs, independently of any anchor hook.
      pathRace.afterLstat = async (name) => {
        if (name !== path.join(fixture.root, 'dir', 'a.txt')) return
        finalStatReached = true
        pathRace.afterLstat = null
        await fixture.back()
      }
    })
    const result = await typedReadFile({ path: 'dir/a.txt' }, env(fixture.root))
    await fixture.back()
    expect(fixture.swaps()).toBe(1)
    expect(result.success, `final path-stat attack reached: ${finalStatReached}`).toBe(false)
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(await readFile(path.join(fixture.root, 'dir', 'a.txt'), 'utf8')).toBe('inside\n')
  })

  it('uses the real helper for the read and refuses a folder swapped just before its request', async () => {
    const fixture = await layout()
    let readRequests = 0
    __setAnchoredWriterTestHook(async (op) => {
      if (op !== 'read') return
      readRequests += 1
      await fixture.swap()
    })
    const result = await typedReadFile({ path: 'dir/a.txt' }, env(fixture.root))
    await fixture.back()
    expect(readRequests).toBe(1)
    expect(result).toMatchObject({ success: false, errorCode: 'IO_ERROR' })
    expect(result.reason).toContain('anchored write refused (helper:confined-open)')
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('uses the real helper for staging and creates no outside temporary file', async () => {
    const fixture = await layout()
    let stages = 0
    __setAnchoredWriterTestHook(async (op) => {
      if (op !== 'write') return
      stages += 1
      await fixture.swap()
    })
    const result = await typedWriteFile({ path: 'dir/new.txt', content: 'PAYLOAD' }, env(fixture.root))
    await fixture.back()
    expect(stages).toBe(1)
    expect(result).toMatchObject({ success: false, typedFileWrite: { outcome: 'unapplied' } })
    expect(await readdir(fixture.outside)).toEqual(['a.txt'])
    expect(await readdir(path.join(fixture.root, 'dir'))).toEqual(['a.txt'])
  })

  it('confines the final rename even when the folder changes after every final check', async () => {
    const fixture = await layout()
    let commits = 0
    __setAnchoredWriterTestHook(async (op) => {
      if (op !== 'rename') return
      commits += 1
      await fixture.swap()
    })
    const result = await typedWriteFile({ path: 'dir/a.txt', content: 'PAYLOAD' }, env(fixture.root))
    await fixture.back()
    expect(commits).toBe(1)
    expect(result).toMatchObject({ success: false, typedFileWrite: { outcome: 'unapplied' } })
    expect(await readFile(path.join(fixture.outside, 'a.txt'), 'utf8')).toBe('SECRET\n')
    expect(await readdir(fixture.outside)).toEqual(['a.txt'])
    expect(result.reason).toContain('cleanup')
  })

  it('resolves an inside folder alias and a workspace alias before admission', async () => {
    const outer = await workspace()
    const root = path.join(outer, 'real')
    const alias = path.join(outer, 'alias')
    await mkdir(path.join(root, 'real-dir'), { recursive: true })
    await symlink(root, alias)
    await symlink(path.join(root, 'real-dir'), path.join(root, 'folder-alias'))
    expect((await typedWriteFile({ path: 'folder-alias/a.txt', content: 'one' }, env(alias))).success).toBe(true)
    expect((await typedReadFile({ path: 'folder-alias/a.txt' }, env(alias))).content).toBe('one')
    expect(await readFile(path.join(root, 'real-dir', 'a.txt'), 'utf8')).toBe('one')
  })

  it('refuses a root replaced between planning and READY before any actual file request', async () => {
    const outer = await workspace()
    const root = path.join(outer, 'root')
    await mkdir(root)
    await writeFile(path.join(root, 'a.txt'), 'original')
    __setTypedFileTestHook('afterResolve', async () => {
      await rename(root, path.join(outer, 'held'))
      await mkdir(root)
      await writeFile(path.join(root, 'a.txt'), 'foreign')
    })
    let requests = 0
    __setAnchoredWriterTestHook(() => { requests += 1 })
    const result = await typedWriteFile({ path: 'a.txt', content: 'new' }, env(root))
    expect(result).toMatchObject({ success: false, errorCode: 'FILE_CHANGED', typedFileWrite: { outcome: 'unapplied' } })
    expect(requests).toBe(0)
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('foreign')
    expect(await readFile(path.join(outer, 'held', 'a.txt'), 'utf8')).toBe('original')
  })

  it('continues on the admitted directory object after its root path is moved', async () => {
    const outer = await workspace()
    const root = path.join(outer, 'root')
    const held = path.join(outer, 'held')
    await mkdir(root)
    await writeFile(path.join(root, 'a.txt'), 'original')
    let admitted: string | null = null
    __setAnchoredWriterTestHook(async (_op, _paths, _data, writer) => {
      if (admitted) return
      admitted = writer.rootIdentity
      await rename(root, held)
      await mkdir(root)
      await writeFile(path.join(root, 'a.txt'), 'foreign')
    })
    const result = await typedReadFile({ path: 'a.txt' }, env(root, {
      commandBackend: 'local',
      readProofOwner: { userId: 'user', agentId: 'agent', sessionId: 'session', messageId: 'message', toolCallId: 'read' }
    }))
    expect(result).toMatchObject({ success: true, content: 'original', fileReadProof: { rootIdentity: admitted } })
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('foreign')
  })

  it.each([false, true])('proves an anchored Apple read with its actual backend and live-read setting %s', async (liveReadsOn) => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.txt'), 'one')
    let admitted: string | null = null
    __setAnchoredWriterTestHook((_op, _paths, _data, writer) => { admitted = writer.rootIdentity })
    const result = await typedReadFile({ path: 'a.txt' }, env(root, {
      commandBackend: 'apple_container',
      liveReadsOn,
      readProofOwner: { userId: 'user', agentId: 'agent', sessionId: 'session', messageId: 'message', toolCallId: 'read' }
    }))
    expect(result).toMatchObject({ success: true, content: 'one', fileReadProof: {
      version: 1,
      backend: 'apple_container',
      liveReadsOn,
      rootIdentity: admitted,
      workspaceRoot: root,
      cwd: root,
      reads: [{ part: null, file: 'a.txt', locator: 'a.txt', view: { kind: 'typed', startLine: 1, endLine: null } }]
    } })
    expect(result.fileReadProof.backend).not.toBe('local')
    expect(verifyFileReadProofSeal(result.fileReadProof)).toBe(true)
  })

  // SA-137 Round 2: a Docker Sandbox read records its own backend (it mounts the host workspace).
  it.each([false, true])('records Docker origin and actual read-time setting %s on a proven read', async (liveReadsOn) => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.txt'), 'one')
    const result = await typedReadFile({ path: 'a.txt' }, env(root, {
      commandBackend: 'docker_sandbox',
      liveReadsOn,
      readProofOwner: { userId: 'user', agentId: 'agent', sessionId: 'session', messageId: 'message', toolCallId: 'read' }
    }))
    expect(result).toMatchObject({ success: true, content: 'one', fileReadProof: { backend: 'docker_sandbox', liveReadsOn } })
    expect(verifyFileReadProofSeal(result.fileReadProof)).toBe(true)
  })

  it.each(['remote_gateway', 'unknown'])('does not infer supported provenance for the %s command backend', async (commandBackend) => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.txt'), 'one')
    const result = await typedReadFile({ path: 'a.txt' }, env(root, {
      commandBackend,
      liveReadsOn: true,
      readProofOwner: { userId: 'user', agentId: 'agent', sessionId: 'session', messageId: 'message', toolCallId: 'read' }
    }))
    expect(result).toMatchObject({ success: true, content: 'one' })
    expect(result).not.toHaveProperty('fileReadProof')
  })

  it('applies Apple protected-workspace policy before any helper admission for all three primitives', async () => {
    const outer = await workspace()
    const protectedHome = path.join(outer, 'protected-home')
    const root = path.join(protectedHome, 'agents')
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'a.txt'), 'old')
    const previous = process.env.BATSHIT_SANDBOX_PROTECTED_HOME_DIR
    process.env.BATSHIT_SANDBOX_PROTECTED_HOME_DIR = protectedHome
    const admit = vi.spyOn(AnchoredProjectWriter, 'open')
    try {
      const apple = env(root, { commandBackend: 'apple_container' })
      const results = [
        await typedReadFile({ path: 'a.txt' }, apple),
        await typedWriteFile({ path: 'a.txt', content: 'new' }, apple),
        await typedEditFile({ path: 'a.txt', edits: [{ oldText: 'old', newText: 'new' }] }, apple)
      ]
      for (const result of results) {
        expect(result).toMatchObject({ success: false, blocked: true, errorCode: 'POLICY_BLOCKED' })
        expect(result.reason).toContain('Sandbox workspace exposes managed agent homes or protected runtime/Pinokio data.')
      }
      expect(admit).not.toHaveBeenCalled()
      expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('old')
      // SA-137 Round 2: Docker Sandbox meets the same guard before any helper admission.
      const docker = env(root, { commandBackend: 'docker_sandbox' })
      for (const result of [
        await typedReadFile({ path: 'a.txt' }, docker),
        await typedWriteFile({ path: 'a.txt', content: 'new' }, docker),
        await typedEditFile({ path: 'a.txt', edits: [{ oldText: 'old', newText: 'new' }] }, docker)
      ]) {
        expect(result).toMatchObject({ success: false, blocked: true, errorCode: 'POLICY_BLOCKED' })
      }
      expect(admit).not.toHaveBeenCalled()
      // Local keeps its existing host authority; only the actual sandbox backends have this guard.
      expect((await typedWriteFile({ path: 'a.txt', content: 'local' }, env(root))).success).toBe(true)
      expect(admit).toHaveBeenCalledTimes(1)
    } finally {
      admit.mockRestore()
      if (previous === undefined) delete process.env.BATSHIT_SANDBOX_PROTECTED_HOME_DIR
      else process.env.BATSHIT_SANDBOX_PROTECTED_HOME_DIR = previous
    }
  })

  it('does not infer a Local proof from missing command-backend metadata', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.txt'), 'one')
    const result = await typedReadFile({ path: 'a.txt' }, env(root, {
      commandBackend: undefined,
      readProofOwner: { userId: 'user', agentId: 'agent', sessionId: 'session', messageId: 'message', toolCallId: 'read' }
    }))
    expect(result).toMatchObject({ success: true, content: 'one' })
    expect(result).not.toHaveProperty('fileReadProof')
  })

  it('refuses a leaf swapped for an outside link before the helper read', async () => {
    const fixture = await layout()
    let readRequests = 0
    __setAnchoredWriterTestHook(async (op) => {
      if (op !== 'read') return
      readRequests += 1
      await rm(path.join(fixture.root, 'dir', 'a.txt'))
      await symlink(path.join(fixture.outside, 'a.txt'), path.join(fixture.root, 'dir', 'a.txt'))
    })
    const result = await typedReadFile({ path: 'dir/a.txt' }, env(fixture.root))
    expect(readRequests).toBe(1)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(await readFile(path.join(fixture.outside, 'a.txt'), 'utf8')).toBe('SECRET\n')
  })

  it('keeps exact old permission bits despite the helper umask', async () => {
    const root = await workspace()
    const file = path.join(root, 'a.txt')
    await writeFile(file, 'old')
    await chmod(file, 0o777)
    expect((await typedWriteFile({ path: 'a.txt', content: 'new' }, env(root))).success).toBe(true)
    expect((await stat(file)).mode & 0o777).toBe(0o777)
    expect((await typedWriteFile({ path: 'new.txt', content: 'new' }, env(root))).success).toBe(true)
    expect((await stat(path.join(root, 'new.txt'))).mode & 0o777).toBe(0o666 & ~process.umask())
  })

  it('rechecks kernel write permission after staging even if only the mode changed', async () => {
    const root = await workspace()
    const file = path.join(root, 'a.txt')
    await writeFile(file, 'old')
    let probes = 0
    __setAnchoredWriterTestHook(async (op, paths) => {
      if (op === 'probeWritable' && paths[0] === 'a.txt' && ++probes === 2) await chmod(file, 0o444)
    })
    const result = await typedWriteFile({ path: 'a.txt', content: 'new' }, env(root))
    expect(result).toMatchObject({ success: false, blocked: true, typedFileWrite: { outcome: 'unapplied' } })
    expect(probes).toBe(2)
    expect(await readFile(file, 'utf8')).toBe('old')
    expect(await stagedFiles(root)).toEqual([])
  })

  it.each(['final-lstat', 'final-probe'] as const)('refuses foreign bytes at %s with exact restored mtime by comparing frozen ctime', async (when) => {
    const root = await workspace()
    const file = path.join(root, 'a.txt')
    const alias = path.join(root, 'alias.txt')
    await writeFile(file, 'old\n')
    await link(file, alias)
    const seconds = 1_700_000_000
    await utimes(file, seconds, seconds)
    const before = await stat(file, { bigint: true })
    let probes = 0
    let changed = false
    const foreignChange = async () => {
      await writeFile(alias, 'bad\n')
      await utimes(alias, seconds, seconds)
      const now = await stat(file, { bigint: true })
      expect(now.dev).toBe(before.dev)
      expect(now.ino).toBe(before.ino)
      expect(now.mode).toBe(before.mode)
      expect(now.size).toBe(before.size)
      expect(now.mtimeNs).toBe(before.mtimeNs)
      expect(now.ctimeNs).not.toBe(before.ctimeNs)
      changed = true
    }
    __setAnchoredWriterTestHook(async (op, paths) => {
      if (op !== 'probeWritable' || paths[0] !== 'a.txt') return
      probes += 1
      if (when === 'final-probe' && probes === 2) await foreignChange()
    })
    if (when === 'final-lstat') __setTypedFileBeforeCommitForTests(foreignChange)
    const result = await typedWriteFile({ path: 'a.txt', content: 'new\n' }, env(root))
    expect(changed).toBe(true)
    expect(result).toMatchObject({ success: false, errorCode: 'FILE_CHANGED', typedFileWrite: { outcome: 'unapplied' } })
    expect(probes).toBe(when === 'final-lstat' ? 1 : 2)
    expect(await readFile(file, 'utf8')).toBe('bad\n')
    expect(await readFile(alias, 'utf8')).toBe('bad\n')
    expect(await stagedFiles(root)).toEqual([])
  })

  it('checks the 10,000,000-byte cap by stat before any native content read', async () => {
    const root = await workspace()
    const file = path.join(root, 'large.txt')
    await writeFile(file, '')
    await truncate(file, TYPED_FILE_MAX_BYTES + 1)
    let reads = 0
    __setAnchoredWriterTestHook((op) => { if (op === 'read') reads += 1 })
    const result = await typedReadFile({ path: 'large.txt' }, env(root))
    expect(result.reason).toBe('large.txt is 10,000,001 bytes; read_file and edit_file take files up to 10,000,000 bytes. Use Bash. Nothing was read.')
    expect(reads).toBe(0)
  })

  it('aborts an admitted read safely without handing over bytes or a proof', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.txt'), 'private bytes')
    const stop = new AbortController()
    let attempts = 0
    __setAnchoredWriterTestHook((op) => { if (op === 'read') { attempts += 1; stop.abort() } })
    const result = await typedReadFile({ path: 'a.txt' }, env(root, { abortSignal: stop.signal }))
    expect(attempts).toBe(1)
    expect(result).toMatchObject({ success: false, stopped: true, errorCode: 'STOPPED' })
    expect(result).not.toHaveProperty('content')
    expect(result).not.toHaveProperty('fileReadProof')
  })

  it('remains applied when a Stop and a throwing hook happen after the confirmed rename', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.txt'), 'old')
    const stop = new AbortController()
    const call = env(root, { abortSignal: stop.signal })
    __setTypedFileTestHook('afterCommit', () => { stop.abort(); throw new Error('late hook') })
    const result = await typedEditFile({ path: 'a.txt', edits: [{ oldText: 'old', newText: 'new' }] }, call)
    expect(result).toMatchObject({ success: true, typedFileEdit: { outcome: 'applied' } })
    expect(call.reports.map((item) => item.typedFileEdit.outcome)).toEqual(['unknown', 'applied'])
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('new')
  })

  it('does not delete a foreign entry when exclusive staging reports EEXIST', async () => {
    const root = await workspace()
    let collision = ''
    let attempts = 0
    const collide = async (relative: string) => {
      if (!relative.includes('.batshit-write-')) return
      attempts += 1
      collision = relative
      await writeFile(path.join(root, collision), 'foreign temporary entry')
    }
    // The same exclusive-create collision attacks the old Node open and the new native write.
    // It runs on both custody implementations, so the old unconditional undo-unlink fails here.
    pathRace.beforeOpen = (name) => collide(path.relative(root, name))
    __setAnchoredWriterTestHook(async (op, paths) => { if (op === 'write') await collide(paths[0]) })
    const result = await typedWriteFile({ path: 'new.txt', content: 'PAYLOAD' }, env(root))
    expect(attempts).toBe(1)
    expect(collision).toMatch(/^\.new\.txt\.batshit-write-[a-f0-9]{8}$/)
    expect(result).toMatchObject({ success: false, typedFileWrite: { outcome: 'unapplied' } })
    expect(await readFile(path.join(root, collision), 'utf8')).toBe('foreign temporary entry')
    expect(await readdir(root)).toEqual([collision])
  })

  it('keeps and names an unverified stage after a postcreate chmod refusal, with the target unapplied', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.txt'), 'old')
    let stage = ''
    __setAnchoredWriterTestHook(async (op, paths, data, writer) => {
      if (op !== 'write') return
      stage = paths[0]
      __setAnchoredWriterTestHook(null)
      await writer.writeFile(stage, data!, { create: 'new' }, { timeoutMs: 60_000 })
      throw new AnchoredWriteError('chmod', 'EPERM')
    })
    const result = await typedWriteFile({ path: 'a.txt', content: 'PAYLOAD' }, env(root))
    expect(result).toMatchObject({ success: false, typedFileWrite: { outcome: 'unapplied' } })
    expect(result.reason).toContain(`A temporary file may remain at ${stage}`)
    expect(result.reason).toContain('The target was not replaced.')
    expect(result.reason).not.toContain('Nothing was written.')
    expect(await readFile(path.join(root, stage), 'utf8')).toBe('PAYLOAD')
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('old')
  })

  it('does not clean an attacker replacement of a known staged inode', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.txt'), 'old')
    let stage = ''
    __setTypedFileBeforeCommitForTests(async () => {
      ;[stage] = await stagedFiles(root)
      await rename(path.join(root, stage), path.join(root, 'owned-stage-moved'))
      await writeFile(path.join(root, stage), 'foreign')
    })
    const result = await typedWriteFile({ path: 'a.txt', content: 'PAYLOAD' }, env(root))
    expect(result).toMatchObject({ success: false, typedFileWrite: { outcome: 'unapplied' } })
    expect(result.reason).toContain('owned identity could not be verified')
    expect(await readFile(path.join(root, stage), 'utf8')).toBe('foreign')
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('old')
  })

  it('names and keeps an unverified created folder after a lost mkdir reply', async () => {
    const root = await workspace()
    let attempts = 0
    __setAnchoredWriterTestHook(async (op, paths, _data, writer) => {
      if (op !== 'mkdir') return
      attempts += 1
      __setAnchoredWriterTestHook(null)
      await writer.mkdir(paths[0], { timeoutMs: 60_000 })
      await writer.close()
      throw new Error('mkdir reply lost')
    })
    const result = await typedWriteFile({ path: 'new/a.txt', content: 'PAYLOAD' }, env(root))
    expect(attempts).toBe(1)
    expect(result).toMatchObject({ success: false, typedFileWrite: { outcome: 'unknown' } })
    expect(result.reason).toContain('new (its created folder identity could not be verified)')
    expect(result.reason).not.toContain('Nothing was written.')
    expect(await readdir(root)).toEqual(['new'])
    expect(await readdir(path.join(root, 'new'))).toEqual([])
  })

  it('returns unknown after a lost staging reply and never deletes an unverified staged inode', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.txt'), 'old')
    let stage = ''
    __setAnchoredWriterTestHook(async (op, paths, data, writer) => {
      if (op !== 'write') return
      stage = paths[0]
      __setAnchoredWriterTestHook(null)
      await writer.writeFile(stage, data!, { create: 'new' }, { timeoutMs: 60_000 })
      await writer.close()
      throw new Error('staging reply lost')
    })
    const result = await typedWriteFile({ path: 'a.txt', content: 'PAYLOAD' }, env(root))
    expect(result).toMatchObject({ success: false, typedFileWrite: { outcome: 'unknown' } })
    expect(result.reason).not.toContain('Nothing was written.')
    expect(result.reason).not.toContain('restored')
    expect(await readFile(path.join(root, stage), 'utf8')).toBe('PAYLOAD')
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('old')
  })

  it('returns unknown when rename happened but its reply was lost', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.txt'), 'old')
    __setAnchoredWriterTestHook(async (op, paths, _data, writer) => {
      if (op !== 'rename') return
      __setAnchoredWriterTestHook(null)
      await writer.rename(paths[0], paths[1], { timeoutMs: 60_000 })
      await writer.close()
      throw new Error('rename reply lost')
    })
    const call = env(root)
    const result = await typedWriteFile({ path: 'a.txt', content: 'PAYLOAD' }, call)
    expect(result).toMatchObject({ success: false, typedFileWrite: { outcome: 'unknown' } })
    expect(call.reports).toEqual([expect.objectContaining({ typedFileWrite: expect.objectContaining({ outcome: 'unknown', stage: 'committing' }) })])
    expect(result.reason).not.toContain('Nothing was written.')
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('PAYLOAD')
    expect(await stagedFiles(root)).toEqual([])
  })

  it('never cleans through a replacement root after helper loss', async () => {
    const outer = await workspace()
    const root = path.join(outer, 'root')
    const held = path.join(outer, 'held')
    await mkdir(root)
    await writeFile(path.join(root, 'a.txt'), 'old')
    let stage = ''
    __setAnchoredWriterTestHook(async (op, paths, _data, writer) => {
      if (op !== 'rename') return
      stage = paths[0]
      __setAnchoredWriterTestHook(null)
      await writer.close()
      await rename(root, held)
      await mkdir(root)
      await writeFile(path.join(root, stage), 'foreign')
      throw new Error('helper lost as root moved')
    })
    const result = await typedWriteFile({ path: 'a.txt', content: 'PAYLOAD' }, env(root))
    expect(result).toMatchObject({ success: false, typedFileWrite: { outcome: 'unknown' } })
    expect(result.reason).toContain('cleanup could not admit the original workspace')
    expect(await readFile(path.join(root, stage), 'utf8')).toBe('foreign')
    expect(await readFile(path.join(held, 'a.txt'), 'utf8')).toBe('old')
    expect(await readFile(path.join(held, stage), 'utf8')).toBe('PAYLOAD')
  })
})

describe('Docker app-container typed workspace custody', () => {
  async function inContainer(root: string, run: () => Promise<void>) {
    const changes = { BATSHIT_CONTAINERIZED: '1', BATSHIT_RUNTIME_ENV: 'docker', BATSHIT_WORKSPACE_CONTAINER_PATH: root, BATSHIT_SANDBOX_CONTAINER_WORKSPACE_ROOT: root }
    const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]))
    Object.assign(process.env, changes)
    try { await run() }
    finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  it('keeps Local app writes, multiple replacements and independent calls on the admitted disk without an operator', async () => {
    const root = await workspace()
    const operator = vi.fn(async () => {})
    await inContainer(root, async () => {
      const context = env(root, { admitDockerWorkspace: operator })
      const results = await Promise.all([
        typedWriteFile({ path: 'sub/a.txt', content: 'alpha\nbeta\ngamma\n' }, context),
        typedWriteFile({ path: 'sub/b.txt', content: 'separate\n' }, context)
      ])
      expect(results.every((result) => result.success)).toBe(true)
      const edit = await typedEditFile({ path: 'sub/a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }, { oldText: 'gamma', newText: 'GAMMA' }] }, context)
      expect(edit).toMatchObject({ success: true, typedFileEdit: { outcome: 'applied' } })
      expect(await readFile(path.join(root, 'sub/a.txt'), 'utf8')).toBe('ALPHA\nbeta\nGAMMA\n')
      expect((await typedReadFile({ path: 'sub/b.txt' }, context)).content).toBe('separate\n')
      expect(operator).not.toHaveBeenCalled()
    })
  })

  it('does not widen Local app file authority when the operator namespace is changed to filesystem root', async () => {
    const mounted = await workspace()
    const outside = await workspace()
    await writeFile(path.join(outside, 'a.txt'), 'old')
    const admit = vi.spyOn(AnchoredProjectWriter, 'open')
    try {
      await inContainer(mounted, async () => {
        process.env.BATSHIT_SANDBOX_CONTAINER_WORKSPACE_ROOT = '/'
        const result = await typedWriteFile({ path: 'a.txt', content: 'outside mount' }, env(outside))
        expect(result).toMatchObject({ success: false, blocked: true, errorCode: 'POLICY_BLOCKED' })
        expect(admit).not.toHaveBeenCalled()
        expect(await readFile(path.join(outside, 'a.txt'), 'utf8')).toBe('old')
      })
    } finally { admit.mockRestore() }
  })

  it.each(['outside-root', 'aliased-outside-root'] as const)('refuses %s before helper admission', async (kind) => {
    const mounted = await workspace()
    const outside = await workspace()
    await writeFile(path.join(outside, 'a.txt'), 'old')
    const selected = kind === 'outside-root' ? outside : path.join(mounted, 'linked')
    if (kind === 'aliased-outside-root') await symlink(outside, selected)
    const admit = vi.spyOn(AnchoredProjectWriter, 'open')
    try {
      await inContainer(mounted, async () => {
        for (const result of [
          await typedReadFile({ path: 'a.txt' }, env(selected)),
          await typedWriteFile({ path: 'a.txt', content: 'new' }, env(selected)),
          await typedEditFile({ path: 'a.txt', edits: [{ oldText: 'old', newText: 'new' }] }, env(selected))
        ]) expect(result).toMatchObject({ success: false, blocked: true, errorCode: 'POLICY_BLOCKED' })
        expect(admit).not.toHaveBeenCalled()
        expect(await readFile(path.join(outside, 'a.txt'), 'utf8')).toBe('old')
      })
    } finally { admit.mockRestore() }
  })

  it('requires current Docker admission and passes the actual canonical plan before opening a writer', async () => {
    const root = await workspace()
    const cwd = path.join(root, 'project')
    await mkdir(cwd)
    await symlink(cwd, path.join(root, 'cwd-link'))
    await writeFile(path.join(cwd, 'a.txt'), 'one\n')
    const admit = vi.spyOn(AnchoredProjectWriter, 'open')
    try {
      await inContainer(root, async () => {
        const base = env(root, { cwd: path.join(root, 'cwd-link'), commandBackend: 'docker_sandbox' })
        expect(await typedReadFile({ path: 'a.txt' }, base)).toMatchObject({ success: false, errorCode: 'POLICY_BLOCKED' })
        expect(admit).not.toHaveBeenCalled()
        const operator = vi.fn(async () => { expect(admit).not.toHaveBeenCalled() })
        const result = await typedReadFile({ path: 'a.txt' }, { ...base, admitDockerWorkspace: operator, liveReadsOn: true,
          readProofOwner: { userId: 'user', agentId: 'agent', sessionId: 'session', messageId: 'message', toolCallId: 'read' } })
        expect(operator).toHaveBeenCalledWith(root, cwd, undefined)
        expect(admit).toHaveBeenCalledTimes(1)
        expect(result).toMatchObject({ success: true, content: 'one\n', fileReadProof: { backend: 'docker_sandbox', cwd, liveReadsOn: true } })
        expect(verifyFileReadProofSeal(result.fileReadProof)).toBe(true)
      })
    } finally { admit.mockRestore() }
  })

  it.each(['refused', 'stopped'] as const)('performs no file operation when operator preflight is %s', async (mode) => {
    const root = await workspace()
    await writeFile(path.join(root, 'a.txt'), 'old')
    const admit = vi.spyOn(AnchoredProjectWriter, 'open')
    const stop = new AbortController()
    try {
      await inContainer(root, async () => {
        const result = await typedWriteFile({ path: 'a.txt', content: 'new' }, env(root, {
          commandBackend: 'docker_sandbox', abortSignal: stop.signal,
          admitDockerWorkspace: async () => { if (mode === 'stopped') stop.abort(); else throw new Error('Operator admission refused') }
        }))
        expect(result).toMatchObject({ success: false, errorCode: mode === 'stopped' ? 'STOPPED' : 'POLICY_BLOCKED', typedFileWrite: { outcome: 'unapplied' } })
        expect(admit).not.toHaveBeenCalled()
        expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('old')
        expect(await stagedFiles(root)).toEqual([])
      })
    } finally { admit.mockRestore() }
  })
})
