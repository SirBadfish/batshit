// @vitest-environment node
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nativeToolService } from '../nativeTools'
import { formatBashResultForModel } from '../bashResultModelText'
import { verifyFileReadProofSeal } from '../fileReadProofSeal'
import { redis } from '$lib/server/redis'

/**
 * BL-1652: a local run that read several files carries `readSplit`, proven against the files just
 * after the run, so the zip adapter can store one zip per file. A one-file read, a failed or noisy
 * run, and a file outside the workspace carry none, and the model's view of the result is the
 * same with or without it.
 */

const A = "'use strict'\nconst a = 1\n"
const B = 'line one\nline two\nline three\n'

describe('native Bash proves the parts of a multi-file read (BL-1652)', () => {
  let workspace = ''
  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-bl1652-'))
    await mkdir(path.join(workspace, 'src'))
    await writeFile(path.join(workspace, 'src', 'a.js'), A)
    await writeFile(path.join(workspace, 'src', 'b.txt'), B)
  })
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  async function run(command: string, splitMultiFileReads = true) {
    return (await nativeToolService.nativeBashExecute({
      splitMultiFileReads,
      command,
      workspaceRoot: workspace,
      cwd: workspace,
      accessMode: 'dangerous',
      backend: 'local'
    })) as Record<string, any>
  }

  it('splits cat of two files and a sed range after an ls, by offsets into stdout', async () => {
    const result = await run(`cd ${workspace} && cat src/a.js src/b.txt && ls src && sed -n 2,3p src/b.txt`)
    expect(result.exitCode).toBe(0)
    const parts = result.readSplit?.parts ?? []
    expect(parts.map((part: any) => [part.kind, part.path ?? null, result.stdout.slice(part.start, part.end)])).toEqual([
      ['read', 'src/a.js', A],
      ['read', 'src/b.txt', B],
      ['other', null, 'a.js\nb.txt\n'],
      ['read', 'src/b.txt', 'line two\nline three\n']
    ])
    expect(result.readSplit.command).toBe(`cd ${workspace} && cat src/a.js src/b.txt && ls src && sed -n 2,3p src/b.txt`)
  }, 30_000)

  it('the model reads the same text with or without the split', async () => {
    const result = await run(`cat src/a.js src/b.txt`)
    expect(result.readSplit).toBeTruthy()
    const { readSplit: _split, ...without } = result
    expect(formatBashResultForModel(result)).toBe(formatBashResultForModel(without))
  }, 30_000)

  it('carries no split for a one-file read, a failed or noisy run, or a file outside the workspace', async () => {
    expect((await run('cat src/a.js')).readSplit).toBeUndefined()
    expect((await run('cat src/a.js src/missing.txt')).readSplit).toBeUndefined()
    expect((await run("cat src/a.js src/b.txt && printf 'warn\\n' >&2")).readSplit).toBeUndefined()
    // a command that writes to a file it printed (review finding 2: tee appended what the read part
    // would have stored as the file's own text)
    expect((await run('cat src/a.js src/b.txt && echo zz | tee -a src/b.txt')).readSplit).toBeUndefined()
    // only the API lane's own tool asks for a split (the Workflow Subagent dispatch and the skill
    // script runner do not)
    expect((await run('cat src/a.js src/b.txt', false)).readSplit).toBeUndefined()
    const outside = await mkdtemp(path.join(os.tmpdir(), 'batshit-bl1652-outside-'))
    try {
      await writeFile(path.join(outside, 'x.txt'), 'outside\n')
      expect((await run(`cat src/a.js ${path.join(outside, 'x.txt')}`)).readSplit).toBeUndefined()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  }, 30_000)
})

/**
 * SA-137 (D4, D8, D12): with live file reads on, the API lane's Bash tool proves which file and form
 * each read showed (`fileReadProof`, sealed in this process). It re-reads the file once after the
 * run and keeps the proof only when the output is exactly what that form prints of the unchanged
 * file. Off, the result is byte-for-byte what it was, and nothing extra is read.
 */
