import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { nativeToolService } from '../nativeTools'
import { __setAnchoredWriterTestHook } from '../anchoredProjectWriter'

/**
 * BL-2006 (2026-10-21), on the real executor and the real anchored writer: a folder (or the file
 * itself) swapped for a link to a folder outside the workspace while a managed patch is planned or
 * written. On a sandbox backend the host app writes the patch, and a sandboxed command in the same
 * step can make this swap. Before, the executor checked each path while it planned and then read
 * and wrote by path, so the swap sent the read and the write outside (`success: true`, the outside
 * file changed). Now every read and write goes through the anchored writer, which holds the
 * workspace folder and follows nothing: the patch fails and nothing outside is read or written.
 */

// The swap runs right after the planning resolves a path (`realpath` is how both the old and the
// new executor plan), so the first group fails on the old code. The second group swaps right
// before one of the writer's own steps, after the planning has passed.
const swap = vi.hoisted(() => ({ afterRealpath: null as null | ((file: string) => Promise<void>) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const realpath = (async (file: any, ...rest: any[]) => {
    const result = await (actual.realpath as any)(file, ...rest)
    await swap.afterRealpath?.(String(file))
    return result
  }) as typeof actual.realpath
  return { ...actual, realpath, default: { ...actual, realpath } }
})

const cleanup: string[] = []
afterEach(async () => {
  swap.afterRealpath = null
  __setAnchoredWriterTestHook(null)
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true })
})

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'batshit-bl2006-'))
  cleanup.push(base)
  const root = path.join(base, 'workspace')
  const outside = path.join(base, 'outside')
  await mkdir(path.join(root, 'dir'), { recursive: true })
  await mkdir(outside, { recursive: true })
  // The same text on both sides, so a hunk that read the outside file would apply.
  await writeFile(path.join(root, 'dir', 'a.txt'), 'old\n')
  await writeFile(path.join(outside, 'a.txt'), 'old\n')
  /** `dir` goes away (its files kept in `dir-moved`) and a link to the outside folder takes its name. */
  const swapDir = async () => {
    await rename(path.join(root, 'dir'), path.join(root, 'dir-moved'))
    await symlink(outside, path.join(root, 'dir'))
  }
  const outsideNames = async () => (await readdir(outside)).sort()
  return { root, outside, swapDir, outsideNames }
}

/** Runs `swapDir` once, the first time `when` matches. */
function once(swapDir: () => Promise<void>, when: (value: string) => boolean) {
  let done = false
  return async (value: string) => {
    if (done || !when(value)) return
    done = true
    await swapDir()
  }
}

const patch = (...sections: string[]) =>
  `apply_patch <<'PATCH'\n*** Begin Patch\n${sections.join('\n')}\n*** End Patch\nPATCH`
const updateA = patch('*** Update File: dir/a.txt\n@@\n-old\n+new')

function run(command: string, workspaceRoot: string) {
  return nativeToolService.nativeBashExecute({
    command,
    backend: 'local',
    accessMode: 'dangerous',
    requireApproval: false,
    workspaceRoot
  } as any)
}

describe('a folder swapped for a link while the patch is planned (BL-2006)', () => {
  it('an Update neither reads nor writes the file outside the workspace', async () => {
    const { root, outside, swapDir } = await fixture()
    swap.afterRealpath = once(swapDir, (file) => file.endsWith(`${path.sep}dir${path.sep}a.txt`))

    const result = await run(updateA, root)

    expect(result).toMatchObject({ success: false })
    expect(result.reason).toMatch(/Nothing was written/)
    expect(await readFile(path.join(outside, 'a.txt'), 'utf8')).toBe('old\n')
    expect(await readFile(path.join(root, 'dir-moved', 'a.txt'), 'utf8')).toBe('old\n')
  })

  it('an Add does not create a file outside the workspace', async () => {
    const { root, swapDir, outsideNames } = await fixture()
    swap.afterRealpath = once(swapDir, (file) => file.endsWith(`${path.sep}dir`))

    const result = await run(patch('*** Add File: dir/new.txt\n+planted'), root)

    expect(result).toMatchObject({ success: false })
    expect(await outsideNames()).toEqual(['a.txt'])
  })

  it('a Delete does not remove the file outside the workspace', async () => {
    const { root, outside, swapDir, outsideNames } = await fixture()
    swap.afterRealpath = once(swapDir, (file) => file.endsWith(`${path.sep}dir${path.sep}a.txt`))

    const result = await run(patch('*** Delete File: dir/a.txt'), root)

    expect(result).toMatchObject({ success: false })
    expect(await outsideNames()).toEqual(['a.txt'])
    expect(await readFile(path.join(outside, 'a.txt'), 'utf8')).toBe('old\n')
    expect(await readFile(path.join(root, 'dir-moved', 'a.txt'), 'utf8')).toBe('old\n')
  })
})

