import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexReplyBaseline } from '../codexReplyBaseline'

/**
 * BL-9 — the read-only git baseline a Codex reply takes before Codex starts. Every case runs
 * real git in a throwaway repository; nothing is mocked but the copy reader, which reads the
 * real file the way batshit-server would.
 */

let root = ''
let repo = ''

const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
const write = (relative: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true })
  writeFileSync(path.join(repo, relative), text)
}
const baselines: CodexReplyBaseline[] = []
const take = async (projectPath: string, extra: Partial<Parameters<typeof CodexReplyBaseline.take>[0]> = {}) => {
  const baseline = await CodexReplyBaseline.take({ projectPath, ...extra })
  baselines.push(baseline)
  return baseline
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bl9-baseline-'))
  repo = path.join(root, 'repo')
  mkdirSync(repo)
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  write('top.md', 'top\n')
  write('app/changed.md', 'one\n')
  write('app/clean.md', 'first\nsecond\n')
  write('app/staged.md', 'staged\n')
  write('app/skipped.md', 'skipped\n')
  git('add', '.')
  git('commit', '-qm', 'init')
})

afterEach(async () => {
  await Promise.all(baselines.splice(0).map(baseline => baseline.dispose()))
  rmSync(root, { recursive: true, force: true })
})

describe('CodexReplyBaseline.take', () => {
  it('lists only tracked files with unstaged changes inside the project folder, and copies each', async () => {
    write('top.md', 'top, changed outside the project\n')
    write('app/changed.md', 'one\nan older change\n')
    write('app/staged.md', 'staged and added\n')
    git('add', 'app/staged.md')
    write('app/untracked.md', 'new\n')
    const project = path.join(repo, 'app')

    const baseline = await take(project)

    expect(baseline.ready).toBe(true)
    expect([...baseline.startCopies.entries()]).toEqual([
      [path.join(project, 'changed.md'), 'one\nan older change\n']
    ])
  })

  it('vouches for nothing, and never rejects, outside a git repository or with no project', async () => {
    const plain = path.join(root, 'plain')
    mkdirSync(plain)
    writeFileSync(path.join(plain, 'notes.md'), 'x\n')

    for (const projectPath of [plain, path.join(root, 'missing'), '', null]) {
      const baseline = await take(projectPath as string)
      expect(baseline.ready, String(projectPath)).toBe(false)
      expect(baseline.unavailableReason, String(projectPath)).toBeTruthy()
      expect(await baseline.readDiff(path.join(plain, 'notes.md'))).toMatchObject({ kind: 'unvouched' })
    }
  })

  it('does not hold the reply when the real Git scan exceeds its total deadline', async () => {
    write('app/changed.md', 'one\nchanged\n')
    const project = path.join(repo, 'app')
    const started = Date.now()

    const baseline = await take(project, { totalTimeoutMs: 0 })

    expect(Date.now() - started).toBeLessThan(3000)
    expect(baseline.ready).toBe(false)
    expect(baseline.unavailableReason).toMatch(/took longer than/)
    expect(baseline.startCopies.size).toBe(0)
    expect(await baseline.readDiff(path.join(project, 'changed.md'))).toMatchObject({ kind: 'unvouched' })
  })

  it('ends at once when the reply is stopped before or during its real Git scan', async () => {
    write('app/changed.md', 'one\nchanged\n')
    const project = path.join(repo, 'app')

    const stoppedBefore = new AbortController()
    stoppedBefore.abort()
    const before = await take(project, { signal: stoppedBefore.signal })
    expect(before.ready).toBe(false)
    expect(before.unavailableReason).toMatch(/stopped/)

    const stop = new AbortController()
    const started = Date.now()
    const pending = take(project, { signal: stop.signal })
    setTimeout(() => stop.abort(), 0)
    const during = await pending
    expect(Date.now() - started).toBeLessThan(1000)
    expect(during.ready).toBe(false)
    expect(during.unavailableReason).toMatch(/stopped/)
  })

  it('stops listing again on the reply\'s Stop and vouches for nothing after it', async () => {
    const project = path.join(repo, 'app')
    const baseline = await take(project)
    const stop = new AbortController()
    stop.abort()

    expect(await baseline.relist(stop.signal)).toEqual([])
    expect(baseline.ready).toBe(false)
    expect(baseline.unavailableReason).toMatch(/stopped/)
  })

  it('copies at most maxCopies files, and one it did not copy stays unvouched', async () => {
    write('app/changed.md', 'one\nchanged\n')
    write('app/clean.md', 'first\nsecond\nchanged\n')
    const project = path.join(repo, 'app')

    const baseline = await take(project, { maxCopies: 1 })

    expect([...baseline.startCopies.keys()]).toEqual([path.join(project, 'changed.md')])
    expect(await baseline.readDiff(path.join(project, 'clean.md'))).toMatchObject({ kind: 'unvouched' })
  })
})