describe('native Bash proves a live file read (SA-137)', () => {
  let workspace = ''
  beforeEach(async () => {
    workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'batshit-sa137-')))
    await mkdir(path.join(workspace, 'src'))
    await writeFile(path.join(workspace, 'src', 'a.js'), A)
    await writeFile(path.join(workspace, 'src', 'b.txt'), B)
    // The command guardian runs a command only for an agent that exists and is the user's.
    await redis.set(`agent:${owner.agentId}`, { id: owner.agentId, user_id: owner.userId })
  })
  afterEach(async () => {
    await redis.del(`agent:${owner.agentId}`)
    await rm(workspace, { recursive: true, force: true })
  })

  const owner = { userId: 'user-sa137', agentId: 'agent-sa137', sessionId: 'session-sa137', messageId: 'reply-sa137', toolCallId: 'toolu-sa137' }

  async function run(command: string, prove = true) {
    return (await nativeToolService.nativeBashExecute({
      splitMultiFileReads: true,
      proveFileReadSource: prove,
      ...owner,
      command,
      workspaceRoot: workspace,
      cwd: workspace,
      accessMode: 'dangerous',
      backend: 'local'
    })) as Record<string, any>
  }

  it('proves a one-file read in each v1 form, sealed, with the root, its identity and the locator', async () => {
    const root = await stat(workspace, { bigint: true })
    for (const [command, view] of [
      ['cat src/a.js', { kind: 'whole', numbering: 'none' }],
      ['cat -n src/b.txt', { kind: 'whole', numbering: 'all' }],
      [`cd ${workspace}/src && sed -n 2,3p b.txt`, { kind: 'lines', script: '2,3p' }],
      ['tail -n 1 src/b.txt', { kind: 'tail', lines: 1 }]
    ] as const) {
      const result = await run(command)
      expect(result.exitCode, command).toBe(0)
      expect(result.fileReadProof, command).toMatchObject({
        version: 1,
        ...owner,
        backend: 'local',
        workspaceRoot: workspace,
        rootIdentity: `${root.dev}:${root.ino}`,
        cwd: workspace,
        reads: [{ part: null, locator: command.includes('b.txt') ? 'src/b.txt' : 'src/a.js', view }],
        // Proven only while live reads are on, so the proof says so (only such reads refresh).
        liveReadsOn: true
      })
      expect(verifyFileReadProofSeal(result.fileReadProof), command).toBe(true)
    }
  }, 30_000)

  it('proves each viewable part of a split by its index, and none of nl or a byte count', async () => {
    const result = await run('cat src/a.js && ls src && nl -ba src/b.txt && sed -n 1p src/b.txt && head -c 4 src/a.js')
    expect(result.readSplit).toBeTruthy()
    const reads = result.fileReadProof?.reads ?? []
    expect(reads.map((read: any) => [read.part, read.locator, read.view.kind])).toEqual([
      [0, 'src/a.js', 'whole'],
      [3, 'src/b.txt', 'lines']
    ])
    expect(result.readSplit.parts[0]).toMatchObject({ kind: 'read', path: 'src/a.js' })
    expect(result.readSplit.parts[3]).toMatchObject({ kind: 'read', path: 'src/b.txt' })
  }, 30_000)

  it('proves nothing it cannot: off, a path-named program, a link, a failed or noisy run, a changed file, outside the root, no owner', async () => {
    await symlink(path.join(workspace, 'src', 'a.js'), path.join(workspace, 'src', 'link.js'))
    await writeFile(path.join(workspace, 'src', 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    await writeFile(path.join(workspace, 'src', 'long.txt'), 'x'.repeat(120_001))
    for (const command of [
      '/bin/cat src/a.js',
      "bash -c 'cat src/a.js'",
      "bash -c 'cat src/a.js src/b.txt'",
      'cat src/latin1.txt',
      'cat src/long.txt',
      'cat src/link.js',
      'cat src/missing.js',
      "cat src/a.js && printf 'w\\n' >&2",
      'cat src/a.js; echo more >> src/a.js',
      'cat src/a.js | head -n 1',
      'nl -ba src/a.js'
    ]) {
      expect((await run(command)).fileReadProof, command).toBeUndefined()
    }
    const outside = await mkdtemp(path.join(os.tmpdir(), 'batshit-sa137-outside-'))
    try {
      await writeFile(path.join(outside, 'x.txt'), 'outside\n')
      expect((await run(`cat ${path.join(outside, 'x.txt')}`)).fileReadProof).toBeUndefined()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
    const noOwner = (await nativeToolService.nativeBashExecute({
      splitMultiFileReads: true,
      proveFileReadSource: true,
      command: 'cat src/a.js',
      workspaceRoot: workspace,
      cwd: workspace,
      accessMode: 'dangerous',
      backend: 'local'
    })) as Record<string, any>
    expect(noOwner.fileReadProof).toBeUndefined()
  }, 30_000)

  it('off, the result has exactly the keys and values it had before, and the model reads the same text', async () => {
    const off = await run('cat src/a.js', false)
    const on = await run('cat src/a.js', true)
    expect(off.fileReadProof).toBeUndefined()
    const { fileReadProof: _proof, durationMs: _d1, ...onRest } = on
    const { durationMs: _d2, ...offRest } = off
    expect(onRest).toEqual(offRest)
    expect(formatBashResultForModel(on)).toBe(formatBashResultForModel(off))
  }, 30_000)
})