describe('a swap right before one of the anchored writer’s steps (BL-2006)', () => {
  const before = (op: string, file: string, act: () => Promise<void>) => {
    let done = false
    __setAnchoredWriterTestHook(async (seen, paths) => {
      if (done || seen !== op || paths[0] !== file) return
      done = true
      await act()
    })
  }

  it('the read of an Update is refused, so the outside text never reaches the diff', async () => {
    const { root, outside, swapDir } = await fixture()
    before('read', 'dir/a.txt', swapDir)

    const result = await run(updateA, root)

    expect(result).toMatchObject({ success: false })
    expect(result.reason).toBe(
      'Cannot read "dir/a.txt": a folder in its path changed into a link, or it leads outside the workspace or onto another disk. Nothing was written: Batshit applies a patch only when all of it applies.'
    )
    expect(await readFile(path.join(outside, 'a.txt'), 'utf8')).toBe('old\n')
  })

  it('the write of an Update is refused after the planning passed, and the patch is put back', async () => {
    const { root, outside, swapDir } = await fixture()
    await writeFile(path.join(root, 'b.txt'), 'b\n')
    before('write', 'dir/a.txt', swapDir)

    const result = await run(patch('*** Update File: b.txt\n@@\n-b\n+B', '*** Update File: dir/a.txt\n@@\n-old\n+new'), root)

    expect(result).toMatchObject({ success: false })
    expect(result.reason).toMatch(/^Writing "dir\/a\.txt" failed \(a folder in its path changed into a link.*\)\. Batshit put back every file the patch had changed, so nothing was written\.$/)
    expect(await readFile(path.join(outside, 'a.txt'), 'utf8')).toBe('old\n')
    expect(await readFile(path.join(root, 'dir-moved', 'a.txt'), 'utf8')).toBe('old\n')
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('b\n')
  })

  it('the file itself swapped for a link to an outside file is not written through', async () => {
    const { root, outside } = await fixture()
    before('write', 'dir/a.txt', async () => {
      await rm(path.join(root, 'dir', 'a.txt'))
      await symlink(path.join(outside, 'a.txt'), path.join(root, 'dir', 'a.txt'))
    })

    const result = await run(updateA, root)

    expect(result).toMatchObject({ success: false })
    expect(await readFile(path.join(outside, 'a.txt'), 'utf8')).toBe('old\n')
  })

  it('the removal of a Delete is refused, and the outside file stays', async () => {
    const { root, swapDir, outsideNames } = await fixture()
    before('rename', 'dir/a.txt', swapDir)

    const result = await run(patch('*** Delete File: dir/a.txt'), root)

    expect(result).toMatchObject({ success: false })
    expect(await outsideNames()).toEqual(['a.txt'])
    expect(await readFile(path.join(root, 'dir-moved', 'a.txt'), 'utf8')).toBe('old\n')
  })

  it('a new folder is not made outside the workspace', async () => {
    const { root, swapDir, outsideNames } = await fixture()
    before('mkdir', 'dir/sub', swapDir)

    const result = await run(patch('*** Add File: dir/sub/new.txt\n+planted'), root)

    expect(result).toMatchObject({ success: false })
    expect(await outsideNames()).toEqual(['a.txt'])
    expect(existsSync(path.join(root, 'dir-moved', 'sub'))).toBe(false)
  })

  it('a link inside the workspace still works: the writer is given its real path', async () => {
    const { root } = await fixture()
    await symlink(path.join(root, 'dir'), path.join(root, 'alias'))

    const result = await run(patch('*** Update File: alias/a.txt\n@@\n-old\n+new', '*** Add File: alias/b.txt\n+b'), root)

    expect(result).toMatchObject({ success: true })
    expect(await readFile(path.join(root, 'dir', 'a.txt'), 'utf8')).toBe('new\n')
    expect(await readFile(path.join(root, 'dir', 'b.txt'), 'utf8')).toBe('b\n')
    expect((await lstat(path.join(root, 'alias'))).isSymbolicLink()).toBe(true)
  })
})