describe('CodexReplyBaseline.readDiff', () => {
  it('gives exactly what changed in a clean tracked file since the baseline, and "unchanged" for one that did not', async () => {
    const project = path.join(repo, 'app')
    const baseline = await take(project)
    write('app/clean.md', 'first\nsecond, edited\n')

    const edited = await baseline.readDiff(path.join(project, 'clean.md'))
    expect(edited.kind).toBe('diff')
    expect(edited.kind === 'diff' && edited.diff).toMatch(/-\s+2 \| second\n\+\s+2 \| second, edited/)
    // A relative path is the project's.
    expect(await baseline.readDiff('clean.md')).toEqual(edited)
    expect(await baseline.readDiff(path.join(project, 'changed.md'))).toEqual({ kind: 'unchanged' })
  })

  it('vouches for no file it cannot: older changes, untracked, skipped by git, outside the project, or changed by a step', async () => {
    write('app/changed.md', 'one\nan older change\n')
    write('app/untracked.md', 'new\n')
    git('update-index', '--skip-worktree', 'app/skipped.md')
    const project = path.join(repo, 'app')
    const baseline = await take(project)
    write('app/skipped.md', 'skipped, edited\n')
    baseline.markChanged(path.join(project, 'clean.md'))

    for (const [file, reason] of [
      ['changed.md', /already had changes/],
      ['untracked.md', /no stable index baseline/],
      ['skipped.md', /no stable index baseline/],
      ['../top.md', /outside the project/],
      ['clean.md', /earlier step/]
    ] as const) {
      const result = await baseline.readDiff(path.resolve(project, file))
      expect(result.kind, file).toBe('unvouched')
      expect(result.kind === 'unvouched' && result.reason, file).toMatch(reason)
    }
  })

  // BL-152 review finding 3: with every filter driver switched off, git compares the stored
  // blob (a Git LFS or git-crypt pointer) with the file's plain content, so its diff drew
  // pointer against content as the edit.
  it('never vouches for a file a filter driver stores differently (Git LFS, git-crypt)', async () => {
    const project = path.join(repo, 'app')
    // Set after the commit, so the stored blob is plain text and no git-lfs is needed here.
    writeFileSync(path.join(repo, '.git', 'info', 'attributes'), 'app/clean.md filter=lfs diff=lfs merge=lfs -text\n')
    const baseline = await take(project)
    write('app/clean.md', 'first\nsecond, edited\n')

    const result = await baseline.readDiff(path.join(project, 'clean.md'))

    expect(result.kind).toBe('unvouched')
    expect(result.kind === 'unvouched' && result.reason).toMatch(/filter/)
    // A file with no filter attribute is still vouched for.
    expect(await baseline.readDiff(path.join(project, 'staged.md'))).toEqual({ kind: 'unchanged' })
  })

  it('reads a file whose name looks like a pattern as exactly that file', async () => {
    write('app/a1.md', 'one\n')
    write('app/a[1].md', 'bracket\n')
    git('add', '--', 'app/a1.md', ':(literal)app/a[1].md')
    git('commit', '-qm', 'pattern-like names')
    const project = path.join(repo, 'app')
    const baseline = await take(project)
    write('app/a1.md', 'one\nchanged in the other file\n')
    write('app/a[1].md', 'bracket\nchanged here\n')

    const result = await baseline.readDiff(path.join(project, 'a[1].md'))

    expect(result.kind === 'diff' && result.diff).toMatch(/\+\s+2 \| changed here/)
    expect(result.kind === 'diff' && result.diff).not.toContain('changed in the other file')
  })

  it('refuses an index OID changed after listing until a new listing captures it', async () => {
    const project = path.join(repo, 'app')
    const baseline = await take(project)
    write('app/clean.md', 'first\nnew staged version\n')
    git('add', 'app/clean.md')
    write('app/clean.md', 'first\nnew staged version\nnew worktree edit\n')
    expect(await baseline.readDiff('clean.md')).toMatchObject({ kind: 'unvouched' })

    expect(await baseline.relist()).toEqual([path.join(project, 'clean.md')])
    expect(await baseline.readDiff('clean.md')).toMatchObject({ kind: 'unvouched' })
    git('add', 'app/clean.md')
    expect(await baseline.relist()).toEqual([])
    write('app/clean.md', 'first\nnew staged version\nnew worktree edit\nnext edit\n')
    const result = await baseline.readDiff('clean.md')
    expect(result.kind === 'diff' && result.diff).toMatch(/\+\s+4 \| next edit/)
  })
})

describe('CodexReplyBaseline.relist', () => {
  it('returns the files a command left changed, and vouches again for one the command staged', async () => {
    const project = path.join(repo, 'app')
    const clean = path.join(project, 'clean.md')
    const baseline = await take(project)

    // A script Batshit cannot follow edits the file.
    write('app/clean.md', 'first\nsecond\nby a script\n')
    expect(await baseline.relist()).toEqual([clean])
    expect(await baseline.readDiff(clean)).toMatchObject({ kind: 'unvouched' })

    // Another command stages it: the index is the file again, so git vouches from here.
    git('add', 'app/clean.md')
    expect(await baseline.relist()).toEqual([])
    expect(await baseline.readDiff(clean)).toEqual({ kind: 'unchanged' })
    write('app/clean.md', 'first\nsecond\nby a script\nand by the edit\n')
    const edited = await baseline.readDiff(clean)
    expect(edited.kind === 'diff' && edited.diff).toMatch(/\+\s+4 \| and by the edit/)
    expect(edited.kind === 'diff' && edited.diff).not.toMatch(/\+\s+\d+ \| by a script/)
  })

  it('clears what the steps changed, since the new listing sees their changes itself', async () => {
    const project = path.join(repo, 'app')
    const staged = path.join(project, 'staged.md')
    const baseline = await take(project)
    baseline.markChanged(staged)
    expect(await baseline.readDiff(staged)).toMatchObject({ kind: 'unvouched' })

    await baseline.relist()

    expect(await baseline.readDiff(staged)).toEqual({ kind: 'unchanged' })
  })

  it('stops vouching for the rest of the reply when a listing fails', async () => {
    const project = path.join(repo, 'app')
    const baseline = await take(project)
    rmSync(path.join(repo, '.git'), { recursive: true, force: true })

    expect(await baseline.relist()).toEqual([])
    expect(baseline.ready).toBe(false)
    expect(await baseline.readDiff(path.join(project, 'clean.md'))).toMatchObject({ kind: 'unvouched' })
  })
})

// BL-170: Batshit runs this git on the host, outside Codex's sandbox, in a repository the agent
// can write. The repository's `core.fsmonitor` hook and a `diff.<driver>.textconv` command are
// programs a plain `git diff`/`git status` runs, and a porcelain `git diff` rewrites
// `.git/index` when a file's stat info is stale (even with `--no-optional-locks`).
describe('every git call is read-only and runs nothing the repository names', () => {
  it('takes, lists again, and reads diffs with no hook, no textconv, no filter, and no index write', async () => {
    const markers = path.join(root, 'markers.log')
    const hook = (name: string, body: string) => {
      const file = path.join(root, `${name}.sh`)
      writeFileSync(file, `#!/bin/sh\necho ${name} >> "${markers}"\n${body}\n`, { mode: 0o755 })
      return file
    }
    git('config', 'core.fsmonitor', hook('fsmonitor', 'exit 1'))
    git('config', 'diff.zbtextconv.textconv', hook('textconv', 'cat "$1"'))
    // Review finding 2: a clean filter and a long-running process filter are programs too,
    // and `status` and `diff-files` run them on any file whose stat info is stale. `required`
    // makes git refuse to work at all if the filter is merely switched off.
    // `clean.md` has its filter unset, so its diff is still read (a filtered file never is,
    // BL-152 review finding 3); the others are listed by `status` with stale stat info.
    writeFileSync(
      path.join(repo, '.git', 'info', 'attributes'),
      '*.md diff=zbtextconv filter=zbclean\napp/staged.md filter=zbprocess\napp/clean.md -filter\n'
    )
    git('config', 'filter.zbclean.clean', hook('clean', 'cat'))
    git('config', 'filter.zbclean.required', 'true')
    git('config', 'filter.zbprocess.process', hook('process', 'exit 1'))
    write('app/changed.md', 'one\nchanged\n')
    // Stale stat info on a file whose content did not change, and on one whose content did.
    const future = new Date(Date.now() + 60_000)
    utimesSync(path.join(repo, 'app', 'staged.md'), future, future)
    utimesSync(path.join(repo, 'app', 'changed.md'), future, future)
    const indexBefore = readFileSync(path.join(repo, '.git', 'index'))
    const project = path.join(repo, 'app')

    const baseline = await take(project)
    write('app/clean.md', 'first\nsecond, edited\n')
    utimesSync(path.join(repo, 'app', 'clean.md'), future, future)
    const edited = await baseline.readDiff(path.join(project, 'clean.md'))
    const unchanged = await baseline.readDiff(path.join(project, 'staged.md'))
    await baseline.relist()

    expect(baseline.startCopies.size).toBe(1)
    expect(edited.kind === 'diff' && edited.diff).toMatch(/\+\s+2 \| second, edited/)
    expect(unchanged.kind === 'unvouched' && unchanged.reason).toMatch(/filter/)
    expect(existsSync(markers) ? readFileSync(markers, 'utf8') : '').toBe('')
    expect(readFileSync(path.join(repo, '.git', 'index')).equals(indexBefore)).toBe(true)
  })
})