describe('the anchored writer itself fails (BL-2006 review)', () => {
  it('a helper that dies mid-patch: a new writer puts every file back', async () => {
    const { root } = await fixture()
    await writeFile(path.join(root, 'b.txt'), 'b\n')
    let killed = false
    __setAnchoredWriterTestHook(async (op, paths, _data, writer) => {
      if (killed || op !== 'write' || paths[0] !== 'dir/a.txt') return
      killed = true
      await writer.close()
    })

    const result = await run(patch('*** Update File: b.txt\n@@\n-b\n+B', '*** Update File: dir/a.txt\n@@\n-old\n+new', '*** Add File: c.txt\n+c'), root)

    expect(killed).toBe(true)
    expect(result).toMatchObject({ success: false })
    expect(result.reason).toMatch(/^Writing "dir\/a\.txt" failed \(anchored project writer released\)\. Batshit put back every file the patch had changed, so nothing was written\.$/)
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('b\n')
    expect(await readFile(path.join(root, 'dir', 'a.txt'), 'utf8')).toBe('old\n')
    expect(existsSync(path.join(root, 'c.txt'))).toBe(false)
  })

  // The helper under a 1 KiB file size limit: it makes the new file, then its write fails (EFBIG
  // when the signal is ignored) or the helper dies (SIGXFSZ).
  const limitedHelper = async (base: string, ignoreSignal: boolean) => {
    const wrapper = path.join(base, ignoreSignal ? 'helper-efbig' : 'helper-dies')
    const real = process.env.BATSHIT_TEST_ANCHORED_READER!
    await writeFile(wrapper, `#!/bin/sh\n${ignoreSignal ? 'trap "" XFSZ\n' : ''}ulimit -f 2\nexec '${real}' "$@"\n`)
    await chmod(wrapper, 0o755)
    return wrapper
  }
  const bigAdd = `*** Add File: big.txt\n${Array.from({ length: 200 }, (_, line) => `+line ${line} ${'x'.repeat(40)}`).join('\n')}`

  it('a new file whose write fails after the helper made it is removed, and the result says so truly', async () => {
    const { root } = await fixture()
    await writeFile(path.join(root, 'b.txt'), 'b\n')
    const previous = process.env.BATSHIT_TEST_ANCHORED_READER
    process.env.BATSHIT_TEST_ANCHORED_READER = await limitedHelper(path.dirname(root), true)
    try {
      const result = await run(patch('*** Update File: b.txt\n@@\n-b\n+B', bigAdd), root)
      expect(result).toMatchObject({ success: false })
      expect(result.reason).toBe(
        'Writing "big.txt" failed (it is too large for the disk or a file size limit). Batshit put back every file the patch had changed, so nothing was written.'
      )
      expect(existsSync(path.join(root, 'big.txt'))).toBe(false)
      expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('b\n')
    } finally {
      process.env.BATSHIT_TEST_ANCHORED_READER = previous
    }
  })

  it('a new file whose helper died while writing it is named as left changed, never claimed put back', async () => {
    const { root } = await fixture()
    await writeFile(path.join(root, 'b.txt'), 'b\n')
    const previous = process.env.BATSHIT_TEST_ANCHORED_READER
    process.env.BATSHIT_TEST_ANCHORED_READER = await limitedHelper(path.dirname(root), false)
    try {
      const result = await run(patch('*** Update File: b.txt\n@@\n-b\n+B', bigAdd), root)
      expect(result).toMatchObject({ success: false })
      expect(existsSync(path.join(root, 'big.txt'))).toBe(true)
      expect(result.reason).toMatch(/^Writing "big\.txt" failed \(anchored project writer closed\), and Batshit could not put back big\.txt: that path is left changed\./)
      expect(result.managedApplyPatch).toMatchObject({ partial: true, changedPaths: [path.join(await realpath(root), 'big.txt')] })
      expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('b\n')
    } finally {
      process.env.BATSHIT_TEST_ANCHORED_READER = previous
    }
  })

  it.each([
    ['anchored-reader:root-path:0', 'the native file helper predates its writer mode; restart Batshit so it rebuilds the helper'],
    ['anchored-reader:openat2-unavailable:38', 'this Linux kernel has no openat2, which Batshit needs to write a patch safely (Linux 5.6 or later)']
  ])('a helper that exits with %s says why, and writes nothing', async (line, reason) => {
    const { root } = await fixture()
    const fake = path.join(path.dirname(root), 'old-helper')
    await writeFile(fake, `#!/bin/sh\necho '${line}' >&2\nexit 2\n`)
    await chmod(fake, 0o755)
    const previous = process.env.BATSHIT_TEST_ANCHORED_READER
    process.env.BATSHIT_TEST_ANCHORED_READER = fake
    try {
      const result = await run(updateA, root)
      expect(result).toMatchObject({ success: false })
      expect(result.reason).toBe(
        `Batshit could not hold the workspace folder to apply the patch safely (${reason}). Nothing was written: Batshit applies a patch only when all of it applies.`
      )
      expect(await readFile(path.join(root, 'dir', 'a.txt'), 'utf8')).toBe('old\n')
    } finally {
      process.env.BATSHIT_TEST_ANCHORED_READER = previous
    }
  })
})