describe('BL-290 repository configuration race', () => {
  it('never executes a filter added between config discovery and the next Git call', async () => {
    const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
    const bin = path.join(root, 'bin')
    mkdirSync(bin)
    const marker = path.join(root, 'filter-ran')
    const filterScript = path.join(root, 'filter.sh')
    writeFileSync(filterScript, `#!/bin/sh\nprintf ran > '${marker}'\ncat\n`, { mode: 0o755 })
    writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.md filter=late\n')
    write('app/changed.md', 'different content\n')
    writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('diff-files') || (args.includes('ls-files') && args.includes('--debug'))) {
  spawnSync(${JSON.stringify(realGit)}, ['-C', ${JSON.stringify(repo)}, 'config', 'filter.late.clean', ${JSON.stringify(filterScript)}]);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, {encoding:'utf8'});
if (args.includes('config') && args.includes('--get-regexp')) {
  spawnSync(${JSON.stringify(realGit)}, ['-C', ${JSON.stringify(repo)}, 'config', 'filter.late.clean', ${JSON.stringify(filterScript)}]);
}
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
`, { mode: 0o755 })
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`
    try {
      const baseline = await take(path.join(repo, 'app'))
      expect(baseline.ready).toBe(true)
      expect(existsSync(marker)).toBe(false)
      expect(baseline.startCopies.get(path.join(repo, 'app', 'changed.md'))).toBe('different content\n')
    } finally { process.env.PATH = previousPath }
  })
})


describe('BL-290 controlled text comparisons', () => {
  it('refines stale stat candidates without consuming the dirty-copy limit', async () => {
    const future = new Date(Date.now() + 60_000)
    utimesSync(path.join(repo, 'app', 'changed.md'), future, future)
    write('app/clean.md', 'first\nactual change\n')
    const baseline = await take(path.join(repo, 'app'), { maxCopies: 1 })
    expect([...baseline.startCopies.keys()]).toEqual([path.join(repo, 'app', 'clean.md')])
    expect(await baseline.readDiff('changed.md')).toEqual({ kind: 'unchanged' })
  })

  it('refuses a tracked symlink and a file replaced by an outside symlink without reading its target', async () => {
    const outside = path.join(root, 'private.md')
    writeFileSync(outside, 'private data')
    symlinkSync(outside, path.join(repo, 'app', 'link.md'))
    git('add', 'app/link.md')
    git('commit', '-qm', 'symlink')
    const baseline = await take(path.join(repo, 'app'))
    expect(await baseline.readDiff('link.md')).toMatchObject({ kind: 'unvouched' })
    rmSync(path.join(repo, 'app', 'clean.md'))
    symlinkSync(outside, path.join(repo, 'app', 'clean.md'))
    expect(await baseline.readDiff('clean.md')).toMatchObject({ kind: 'unvouched' })
    expect(await baseline.readDiff('clean.md')).toMatchObject({ kind: 'unvouched' })
  })

  it('refuses a tracked path redirected through a parent symlink inside the project', async () => {
    write('app/alias/file.md', 'original\n')
    write('app/other/file.md', 'different\n')
    git('add', 'app/alias/file.md', 'app/other/file.md')
    git('commit', '-qm', 'tracked folders')
    const baseline = await take(path.join(repo, 'app'))
    rmSync(path.join(repo, 'app', 'alias'), { recursive: true })
    symlinkSync('other', path.join(repo, 'app', 'alias'), 'dir')

    expect(await baseline.readDiff('alias/file.md')).toMatchObject({ kind: 'unvouched' })
  })

  it('does not display raw index bytes as edits for converted or binary text', async () => {
    const baseline = await take(path.join(repo, 'app'))
    writeFileSync(path.join(repo, '.git', 'info', 'attributes'), 'app/clean.md text eol=crlf\n')
    write('app/clean.md', 'first\r\nsecond\r\nthird\r\n')
    expect(await baseline.readDiff('clean.md')).toMatchObject({ kind: 'unvouched' })
    writeFileSync(path.join(repo, 'app', 'changed.md'), Buffer.from([0xff, 0x00, 0xfe]))
    expect(await baseline.readDiff('changed.md')).toMatchObject({ kind: 'unvouched' })
  })
})
