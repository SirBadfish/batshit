// @vitest-environment node
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { resetLiveFileReadPermitsForTests, type LiveReadReader } from '../liveFileReadSnapshot.server'
import * as liveReadSnapshot from '../liveFileReadSnapshot.server'
import { sealLiveFileReadReplay } from '../fileReadProofSeal'
import {
  LIVE_READ_MAX_CANDIDATES,
  LIVE_READ_REPLAY_MAX_BYTES,
  LiveFileReadReplayError,
  LiveFileReadSharingChangedError,
  LiveFileReadTurn,
  buildLiveFileReadReplay,
  checkLiveFileReadReplay,
  liveFileReadReplayBytes,
  liveFileReadReplayExpiry,
  liveReadLabel,
  liveReadReplayApprovalIds,
  readLiveFileReadReplay,
  scheduleLiveFileReadReplayExpiry,
  type LiveReadCandidate,
  type LiveReadOtherReaders
} from '../liveFileReadTurn.server'

/**
 * SA-137 P2 (D2, D6, D7): one frozen snapshot per turn. The first ask reads; every later ask gets
 * the same object; a resume rebuilds it from the paused record's replay with no read; a snapshot
 * whose replay would not fit 1 MiB goes static whole before any model call; the replay is only
 * ever accepted from the same user, chat, agent and reply, unexpired.
 */

// The sandbox mount guard is the real one's job (its own tests); here it is the switch that says
// whether a sandbox could mount the admitted folder.
const sandboxMocks = vi.hoisted(() => ({ assertSafe: vi.fn(async (_roots: readonly string[]) => {}) }))
vi.mock('../sandboxHomeMounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sandboxHomeMounts')>()),
  assertSandboxMountRootsSafe: sandboxMocks.assertSafe
}))

const owner = { userId: 'u', agentId: 'a', sessionId: 's', messageId: 'reply' }
let root = ''
let rootIdentity = ''

/** Runs `run` with `process.platform` reported as `platform`, then restores it (admission and the refusal rules read it directly). */
async function withPlatform<T>(platform: string, run: () => T | Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

beforeEach(() => {
  resetLiveFileReadPermitsForTests()
  sandboxMocks.assertSafe.mockReset()
  sandboxMocks.assertSafe.mockResolvedValue(undefined)
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa137-turn-')))
  const details = statSync(root, { bigint: true })
  rootIdentity = `${details.dev}:${details.ino}`
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function candidate(index: number, file = `src/f${index}.js`): LiveReadCandidate {
  const zipId = `cool_tool_17900001370${String(index).padStart(2, '0')}_turn`
  return {
    rawZipId: zipId,
    zipId,
    source: {
      version: 1,
      owner: { ...owner, messageId: 'msg-4', toolCallId: `call-${index}` },
      backend: 'local',
      workspaceRoot: root,
      rootIdentity,
      cwd: root,
      locator: file,
      view: { kind: 'whole', numbering: 'none' },
      liveReadsOn: true
    },
    payload: {
      toolName: 'read_file',
      originalToolName: 'native_bash_execute',
      operationKind: 'read_file',
      toolCallId: `call-${index}`,
      toolArgs: { filePath: file, path: file, innerCommand: `cat ${file}` },
      toolResult: { filePath: file, content: 'old', lineCount: 1 }
    },
    metadata: { toolName: 'read_file', operationKind: 'read_file', promptTokens: 10 },
    // The names group sharing tests for this zip (messageCompiler `groupShareCandidatesOf`).
    toolCandidates: ['read_file', 'read_file']
  }
}

/** A stored typed read_file copy (SA-136), shaped as the zip adapter stores one. */
function typedCandidate(index: number, args: { path: string; offset?: number; limit?: number }): LiveReadCandidate {
  const base = candidate(index, args.path)
  const startLine = args.offset ?? 1
  return {
    ...base,
    source: { ...base.source, locator: args.path, view: { kind: 'typed', startLine, endLine: args.limit ? startLine + args.limit - 1 : null } },
    payload: {
      toolName: 'read_file',
      originalToolName: 'read_file',
      operationKind: 'read_file',
      toolCallId: `call-${index}`,
      toolArgs: { ...args },
      toolResult: { success: true, tool: 'read_file', path: args.path, filePath: args.path, content: 'old\n', lineCount: 1 }
    }
  }
}

/** A stored typed copy a sandbox ran: its Apple Container or Docker Sandbox mounts the host folder at the same path. */
function sandboxCandidate(index: number, backend: 'apple_container' | 'docker_sandbox', file = `src/s${index}.js`): LiveReadCandidate {
  const base = typedCandidate(index, { path: file })
  return { ...base, source: { ...base.source!, backend, liveReadsOn: true } }
}

/** The same stored copy, read by another agent of the chat. */
function readBy(base: LiveReadCandidate, agentId: string): LiveReadCandidate {
  return { ...base, source: { ...base.source!, owner: { ...base.source!.owner, agentId } } }
}

/**
 * What the route's `liveReadOtherReaders` answers: each allowed reader with its current execution
 * backend, and the group's sharing (`null`: no group, no sharing gate).
 */
function readersAre(readers: string[] | Record<string, string>, sharedTools: string[] | null = null): LiveReadOtherReaders {
  const entries = Array.isArray(readers) ? readers.map((id) => [id, 'local'] as const) : Object.entries(readers)
  return { readers: new Map(entries.map(([id, backend]) => [id, { backend }])), sharedTools }
}

/** The replay a pause would keep for this snapshot (never null in these tests unless they say so). */
function replayOf(
  snapshot: Parameters<typeof buildLiveFileReadReplay>[0],
  approvalIds: string[] = ['aitxt-1'],
  replyMessageIds?: string[],
  replayOwner: typeof owner = owner
) {
  const replay = buildLiveFileReadReplay(snapshot, replayOwner, new Date(Date.now() + 60_000), approvalIds, undefined, replyMessageIds)
  expect(replay).not.toBeNull()
  return replay!
}

function fakeOpener(texts: (locator: string) => string, calls = { opens: 0, reads: 0 }) {
  return {
    calls,
    openReader: async (): Promise<LiveReadReader> => {
      calls.opens += 1
      return {
        rootIdentity,
        readText: async (locator: string) => { calls.reads += 1; return texts(locator) },
        close: async () => {}
      }
    }
  }
}

function turn(extra: Partial<ConstructorParameters<typeof LiveFileReadTurn>[0]> = {}) {
  return new LiveFileReadTurn({ ...owner, executionBackend: 'local', projectPath: root, ...extra })
}

describe('LiveFileReadTurn', () => {
  it('reads on the first ask and gives every later ask the same frozen snapshot', async () => {
    const reader = fakeOpener((locator) => `text of ${locator}\n`)
    const liveTurn = turn({ openReader: reader.openReader })
    let asked = 0
    const candidates = async () => { asked += 1; return [candidate(1), candidate(2)] }
    const first = await liveTurn.snapshotFor('appended', candidates)
    const second = await liveTurn.snapshotFor('appended', candidates)
    expect(second).toBe(first)
    expect(asked).toBe(1)
    expect(reader.calls).toEqual({ opens: 1, reads: 2 })
    expect([...first.refreshed]).toEqual([candidate(2).zipId, candidate(1).zipId])
    const outcome = first.copies.get(candidate(1).zipId) as any
    expect(outcome.text).toContain('text of src/f1.js')
    // The label is the first line of the copy; the old trailing sentence is gone.
    expect(outcome.text.startsWith(`${liveReadLabel('src/f1.js', { kind: 'whole', numbering: 'none' })}\n`)).toBe(true)
    expect(outcome.text.startsWith('REFRESHED: src/f1.js, whole file (at the start of this turn)\n')).toBe(true)
    expect(outcome.text).not.toMatch(/Refreshed at the start of this turn from/)
    expect(outcome.parts[0]).toEqual({ source: 'agent_words', text: 'REFRESHED: src/f1.js, whole file (at the start of this turn)\n' })
    expect(outcome.parts.map((part: any) => part.text).join('')).toBe(outcome.text)
    expect(liveTurn.snapshot).toBe(first)
    // The appended layout is strict, and the turn's own reply is named so the compile never touches it.
    expect(first.strict).toBe(true)
    expect(first.replyMessageId).toBe('reply')
    expect(liveTurn.replyMessageId).toBe('reply')
    expect(Object.isFrozen(first)).toBe(true)
  })

  it('a read made while live reads were off, or one no transcript builder owns, stays static without any read', async () => {
    const reader = fakeOpener(() => 'x\n')
    const off = candidate(1)
    off.source = { ...off.source, liveReadsOn: false }
    const unknown = candidate(2)
    const { liveReadsOn: _on, ...unrecorded } = unknown.source
    unknown.source = unrecorded
    // A typed view on a call that is not the typed read_file, and a Bash view on the typed read_file.
    const otherTool = typedCandidate(3, { path: 'src/f3.js' })
    otherTool.payload = { ...otherTool.payload, originalToolName: 'mcp__files__read_file' }
    const bashViewOnTyped = candidate(4)
    bashViewOnTyped.payload = { ...bashViewOnTyped.payload, originalToolName: 'read_file' }
    const snapshot = await turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [off, unknown, otherTool, bashViewOnTyped])
    expect(snapshot.copies.get(off.zipId)).toEqual({ status: 'static', reason: 'read-while-off' })
    expect(snapshot.copies.get(unknown.zipId)).toEqual({ status: 'static', reason: 'read-while-off' })
    expect(snapshot.copies.get(otherTool.zipId)).toEqual({ status: 'static', reason: 'not-refreshable' })
    expect(snapshot.copies.get(bashViewOnTyped.zipId)).toEqual({ status: 'static', reason: 'not-refreshable' })
    expect(reader.calls.opens).toBe(0)
  })

  it('a copy with no valid descriptor for its message and author is a candidate with no source: static not-refreshable, no admission, no read', async () => {
    const reader = fakeOpener(() => 'x\n')
    const none = { ...candidate(1), source: null }
    const admit = vi.spyOn(liveReadSnapshot, 'admitLiveFileReads')
    try {
      const snapshot = await turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [none])
      expect(snapshot.copies.get(none.zipId)).toEqual({ status: 'static', reason: 'not-refreshable' })
      expect(snapshot.refreshed.size).toBe(0)
      expect(snapshot.strict).toBe(true)
      expect(admit).not.toHaveBeenCalled()
      expect(reader.calls).toEqual({ opens: 0, reads: 0 })
    } finally { admit.mockRestore() }
  })

  it('a typed read_file refreshes through the tool\'s own result, over its stored path, offset and limit', async () => {
    const file = Array.from({ length: 12 }, (_, i) => `new ${i + 1}`).join('\n') + '\n'
    const reader = fakeOpener(() => file)
    const whole = typedCandidate(1, { path: 'src/f1.js' })
    const range = typedCandidate(2, { path: 'src/f2.js', offset: 4, limit: 3 })
    const snapshot = await turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [whole, range])
    const wholeOut = snapshot.copies.get(whole.zipId) as any
    const rangeOut = snapshot.copies.get(range.zipId) as any
    expect(wholeOut.status).toBe('refreshed')
    expect(wholeOut.text).toContain('new 12')
    expect(rangeOut.status).toBe('refreshed')
    expect(rangeOut.text).toContain('new 4')
    expect(rangeOut.text).toContain('new 6')
    expect(rangeOut.text).not.toContain('new 7')
    expect(rangeOut.text).toContain('Lines: 4–6 of 12')
    expect(rangeOut.text.startsWith('REFRESHED: src/f2.js, lines 4-6 (at the start of this turn)\n')).toBe(true)
    expect(wholeOut.text.startsWith('REFRESHED: src/f1.js, from line 1 to the end (at the start of this turn)\n')).toBe(true)
    expect(reader.calls).toEqual({ opens: 1, reads: 2 })
  })

  it.each(['apple_container', 'docker_sandbox'] as const)('a %s-origin copy refreshes on a Mac through the host reader once the mount guard passes for the admitted root', async (backend) => {
    const copy = sandboxCandidate(1, backend, 'src/sb.js')
    const locators: string[] = []
    const reader = fakeOpener((locator) => { locators.push(locator); return 'fresh from the sandbox folder\n' })
    const snapshot = await withPlatform('darwin', () => turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [copy]))
    const outcome = snapshot.copies.get(copy.zipId) as any
    expect(outcome.status).toBe('refreshed')
    expect(outcome.text.startsWith(`${liveReadLabel('src/sb.js', { kind: 'typed', startLine: 1, endLine: null })}\n`)).toBe(true)
    expect(outcome.text).toContain('fresh from the sandbox folder')
    expect(sandboxMocks.assertSafe).toHaveBeenCalledTimes(1)
    expect(sandboxMocks.assertSafe).toHaveBeenCalledWith([root])
    expect(locators).toEqual(['src/sb.js'])
    expect(reader.calls).toEqual({ opens: 1, reads: 1 })
  })

  it('the mount guard is asked once for any number of sandbox copies, and never for Local copies', async () => {
    const reader = fakeOpener(() => 'x\n')
    const mixed = await withPlatform('darwin', () => turn({ openReader: reader.openReader })
      .snapshotFor('appended', async () => [candidate(1), sandboxCandidate(2, 'apple_container'), sandboxCandidate(3, 'docker_sandbox'), sandboxCandidate(4, 'apple_container')]))
    expect(mixed.refreshed.size).toBe(4)
    expect(sandboxMocks.assertSafe).toHaveBeenCalledTimes(1)
    sandboxMocks.assertSafe.mockClear()
    await withPlatform('darwin', () => turn({ openReader: fakeOpener(() => 'x\n').openReader }).snapshotFor('appended', async () => [candidate(1), typedCandidate(2, { path: 'src/f2.js' })]))
    expect(sandboxMocks.assertSafe).not.toHaveBeenCalled()
  })

  it('a sandbox-origin copy whose folder the sandbox guard refuses is static protected-root and unread; Local copies still refresh', async () => {
    sandboxMocks.assertSafe.mockRejectedValue(new Error('Sandbox workspace exposes managed agent homes or protected runtime/Pinokio data.'))
    const locators: string[] = []
    const reader = fakeOpener((locator) => { locators.push(locator); return 'x\n' })
    const local = candidate(1)
    const apple = sandboxCandidate(2, 'apple_container')
    const docker = sandboxCandidate(3, 'docker_sandbox')
    const snapshot = await withPlatform('darwin', () => turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [local, apple, docker]))
    expect(snapshot.copies.get(apple.zipId)).toEqual({ status: 'static', reason: 'protected-root' })
    expect(snapshot.copies.get(docker.zipId)).toEqual({ status: 'static', reason: 'protected-root' })
    expect(snapshot.copies.get(local.zipId)?.status).toBe('refreshed')
    expect([...snapshot.refreshed]).toEqual([local.zipId])
    expect(locators).toEqual(['src/f1.js'])
    expect(sandboxMocks.assertSafe).toHaveBeenCalledTimes(1)
    expect(snapshot.strict).toBe(true)
  })

  it('a sandbox-origin copy whose folder changed is root-changed before the mount guard is ever asked', async () => {
    const moved = sandboxCandidate(1, 'apple_container')
    moved.source = { ...moved.source!, workspaceRoot: path.join(root, 'elsewhere') }
    const reader = fakeOpener(() => 'x\n')
    const snapshot = await withPlatform('darwin', () => turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [moved]))
    expect(snapshot.copies.get(moved.zipId)).toEqual({ status: 'static', reason: 'root-changed' })
    expect(sandboxMocks.assertSafe).not.toHaveBeenCalled()
    expect(reader.calls).toEqual({ opens: 0, reads: 0 })
  })

  it('on Linux a sandbox-origin copy is source-backend-not-local with no read and no mount guard; a Local copy still refreshes', async () => {
    const locators: string[] = []
    const reader = fakeOpener((locator) => { locators.push(locator); return 'x\n' })
    const local = candidate(1)
    const apple = sandboxCandidate(2, 'apple_container')
    const docker = sandboxCandidate(3, 'docker_sandbox')
    const snapshot = await withPlatform('linux', () => turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [local, apple, docker]))
    expect(snapshot.copies.get(apple.zipId)).toEqual({ status: 'static', reason: 'source-backend-not-local' })
    expect(snapshot.copies.get(docker.zipId)).toEqual({ status: 'static', reason: 'source-backend-not-local' })
    expect(snapshot.copies.get(local.zipId)?.status).toBe('refreshed')
    expect(locators).toEqual(['src/f1.js'])
    expect(sandboxMocks.assertSafe).not.toHaveBeenCalled()
    // Only sandbox copies on Linux: nothing to read, no reader opened.
    const only = fakeOpener(() => 'x\n')
    const alone = await withPlatform('linux', () => turn({ openReader: only.openReader }).snapshotFor('appended', async () => [sandboxCandidate(4, 'docker_sandbox')]))
    expect(alone.copies.get(sandboxCandidate(4, 'docker_sandbox').zipId)).toEqual({ status: 'static', reason: 'source-backend-not-local' })
    expect(only.calls).toEqual({ opens: 0, reads: 0 })
  })

  it('a sandbox-origin copy read while the setting was off keeps the distinct read-while-off outcome without admission', async () => {
    const apple = sandboxCandidate(1, 'apple_container', 'src/apple-off.js')
    apple.source = { ...apple.source!, liveReadsOn: false }
    const admit = vi.spyOn(liveReadSnapshot, 'admitLiveFileReads')
    const reader = fakeOpener(() => 'must not read')
    try {
      const snapshot = await withPlatform('darwin', () => turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [apple]))
      expect(snapshot.copies.get(apple.zipId)).toEqual({ status: 'static', reason: 'read-while-off' })
      expect(admit).not.toHaveBeenCalled()
      expect(sandboxMocks.assertSafe).not.toHaveBeenCalled()
      expect(reader.calls).toEqual({ opens: 0, reads: 0 })
    } finally { admit.mockRestore() }
  })

  it('a resume replays a sandbox-origin copy\'s frozen bytes with no admission, no mount guard and no read', async () => {
    const apple = sandboxCandidate(1, 'apple_container', 'src/apple.js')
    const paused = await withPlatform('darwin', () => turn({ openReader: fakeOpener(() => 'frozen at the pause\n').openReader }).snapshotFor('appended', async () => [apple]))
    expect(paused.copies.get(apple.zipId)?.status).toBe('refreshed')
    const replay = readLiveFileReadReplay(JSON.parse(JSON.stringify(replayOf(paused, ['aitxt-apple']))), owner)!
    sandboxMocks.assertSafe.mockClear()
    const admit = vi.spyOn(liveReadSnapshot, 'admitLiveFileReads')
    const reader = fakeOpener(() => 'changed again\n')
    const candidates = vi.fn(async () => [apple])
    try {
      const resumed = await withPlatform('linux', () => turn({ replay, openReader: reader.openReader }).snapshotFor('appended', candidates))
      expect(resumed.copies.get(apple.zipId)).toEqual(paused.copies.get(apple.zipId))
      expect(candidates).not.toHaveBeenCalled()
      expect(admit).not.toHaveBeenCalled()
      expect(sandboxMocks.assertSafe).not.toHaveBeenCalled()
      expect(reader.calls).toEqual({ opens: 0, reads: 0 })
    } finally { admit.mockRestore() }
  })

  it('inside the app container nothing is read: every admitted-looking copy is static unsupported-platform, and the turn is still strict', async () => {
    const previous = process.env.BATSHIT_CONTAINERIZED
    process.env.BATSHIT_CONTAINERIZED = '1'
    try {
      const reader = fakeOpener(() => 'x\n')
      const copy = candidate(1)
      const snapshot = await turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [copy])
      expect(snapshot.copies.get(copy.zipId)).toEqual({ status: 'static', reason: 'unsupported-platform' })
      expect(snapshot.strict).toBe(true)
      expect(reader.calls).toEqual({ opens: 0, reads: 0 })
    } finally {
      if (previous === undefined) delete process.env.BATSHIT_CONTAINERIZED
      else process.env.BATSHIT_CONTAINERIZED = previous
    }
  })

  it('a typed read whose range no longer shows whole lines in full stays static: emulation-failed', async () => {
    // One line longer than read_file shows: a fresh read would be a cut, partial line (never proven).
    const reader = fakeOpener(() => 'y'.repeat(95_000) + '\n')
    const cut = typedCandidate(1, { path: 'src/f1.js' })
    const snapshot = await turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [cut])
    expect(snapshot.copies.get(cut.zipId)).toEqual({ status: 'static', reason: 'emulation-failed' })
  })

  it('labels every view with the file and its exact range, in one short line', () => {
    const label = (view: Parameters<typeof liveReadLabel>[1]) => liveReadLabel('a.js', view)
    const tail = '(at the start of this turn)'
    expect(label({ kind: 'whole', numbering: 'none' })).toBe(`REFRESHED: a.js, whole file ${tail}`)
    expect(label({ kind: 'whole', numbering: 'all' })).toBe(`REFRESHED: a.js, whole file, every line numbered ${tail}`)
    expect(label({ kind: 'whole', numbering: 'nonblank' })).toBe(`REFRESHED: a.js, whole file, non-blank lines numbered ${tail}`)
    expect(label({ kind: 'lines', script: '2,3p' })).toBe(`REFRESHED: a.js, lines 2-3 ${tail}`)
    expect(label({ kind: 'lines', script: '7p' })).toBe(`REFRESHED: a.js, lines 7 ${tail}`)
    expect(label({ kind: 'lines', script: '5,$p' })).toBe(`REFRESHED: a.js, lines 5-end ${tail}`)
    expect(label({ kind: 'lines', script: '1,2p;9,10p;' })).toBe(`REFRESHED: a.js, lines 1-2, 9-10 ${tail}`)
    expect(label({ kind: 'head', lines: 1 })).toBe(`REFRESHED: a.js, first 1 line ${tail}`)
    expect(label({ kind: 'head', lines: 20 })).toBe(`REFRESHED: a.js, first 20 lines ${tail}`)
    expect(label({ kind: 'tail', lines: 1 })).toBe(`REFRESHED: a.js, last 1 line ${tail}`)
    expect(label({ kind: 'tail', lines: 5 })).toBe(`REFRESHED: a.js, last 5 lines ${tail}`)
    expect(label({ kind: 'typed', startLine: 4, endLine: 9 })).toBe(`REFRESHED: a.js, lines 4-9 ${tail}`)
    expect(label({ kind: 'typed', startLine: 4, endLine: null })).toBe(`REFRESHED: a.js, from line 4 to the end ${tail}`)
    expect(label({ kind: 'typed', startLine: 1, endLine: null })).toBe(`REFRESHED: a.js, from line 1 to the end ${tail}`)
  })

  it('reads nothing in the inline layout: every copy is static inline-layout, the snapshot is not strict, and nothing is admitted or opened', async () => {
    const reader = fakeOpener(() => 'x\n')
    const admit = vi.spyOn(liveReadSnapshot, 'admitLiveFileReads')
    const otherReaders = vi.fn(async () => readersAre(['b']))
    try {
      const list = [candidate(1), readBy(candidate(2), 'b'), sandboxCandidate(3, 'apple_container'), { ...candidate(4), source: null }]
      const inline = await turn({ openReader: reader.openReader, otherReaders }).snapshotFor('inline', async () => list)
      for (const item of list) expect(inline.copies.get(item.zipId), item.zipId).toEqual({ status: 'static', reason: 'inline-layout' })
      expect(inline.strict).toBe(false)
      expect(inline.refreshed.size).toBe(0)
      expect(admit).not.toHaveBeenCalled()
      expect(otherReaders).not.toHaveBeenCalled()
      expect(sandboxMocks.assertSafe).not.toHaveBeenCalled()
      expect(reader.calls).toEqual({ opens: 0, reads: 0 })
    } finally { admit.mockRestore() }
  })

  it('an unusable replay in the inline layout is still inline-layout: it refreshes nothing and hides nothing', async () => {
    const snapshot = await turn({ replayUnavailable: 'replay-expired' }).snapshotFor('inline', async () => [candidate(1)])
    expect(snapshot.copies.get(candidate(1).zipId)).toEqual({ status: 'static', reason: 'inline-layout' })
    expect(snapshot.strict).toBe(false)
  })

  it.each([
    { executionBackend: 'apple_container', platform: 'darwin', reads: true },
    { executionBackend: 'docker_sandbox', platform: 'darwin', reads: true },
    { executionBackend: 'local', platform: 'darwin', reads: true },
    { executionBackend: 'local', platform: 'linux', reads: true },
    { executionBackend: 'apple_container', platform: 'linux', reads: false },
    { executionBackend: 'docker_sandbox', platform: 'linux', reads: false },
    { executionBackend: 'docker', platform: 'darwin', reads: false },
    { executionBackend: 'remote', platform: 'linux', reads: false }
  ])('the turn\'s $executionBackend execution backend on $platform: reads through the host reader is $reads', async ({ executionBackend, platform, reads }) => {
    const reader = fakeOpener(() => 'x\n')
    const copy = candidate(1)
    const snapshot = await withPlatform(platform, () => turn({ openReader: reader.openReader, executionBackend }).snapshotFor('appended', async () => [copy]))
    if (reads) {
      expect(snapshot.copies.get(copy.zipId)?.status).toBe('refreshed')
      expect(reader.calls).toEqual({ opens: 1, reads: 1 })
    } else {
      expect(snapshot.copies.get(copy.zipId)).toEqual({ status: 'static', reason: 'backend-not-local' })
      expect(reader.calls).toEqual({ opens: 0, reads: 0 })
      expect(snapshot.strict).toBe(true)
    }
  })

  it('reads at most the newest copies the bound allows; older ones stay as printed', async () => {
    const reader = fakeOpener(() => 'x\n')
    const list = Array.from({ length: LIVE_READ_MAX_CANDIDATES + 2 }, (_, index) => candidate(index))
    const snapshot = await turn({ openReader: reader.openReader }).snapshotFor('appended', async () => list)
    expect(snapshot.copies.get(list[0].zipId)).toEqual({ status: 'static', reason: 'too-many-copies' })
    expect(snapshot.copies.get(list[1].zipId)).toEqual({ status: 'static', reason: 'too-many-copies' })
    expect(snapshot.refreshed.size).toBe(LIVE_READ_MAX_CANDIDATES)
    expect(reader.calls.reads).toBe(LIVE_READ_MAX_CANDIDATES)
  })

  it('a replay too large for the paused record drops its largest copies from the replay only: this turn keeps every copy, and the small ones stay in the replay (review M2)', async () => {
    const reader = fakeOpener((locator) => locator === 'src/small.js' ? 'tiny\n' : 'y'.repeat(90_000) + '\n')
    const big = Array.from({ length: 12 }, (_, index) => candidate(index))
    const small = candidate(20, 'src/small.js')
    const snapshot = await turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [...big, small])
    // The turn itself shows all of them: the cap no longer changes it.
    expect(snapshot.refreshed.size).toBe(13)
    for (const item of [...big, small]) expect(snapshot.copies.get(item.zipId)?.status, item.zipId).toBe('refreshed')

    const replay = replayOf(snapshot)
    expect(liveFileReadReplayBytes(replay)).toBeLessThanOrEqual(LIVE_READ_REPLAY_MAX_BYTES)
    const dropped = replay.copies.filter((copy) => copy.status === 'static')
    // Twelve of 90,000 characters do not fit and eleven do: exactly one large copy left, the small one stayed.
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toMatchObject({ status: 'static', reason: 'replay-capacity' })
    expect(big.map((item) => item.zipId)).toContain(dropped[0].zipId)
    expect(replay.copies.find((copy) => copy.zipId === small.zipId)).toMatchObject({ status: 'refreshed' })
    // The snapshot itself was not rewritten.
    expect(snapshot.copies.get(dropped[0].zipId)?.status).toBe('refreshed')
    // And the resume reads the replay back whole.
    expect(readLiveFileReadReplay(JSON.parse(JSON.stringify(replay)), owner)?.copies).toHaveLength(13)
  })

  it('a replay that fits is kept exactly as the snapshot has it; with eleven large copies none leaves', async () => {
    const reader = fakeOpener(() => 'y'.repeat(90_000) + '\n')
    const list = Array.from({ length: 11 }, (_, index) => candidate(index))
    const fits = await turn({ openReader: reader.openReader }).snapshotFor('appended', async () => list)
    const replay = replayOf(fits)
    expect(replay.copies.every((copy) => copy.status === 'refreshed')).toBe(true)
    expect(liveFileReadReplayBytes(replay)).toBeLessThanOrEqual(LIVE_READ_REPLAY_MAX_BYTES)
  })

  it('a replay where even the statics do not fit is none: null, so the pause keeps no snapshot', async () => {
    // 12,000 candidates that cannot refresh are 12,000 static lines of the replay, past 1 MiB by themselves.
    const list = Array.from({ length: 12_000 }, (_, index) => ({ ...candidate(index), source: null }))
    const snapshot = await turn({ openReader: fakeOpener(() => 'x\n').openReader }).snapshotFor('appended', async () => list)
    expect(snapshot.copies.size).toBe(12_000)
    expect(buildLiveFileReadReplay(snapshot, owner, new Date(Date.now() + 60_000), ['aitxt-1'])).toBeNull()
  })

  it('a copy whose transcript cannot be rebuilt after its read stays static: emulation-failed', async () => {
    const reader = fakeOpener(() => 'x\n')
    const noCommand = candidate(1)
    noCommand.payload = { ...noCommand.payload, toolArgs: { filePath: 'src/f1.js', path: 'src/f1.js' } }
    const snapshot = await turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [noCommand])
    expect(snapshot.copies.get(noCommand.zipId)).toEqual({ status: 'static', reason: 'emulation-failed' })
  })

  it('past the compile\'s 8 MiB hold the older copies stay static: refresh-memory', async () => {
    const reader = fakeOpener(() => 'z'.repeat(119_000) + '\n')
    const list = Array.from({ length: 40 }, (_, index) => candidate(index))
    const snapshot = await turn({ openReader: reader.openReader }).snapshotFor('appended', async () => list)
    // The newest are read first; the oldest find the hold full. (Each is too large to open, so its
    // replay keeps only its size and the snapshot still fits 1 MiB.)
    expect(snapshot.copies.get(list[0].zipId)).toEqual({ status: 'static', reason: 'refresh-memory' })
    expect(snapshot.copies.get(list[39].zipId)?.status).toBe('refreshed')
  })

  it('a copy too large to open keeps only its size in the replay, and resumes as that size', async () => {
    const reader = fakeOpener(() => 'w'.repeat(110_000) + '\n')
    const paused = await turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [candidate(1)])
    const outcome = paused.copies.get(candidate(1).zipId) as any
    expect(outcome.status).toBe('refreshed')
    expect(outcome.promptTokens).toBeGreaterThanOrEqual(25_000)
    const stored = JSON.parse(JSON.stringify(replayOf(paused)))
    expect(stored.copies[0]).toEqual({ zipId: candidate(1).zipId, status: 'refreshed', promptTokens: outcome.promptTokens })
    const resumed = await turn({ replay: readLiveFileReadReplay(stored, owner) }).snapshotFor('appended', async () => [candidate(1)])
    expect(resumed.copies.get(candidate(1).zipId)).toEqual({ status: 'refreshed', text: '', parts: [], promptTokens: outcome.promptTokens })
  })

  it('a resume rebuilds the snapshot from its replay with no read', async () => {
    const reader = fakeOpener(() => 'today\n')
    const paused = await turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [candidate(1)])
    const replay = readLiveFileReadReplay(JSON.parse(JSON.stringify(replayOf(paused))), owner)
    const resumedReader = fakeOpener(() => 'changed again\n')
    const resumed = await turn({ openReader: resumedReader.openReader, replay }).snapshotFor('appended', async () => [candidate(1)])
    expect(resumedReader.calls.opens).toBe(0)
    expect(resumed.compileId).toBe(paused.compileId)
    expect(resumed.copies.get(candidate(1).zipId)).toEqual(paused.copies.get(candidate(1).zipId))
  })
})

describe('another member\'s copy (Round 2, R2-4)', () => {
  const allowing = (...ids: string[]) => vi.fn(async (_asked: readonly string[]) => readersAre(ids))

  it('refreshes under its original reader when the turn confirms that reader before the reads and again after them', async () => {
    const events: string[] = []
    const otherReaders = vi.fn(async (asked: readonly string[]) => { events.push(`ask:${asked.join(',')}`); return readersAre(['b']) })
    const openReader = async (): Promise<LiveReadReader> => {
      events.push('open')
      return {
        rootIdentity,
        readText: async (locator: string) => { events.push(`read:${locator}`); return `today ${locator}\n` },
        close: async () => { events.push('close') }
      }
    }
    const theirs = readBy(candidate(1), 'b')
    const own = candidate(2)
    const snapshot = await turn({ openReader, otherReaders }).snapshotFor('appended', async () => [theirs, own])
    expect(events).toEqual(['ask:b', 'open', 'read:src/f2.js', 'read:src/f1.js', 'close', 'ask:b'])
    expect(otherReaders).toHaveBeenCalledTimes(2)
    const outcome = snapshot.copies.get(theirs.zipId) as any
    expect(outcome.status).toBe('refreshed')
    expect(outcome.text.startsWith('REFRESHED: src/f1.js, whole file (at the start of this turn)\n')).toBe(true)
    expect(outcome.text).toContain('today src/f1.js')
    expect(snapshot.copies.get(own.zipId)?.status).toBe('refreshed')
  })

  it('asks nothing for the agent\'s own copies', async () => {
    const otherReaders = allowing('b')
    const snapshot = await turn({ openReader: fakeOpener(() => 'x\n').openReader, otherReaders }).snapshotFor('appended', async () => [candidate(1), candidate(2)])
    expect(snapshot.refreshed.size).toBe(2)
    expect(otherReaders).not.toHaveBeenCalled()
  })

  it('asks each other reader once, in the order met, however many copies it read', async () => {
    const otherReaders = allowing('b', 'c')
    const list = [readBy(candidate(1), 'b'), readBy(candidate(2), 'c'), readBy(candidate(3), 'b'), candidate(4)]
    const snapshot = await turn({ openReader: fakeOpener(() => 'x\n').openReader, otherReaders }).snapshotFor('appended', async () => list)
    expect(snapshot.refreshed.size).toBe(4)
    expect(otherReaders.mock.calls[0][0]).toEqual(['b', 'c'])
  })

  it('a reader the turn does not confirm is static reader-gone and its file is not read; the agent\'s own copy still refreshes', async () => {
    const locators: string[] = []
    const reader = fakeOpener((locator) => { locators.push(locator); return 'x\n' })
    const otherReaders = allowing()
    const theirs = readBy(candidate(1), 'b')
    const own = candidate(2)
    const snapshot = await turn({ openReader: reader.openReader, otherReaders }).snapshotFor('appended', async () => [theirs, own])
    expect(snapshot.copies.get(theirs.zipId)).toEqual({ status: 'static', reason: 'reader-gone' })
    expect(snapshot.copies.get(own.zipId)?.status).toBe('refreshed')
    expect(locators).toEqual(['src/f2.js'])
    // Nothing of theirs was left to read, so there is nothing to ask again.
    expect(otherReaders).toHaveBeenCalledTimes(1)
  })

  it('with no way to ask, another member\'s copy is reader-gone and nothing of it is read', async () => {
    const reader = fakeOpener(() => 'x\n')
    const theirs = readBy(candidate(1), 'b')
    const snapshot = await turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [theirs])
    expect(snapshot.copies.get(theirs.zipId)).toEqual({ status: 'static', reason: 'reader-gone' })
    expect(reader.calls).toEqual({ opens: 0, reads: 0 })
    expect(snapshot.strict).toBe(true)
  })

  it('confirms one reader and not another: only the confirmed reader\'s copy refreshes', async () => {
    const reader = fakeOpener(() => 'x\n')
    const keep = readBy(candidate(1), 'b')
    const drop = readBy(candidate(2), 'c')
    const snapshot = await turn({ openReader: reader.openReader, otherReaders: allowing('b') }).snapshotFor('appended', async () => [keep, drop])
    expect(snapshot.copies.get(keep.zipId)?.status).toBe('refreshed')
    expect(snapshot.copies.get(drop.zipId)).toEqual({ status: 'static', reason: 'reader-gone' })
  })

  it('a reader dropped while the files were being read leaves its copy static sharing-changed: the bytes read are never shown', async () => {
    const otherReaders = vi.fn()
      .mockResolvedValueOnce(readersAre(['b']))
      .mockResolvedValueOnce(readersAre([]))
    const reader = fakeOpener((locator) => locator === 'src/f1.js' ? 'THEIR-FILE-BYTES\n' : 'own file bytes\n')
    const theirs = readBy(candidate(1), 'b')
    const own = candidate(2)
    const snapshot = await turn({ openReader: reader.openReader, otherReaders }).snapshotFor('appended', async () => [theirs, own])
    expect(otherReaders).toHaveBeenCalledTimes(2)
    expect(reader.calls.reads).toBe(2)
    expect(snapshot.copies.get(theirs.zipId)).toEqual({ status: 'static', reason: 'sharing-changed' })
    expect(snapshot.copies.get(own.zipId)?.status).toBe('refreshed')
    expect(JSON.stringify([...snapshot.copies.values()])).not.toContain('THEIR-FILE-BYTES')
    expect(JSON.stringify(replayOf(snapshot))).not.toContain('THEIR-FILE-BYTES')
    expect([...snapshot.refreshed]).toEqual([own.zipId])
  })

  it('reads another member\'s file only under the same admitted root: a different folder or directory is root-changed even for an allowed reader', async () => {
    const reader = fakeOpener(() => 'x\n')
    const moved = readBy(candidate(1), 'b')
    moved.source = { ...moved.source!, workspaceRoot: path.join(root, 'elsewhere') }
    const recreated = readBy(candidate(2), 'b')
    recreated.source = { ...recreated.source!, rootIdentity: '1:3' }
    const snapshot = await turn({ openReader: reader.openReader, otherReaders: allowing('b') }).snapshotFor('appended', async () => [moved, recreated])
    expect(snapshot.copies.get(moved.zipId)).toEqual({ status: 'static', reason: 'root-changed' })
    expect(snapshot.copies.get(recreated.zipId)).toEqual({ status: 'static', reason: 'root-changed' })
    expect(reader.calls).toEqual({ opens: 0, reads: 0 })
  })

  it('never refreshes another chat\'s or another user\'s copy, whoever the reader is', async () => {
    const reader = fakeOpener(() => 'x\n')
    const otherChat = readBy(candidate(1), 'b')
    otherChat.source = { ...otherChat.source!, owner: { ...otherChat.source!.owner, sessionId: 'other-chat' } }
    const otherUser = candidate(2)
    otherUser.source = { ...otherUser.source!, owner: { ...otherUser.source!.owner, userId: 'other-user' } }
    const snapshot = await turn({ openReader: reader.openReader, otherReaders: allowing('b', 'a') }).snapshotFor('appended', async () => [otherChat, otherUser])
    expect(snapshot.copies.get(otherChat.zipId)).toEqual({ status: 'static', reason: 'other-actor' })
    expect(snapshot.copies.get(otherUser.zipId)).toEqual({ status: 'static', reason: 'other-actor' })
    expect(reader.calls).toEqual({ opens: 0, reads: 0 })
  })

  it('a sandbox-origin copy by another member needs both the confirmed reader and the sandbox guard', async () => {
    const reader = fakeOpener(() => 'x\n')
    const theirs = readBy(sandboxCandidate(1, 'docker_sandbox'), 'b')
    const ok = await withPlatform('darwin', () => turn({ openReader: reader.openReader, otherReaders: allowing('b') }).snapshotFor('appended', async () => [theirs]))
    expect(ok.copies.get(theirs.zipId)?.status).toBe('refreshed')
    sandboxMocks.assertSafe.mockRejectedValue(new Error('closed'))
    const closed = await withPlatform('darwin', () => turn({ openReader: reader.openReader, otherReaders: allowing('b') }).snapshotFor('appended', async () => [theirs]))
    expect(closed.copies.get(theirs.zipId)).toEqual({ status: 'static', reason: 'protected-root' })
    const gone = await withPlatform('darwin', () => turn({ openReader: reader.openReader, otherReaders: allowing() }).snapshotFor('appended', async () => [theirs]))
    expect(gone.copies.get(theirs.zipId)).toEqual({ status: 'static', reason: 'reader-gone' })
  })

  it('a resume replays the pause\'s decisions about another member\'s copies and asks nothing', async () => {
    const kept = readBy(candidate(1), 'b')
    const dropped = readBy(candidate(2), 'c')
    const paused = await turn({ openReader: fakeOpener(() => 'frozen\n').openReader, otherReaders: allowing('b') }).snapshotFor('appended', async () => [kept, dropped])
    const replay = readLiveFileReadReplay(JSON.parse(JSON.stringify(replayOf(paused))), owner)!
    const otherReaders = allowing('c')
    const reader = fakeOpener(() => 'changed\n')
    const resumed = await turn({ replay, openReader: reader.openReader, otherReaders }).snapshotFor('appended', async () => [kept, dropped])
    expect(resumed.copies.get(kept.zipId)).toEqual(paused.copies.get(kept.zipId))
    expect(resumed.copies.get(dropped.zipId)).toEqual({ status: 'static', reason: 'reader-gone' })
    expect(otherReaders).not.toHaveBeenCalled()
    expect(reader.calls).toEqual({ opens: 0, reads: 0 })
  })
})

describe('another member\'s copy: per-copy group sharing and the reader\'s current backend (security review)', () => {
  const answering = (...answers: LiveReadOtherReaders[]) => {
    const queue = [...answers]
    return vi.fn(async (_asked: readonly string[]) => queue.shift() ?? readersAre([]))
  }

  it('tests each copy with the compile\'s own sharing rule: a group sharing read_file shows a Read File copy, one sharing only other tools does not', async () => {
    const reader = fakeOpener(() => 'x\n')
    const theirs = readBy(candidate(1), 'b')
    const shared = await turn({ openReader: reader.openReader, otherReaders: answering(readersAre(['b'], ['read_file']), readersAre(['b'], ['read_file'])) })
      .snapshotFor('appended', async () => [theirs])
    expect(shared.copies.get(theirs.zipId)?.status).toBe('refreshed')

    const unshared = fakeOpener(() => 'x\n')
    for (const sharedTools of [[], ['bash'], ['write_file', 'edit_file']]) {
      const snapshot = await turn({ openReader: unshared.openReader, otherReaders: async () => readersAre(['b'], sharedTools) })
        .snapshotFor('appended', async () => [theirs])
      expect(snapshot.copies.get(theirs.zipId), JSON.stringify(sharedTools)).toEqual({ status: 'static', reason: 'reader-gone' })
    }
    expect(unshared.calls).toEqual({ opens: 0, reads: 0 })
  })

  it('tests every copy on its own names: of one reader\'s two copies the group shares only the one whose tool it shares', async () => {
    const reader = fakeOpener(() => 'x\n')
    const read = readBy(candidate(1), 'b')
    const other = readBy(candidate(2), 'b')
    other.toolCandidates = ['write_file', 'write_file']
    const snapshot = await turn({ openReader: reader.openReader, otherReaders: async () => readersAre(['b'], ['read_file']) })
      .snapshotFor('appended', async () => [read, other])
    expect(snapshot.copies.get(read.zipId)?.status).toBe('refreshed')
    expect(snapshot.copies.get(other.zipId)).toEqual({ status: 'static', reason: 'reader-gone' })
    expect(reader.calls).toEqual({ opens: 1, reads: 1 })
  })

  it('no group (sharedTools null) has no sharing gate; the agent\'s own copy never needs one', async () => {
    const reader = fakeOpener(() => 'x\n')
    const theirs = readBy(candidate(1), 'b')
    theirs.toolCandidates = undefined
    const own = candidate(2)
    const open = await turn({ openReader: reader.openReader, otherReaders: async () => readersAre(['b'], null) })
      .snapshotFor('appended', async () => [theirs, own])
    expect(open.refreshed.size).toBe(2)
    // In a group that shares nothing, the other member's copy is out and the agent\'s own is still its own.
    const group = await turn({ openReader: fakeOpener(() => 'x\n').openReader, otherReaders: async () => readersAre(['b'], []) })
      .snapshotFor('appended', async () => [theirs, own])
    expect(group.copies.get(theirs.zipId)).toEqual({ status: 'static', reason: 'reader-gone' })
    expect(group.copies.get(own.zipId)?.status).toBe('refreshed')
  })

  it('a copy whose group sharing stopped showing it while the files were being read is sharing-changed, and its bytes are never kept', async () => {
    const reader = fakeOpener((locator) => locator === 'src/f1.js' ? 'THEIR-SHARED-BYTES\n' : 'own\n')
    const theirs = readBy(candidate(1), 'b')
    const own = candidate(2)
    const otherReaders = answering(readersAre(['b'], ['read_file']), readersAre(['b'], ['bash']))
    const snapshot = await turn({ openReader: reader.openReader, otherReaders }).snapshotFor('appended', async () => [theirs, own])
    expect(otherReaders).toHaveBeenCalledTimes(2)
    expect(snapshot.copies.get(theirs.zipId)).toEqual({ status: 'static', reason: 'sharing-changed' })
    expect(snapshot.copies.get(own.zipId)?.status).toBe('refreshed')
    expect(JSON.stringify([...snapshot.copies.values()])).not.toContain('THEIR-SHARED-BYTES')
  })

  it('a reader whose backend changed between the two asks is sharing-changed, in either direction, and the mount guard is not asked again', async () => {
    for (const changed of ['apple_container', 'docker_sandbox'] as const) {
      sandboxMocks.assertSafe.mockClear()
      const reader = fakeOpener(() => 'BACKEND-CHANGED-BYTES\n')
      const theirs = readBy(candidate(1), 'b')
      const snapshot = await withPlatform('darwin', () => turn({
        openReader: reader.openReader,
        otherReaders: answering(readersAre({ b: 'local' }), readersAre({ b: changed }))
      }).snapshotFor('appended', async () => [theirs]))
      expect(snapshot.copies.get(theirs.zipId), changed).toEqual({ status: 'static', reason: 'sharing-changed' })
      expect(JSON.stringify([...snapshot.copies.values()])).not.toContain('BACKEND-CHANGED-BYTES')
      // The guard runs for the first answer only (it saw an all-local turn, so it never ran).
      expect(sandboxMocks.assertSafe).not.toHaveBeenCalled()
    }
    // Sandbox then local is a change too.
    const back = readBy(candidate(2), 'b')
    const reverse = await withPlatform('darwin', () => turn({
      openReader: fakeOpener(() => 'x\n').openReader,
      otherReaders: answering(readersAre({ b: 'docker_sandbox' }), readersAre({ b: 'local' }))
    }).snapshotFor('appended', async () => [back]))
    expect(reverse.copies.get(back.zipId)).toEqual({ status: 'static', reason: 'sharing-changed' })
  })

  it('an unchanged backend after the reads keeps the refresh', async () => {
    const theirs = readBy(candidate(1), 'b')
    const snapshot = await withPlatform('darwin', () => turn({
      openReader: fakeOpener(() => 'x\n').openReader,
      otherReaders: answering(readersAre({ b: 'docker_sandbox' }), readersAre({ b: 'docker_sandbox' }))
    }).snapshotFor('appended', async () => [theirs]))
    expect(snapshot.copies.get(theirs.zipId)?.status).toBe('refreshed')
  })
})

describe('the protected-root guard runs whenever any sandbox is in play (security review M1)', () => {
  const throwing = () => sandboxMocks.assertSafe.mockRejectedValue(new Error('Sandbox workspace exposes managed agent homes or protected runtime/Pinokio data.'))

  it.each(['apple_container', 'docker_sandbox'] as const)('a Local-origin copy on a %s turn is guarded: protected-root when the guard refuses the folder, refreshed when it passes', async (executionBackend) => {
    const copy = candidate(1)
    const passes = await withPlatform('darwin', () => turn({ openReader: fakeOpener(() => 'x\n').openReader, executionBackend }).snapshotFor('appended', async () => [copy]))
    expect(passes.copies.get(copy.zipId)?.status).toBe('refreshed')
    expect(sandboxMocks.assertSafe).toHaveBeenCalledTimes(1)
    expect(sandboxMocks.assertSafe).toHaveBeenCalledWith([root])

    throwing()
    const reader = fakeOpener(() => 'x\n')
    const refused = await withPlatform('darwin', () => turn({ openReader: reader.openReader, executionBackend }).snapshotFor('appended', async () => [copy]))
    expect(refused.copies.get(copy.zipId)).toEqual({ status: 'static', reason: 'protected-root' })
    expect(reader.calls).toEqual({ opens: 0, reads: 0 })
  })

  it('a Local-origin copy of another reader whose current backend is a sandbox is guarded on a Local turn', async () => {
    throwing()
    const reader = fakeOpener(() => 'x\n')
    const theirs = readBy(candidate(1), 'b')
    const own = candidate(2)
    const snapshot = await withPlatform('darwin', () => turn({
      openReader: reader.openReader,
      otherReaders: async () => readersAre({ b: 'docker_sandbox' })
    }).snapshotFor('appended', async () => [theirs, own]))
    expect(snapshot.copies.get(theirs.zipId)).toEqual({ status: 'static', reason: 'protected-root' })
    // The agent's own all-local copy on the Local turn needs no guard.
    expect(snapshot.copies.get(own.zipId)?.status).toBe('refreshed')
    expect(sandboxMocks.assertSafe).toHaveBeenCalledTimes(1)
    expect(reader.calls).toEqual({ opens: 1, reads: 1 })
  })

  it('all Local (the turn, the copy and the other reader) never asks the guard', async () => {
    throwing()
    const theirs = readBy(candidate(1), 'b')
    const own = candidate(2)
    const snapshot = await withPlatform('darwin', () => turn({
      openReader: fakeOpener(() => 'x\n').openReader,
      otherReaders: async () => readersAre({ b: 'local' })
    }).snapshotFor('appended', async () => [theirs, own]))
    expect(snapshot.refreshed.size).toBe(2)
    expect(sandboxMocks.assertSafe).not.toHaveBeenCalled()
  })

  it('a sandbox-origin copy of a Local-backend reader on a Local turn is still guarded (the copy\'s own origin counts)', async () => {
    throwing()
    const theirs = readBy(sandboxCandidate(1, 'apple_container'), 'b')
    const snapshot = await withPlatform('darwin', () => turn({
      openReader: fakeOpener(() => 'x\n').openReader,
      otherReaders: async () => readersAre({ b: 'local' })
    }).snapshotFor('appended', async () => [theirs]))
    expect(snapshot.copies.get(theirs.zipId)).toEqual({ status: 'static', reason: 'protected-root' })
  })

  it('a refusal for another reason wins before the guard is asked', async () => {
    throwing()
    const gone = readBy(candidate(1), 'b')
    const moved = candidate(2)
    moved.source = { ...moved.source!, workspaceRoot: path.join(root, 'elsewhere') }
    const snapshot = await withPlatform('darwin', () => turn({
      openReader: fakeOpener(() => 'x\n').openReader,
      executionBackend: 'apple_container',
      otherReaders: async () => readersAre([])
    }).snapshotFor('appended', async () => [gone, moved]))
    expect(snapshot.copies.get(gone.zipId)).toEqual({ status: 'static', reason: 'reader-gone' })
    expect(snapshot.copies.get(moved.zipId)).toEqual({ status: 'static', reason: 'root-changed' })
    expect(sandboxMocks.assertSafe).not.toHaveBeenCalled()
  })
})

describe('strict freshness and the turn\'s own reply in the snapshot', () => {
  it('a built snapshot is strict in the appended layout and names the turn\'s reply; the inline layout is not strict', async () => {
    const reader = fakeOpener(() => 'x\n')
    const appended = await turn({ openReader: reader.openReader, messageId: 'reply-9' }).snapshotFor('appended', async () => [candidate(1)])
    expect(appended).toMatchObject({ strict: true, replyMessageId: 'reply-9', version: 1 })
    const inline = await turn({ messageId: 'reply-9' }).snapshotFor('inline', async () => [candidate(1)])
    expect(inline).toMatchObject({ strict: false, replyMessageId: 'reply-9' })
  })

  it('a resume\'s snapshot is strict by the layout it compiles in, and keeps the paused compile\'s id and the reply', async () => {
    const paused = await turn({ openReader: fakeOpener(() => 'x\n').openReader }).snapshotFor('appended', async () => [candidate(1)])
    const replay = readLiveFileReadReplay(JSON.parse(JSON.stringify(replayOf(paused))), owner)!
    const resumed = await turn({ replay }).snapshotFor('appended', async () => [])
    expect(resumed).toMatchObject({ strict: true, replyMessageId: 'reply', compileId: paused.compileId })
    // A resume that switched to the inline layout keeps today's rules.
    const inlineResume = await turn({ replay }).snapshotFor('inline', async () => [])
    expect(inlineResume.strict).toBe(false)
  })

  it.each(['replay-missing', 'replay-expired', 'replay-unverifiable'] as const)('an unusable replay (%s) reads nothing and hides every candidate with that reason, whoever read it', async (reason) => {
    const reader = fakeOpener(() => 'new\n')
    const admit = vi.spyOn(liveReadSnapshot, 'admitLiveFileReads')
    const otherReaders = vi.fn(async () => readersAre(['b']))
    try {
      const list = [candidate(1), readBy(candidate(2), 'b'), sandboxCandidate(3, 'apple_container'), { ...candidate(4), source: null }]
      const resumed = turn({ openReader: reader.openReader, replayUnavailable: reason, otherReaders })
      const snapshot = await withPlatform('darwin', () => resumed.snapshotFor('appended', async () => list))
      for (const item of list) expect(snapshot.copies.get(item.zipId), item.zipId).toEqual({ status: 'static', reason })
      expect(snapshot.refreshed.size).toBe(0)
      expect(snapshot.strict).toBe(true)
      expect(resumed.replayUnavailable).toBe(reason)
      expect(admit).not.toHaveBeenCalled()
      expect(otherReaders).not.toHaveBeenCalled()
      expect(sandboxMocks.assertSafe).not.toHaveBeenCalled()
      expect(reader.calls).toEqual({ opens: 0, reads: 0 })
    } finally { admit.mockRestore() }
  })

  it('a replay names only the copies the pause showed: a copy it does not name stays out of the snapshot, so the compile hides it', async () => {
    const paused = await turn({ openReader: fakeOpener(() => 'x\n').openReader }).snapshotFor('appended', async () => [candidate(1)])
    const replay = readLiveFileReadReplay(JSON.parse(JSON.stringify(replayOf(paused))), owner)!
    const resumed = await turn({ replay }).snapshotFor('appended', async () => [candidate(1), candidate(2)])
    expect(resumed.copies.has(candidate(1).zipId)).toBe(true)
    expect(resumed.copies.has(candidate(2).zipId)).toBe(false)
  })
})

describe('the reply\'s parts (review M1) and the replay it keeps (review M2)', () => {
  const sealedWith = async (extra: Record<string, unknown>) => {
    const snapshot = await turn({ openReader: fakeOpener(() => 'x\n').openReader }).snapshotFor('appended', async () => [candidate(1)])
    const { seal: _seal, ...value } = JSON.parse(JSON.stringify(replayOf(snapshot)))
    return sealLiveFileReadReplay({ ...value, ...extra })
  }

  it('a turn\'s reply starts as its own message and grows with each continuation; the view is live', () => {
    const live = turn()
    const view = live.replyMessageIds
    expect([...view]).toEqual(['reply'])
    expect(live.replyMessageId).toBe('reply')
    live.continueAs('reply-2')
    live.continueAs('reply-3')
    live.continueAs('reply-2')
    expect([...live.replyMessageIds]).toEqual(['reply', 'reply-2', 'reply-3'])
    // The same set a compile already holds sees the new part (it is read live, after the snapshot froze).
    expect([...view]).toEqual(['reply', 'reply-2', 'reply-3'])
    // The first id never changes.
    expect(live.replyMessageId).toBe('reply')
  })

  it('a continuation reuses the frozen snapshot: no second read, no new candidates', async () => {
    const reader = fakeOpener(() => 'x\n')
    const live = turn({ openReader: reader.openReader })
    const first = await live.snapshotFor('appended', async () => [candidate(1)])
    live.continueAs('reply-2')
    const candidates = vi.fn(async () => [candidate(1), candidate(2)])
    const again = await live.snapshotFor('appended', candidates)
    expect(again).toBe(first)
    expect(candidates).not.toHaveBeenCalled()
    expect(reader.calls).toEqual({ opens: 1, reads: 1 })
    expect(again.copies.has(candidate(2).zipId)).toBe(false)
  })

  it('the replay carries the reply\'s parts through the seal, and a resumed turn\'s parts include them with its own message', async () => {
    const paused = await turn({ openReader: fakeOpener(() => 'x\n').openReader }).snapshotFor('appended', async () => [candidate(1)])
    const replay = replayOf(paused, ['aitxt-1'], ['reply', 'reply-part-2'])
    expect(replay.replyMessageIds).toEqual(['reply', 'reply-part-2'])
    const stored = readLiveFileReadReplay(JSON.parse(JSON.stringify(replay)), owner)!
    expect(stored.replyMessageIds).toEqual(['reply', 'reply-part-2'])
    const resumed = turn({ replay: stored })
    expect([...resumed.replyMessageIds].sort()).toEqual(['reply', 'reply-part-2'])
    // A replay without parts (an older pause) leaves just the resumed message.
    expect([...turn({ replay: readLiveFileReadReplay(JSON.parse(JSON.stringify(replayOf(paused))), owner)! }).replyMessageIds]).toEqual(['reply'])
    // The resumed reply can continue again.
    resumed.continueAs('reply-part-3')
    expect([...resumed.replyMessageIds].sort()).toEqual(['reply', 'reply-part-2', 'reply-part-3'])
  })

  it('a changed list of parts breaks the seal: the replay is unverifiable, never used', async () => {
    const paused = await turn({ openReader: fakeOpener(() => 'x\n').openReader }).snapshotFor('appended', async () => [candidate(1)])
    const stored = JSON.parse(JSON.stringify(replayOf(paused, ['aitxt-1'], ['reply'])))
    expect(readLiveFileReadReplay({ ...stored, replyMessageIds: ['reply', 'someone-elses'] }, owner)).toBeNull()
    expect(checkLiveFileReadReplay({ ...stored, replyMessageIds: ['reply', 'someone-elses'] }, owner)).toEqual({ unavailable: 'replay-unverifiable' })
  })

  it('a sealed list of parts that is not 1 to 16 ids of the allowed shape refuses the resume (409)', async () => {
    for (const bad of [[], Array.from({ length: 17 }, (_, index) => `part-${index}`), ['has space'], [7], 'reply', ['x'.repeat(129)]]) {
      expect(() => readLiveFileReadReplay(sealedWith_(bad), owner), JSON.stringify(bad).slice(0, 40)).toThrow(LiveFileReadReplayError)
    }
    // Sixteen is the most.
    expect(readLiveFileReadReplay(await sealedWith({ replyMessageIds: Array.from({ length: 16 }, (_, index) => `part-${index}`) }), owner)?.replyMessageIds).toHaveLength(16)

    function sealedWith_(bad: unknown) {
      // Built synchronously from a minimal replay so the loop above can use toThrow.
      const base = {
        schema_version: 1 as const, ...owner, compileId: 'c', pauseId: 'p', approvalIds: ['aitxt-1'],
        expiresAt: new Date(Date.now() + 60_000).toISOString(), copies: [], replyMessageIds: bad
      }
      return sealLiveFileReadReplay(base as any)
    }
  })

  it('more than sixteen parts are warned about and none are kept; the replay is otherwise whole', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const paused = await turn({ openReader: fakeOpener(() => 'x\n').openReader }).snapshotFor('appended', async () => [candidate(1)])
      const replay = replayOf(paused, ['aitxt-1'], Array.from({ length: 17 }, (_, index) => `part-${index}`))
      expect(replay.replyMessageIds).toBeUndefined()
      expect(Object.hasOwn(replay, 'replyMessageIds')).toBe(false)
      expect(replay.copies).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('[SA-137]')
      expect(String(warn.mock.calls[0][0])).toContain('17 parts')
      // Sixteen and none do not warn.
      warn.mockClear()
      replayOf(paused, ['aitxt-1'], Array.from({ length: 16 }, (_, index) => `part-${index}`))
      replayOf(paused)
      expect(warn).not.toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })

  it('a snapshot built from a replay says it was replayed; a built one does not', async () => {
    const reader = fakeOpener(() => 'x\n')
    const built = await turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [candidate(1)])
    expect(built.replayed).toBe(false)
    const resumed = await turn({ replay: readLiveFileReadReplay(JSON.parse(JSON.stringify(replayOf(built))), owner)! }).snapshotFor('appended', async () => [])
    expect(resumed.replayed).toBe(true)
    const unusable = await turn({ replayUnavailable: 'replay-missing' }).snapshotFor('appended', async () => [candidate(1)])
    expect(unusable.replayed).toBe(false)
  })

  it('a resume from a trimmed replay shows the copies it kept and has the dropped ones static replay-capacity', async () => {
    const reader = fakeOpener((locator) => locator === 'src/small.js' ? 'tiny\n' : 'y'.repeat(90_000) + '\n')
    const big = Array.from({ length: 12 }, (_, index) => candidate(index))
    const small = candidate(20, 'src/small.js')
    const paused = await turn({ openReader: reader.openReader }).snapshotFor('appended', async () => [...big, small])
    const replay = replayOf(paused)
    const dropped = replay.copies.find((copy) => copy.status === 'static')!.zipId
    const resumedReader = fakeOpener(() => 'changed\n')
    const resumed = await turn({ replay: readLiveFileReadReplay(JSON.parse(JSON.stringify(replay)), owner)!, openReader: resumedReader.openReader })
      .snapshotFor('appended', async () => [...big, small])
    expect(resumed.copies.get(dropped)).toEqual({ status: 'static', reason: 'replay-capacity' })
    for (const item of [...big, small].filter((item) => item.zipId !== dropped)) {
      expect(resumed.copies.get(item.zipId), item.zipId).toEqual(paused.copies.get(item.zipId))
    }
    expect(resumed.refreshed.size).toBe(12)
    expect(resumedReader.calls).toEqual({ opens: 0, reads: 0 })
  })
})

describe('a Stop during the read phase', () => {
  it('refreshes nothing, marks the turn stopped, and leaves no permit taken', async () => {
    const controller = new AbortController()
    const openReader = async (): Promise<LiveReadReader> => ({
      rootIdentity,
      readText: async () => { controller.abort(); throw new Error('anchored project read stopped') },
      close: async () => {}
    })
    const liveTurn = turn({ openReader, signal: controller.signal })
    const snapshot = await liveTurn.snapshotFor('appended', async () => [candidate(1), candidate(2)])
    expect(liveTurn.stopped).toBe(true)
    expect(snapshot.refreshed.size).toBe(0)
    expect([...snapshot.copies.values()]).toEqual([{ status: 'static', reason: 'stopped' }, { status: 'static', reason: 'stopped' }])
  })

  it('an unconfirmed reader end is never a quiet static snapshot', async () => {
    const { AnchoredReaderCleanupError } = await import('../anchoredProjectReader')
    const { LiveFileReadCleanupError } = await import('../liveFileReadSnapshot.server')
    const openReader = async (): Promise<LiveReadReader> => ({
      rootIdentity,
      readText: async () => 'x\n',
      close: async () => { throw new AnchoredReaderCleanupError('unverified') }
    })
    await expect(turn({ openReader }).snapshotFor('appended', async () => [candidate(1)])).rejects.toBeInstanceOf(LiveFileReadCleanupError)
  })

  it('takes the compile\'s project path when the route gives none', async () => {
    const liveTurn = new LiveFileReadTurn({ ...owner, executionBackend: 'local', openReader: fakeOpener(() => 'x\n').openReader })
    const snapshot = await liveTurn.snapshotFor('appended', async () => [candidate(1)], root)
    expect(snapshot.refreshed.size).toBe(1)
  })
})

describe('readLiveFileReadReplay', () => {
  async function replay() {
    const snapshot = await turn({ openReader: fakeOpener(() => 'x\n').openReader }).snapshotFor('appended', async () => [candidate(1)])
    return JSON.parse(JSON.stringify(replayOf(snapshot)))
  }

  it('accepts only the same user, chat, agent and reply, unexpired, with this exact schema', async () => {
    const value = await replay()
    expect(readLiveFileReadReplay(value, owner).pauseId).toBe(value.pauseId)
    for (const bad of [
      { ...value, userId: 'x' },
      { ...value, sessionId: 'x' },
      { ...value, agentId: 'x' },
      { ...value, messageId: 'x' },
      { ...value, schema_version: 2 },
      { ...value, pauseId: '' },
      { ...value, copies: [{ ...value.copies[0], parts: [{ source: 'model', text: 'x' }] }] },
      { ...value, copies: [{ zipId: value.copies[0].zipId, status: 'refreshed', promptTokens: 10 }] },
      undefined,
      'a string'
    ]) {
      expect(() => readLiveFileReadReplay(bad, owner)).toThrow(LiveFileReadReplayError)
    }
    // A field written null is a cleared snapshot (its expiry or a terminal writer): never used.
    expect(readLiveFileReadReplay(null, owner)).toBeNull()
    // A well-formed change after the seal, or no seal, is never used: null, a resume without live reads.
    expect(readLiveFileReadReplay({ ...value, copies: [{ zipId: 'z', status: 'refreshed', promptTokens: 30_000 }] }, owner)).toBeNull()
    expect(readLiveFileReadReplay({ ...value, copies: [{ ...value.copies[0], parts: [{ source: 'tool_result', text: 'forged file text' }] }] }, owner)).toBeNull()
    expect(readLiveFileReadReplay({ ...value, seal: undefined }, owner)).toBeNull()
  })

  it('a sealed replay past its expiry is the same as none: null, never a refusal', async () => {
    const { seal: _seal, ...value } = await replay()
    const expired = sealLiveFileReadReplay({ ...value, expiresAt: new Date(Date.now() - 1).toISOString() })
    expect(readLiveFileReadReplay(expired, owner)).toBeNull()
    expect(readLiveFileReadReplay(sealLiveFileReadReplay(value), owner, new Date(Date.parse(value.expiresAt)))).toBeNull()
    // An unsealed expired one is the same: never used.
    expect(readLiveFileReadReplay({ ...expired, seal: undefined }, owner)).toBeNull()
  })

  it('refuses a sealed replay with no pause or no approvals of its own', async () => {
    const { seal: _seal, ...value } = await replay()
    for (const fields of [{ pauseId: '' }, { approvalIds: [] }, { approvalIds: ['a', 'a'] }, { approvalIds: ['bad id'] }, { approvalIds: undefined }]) {
      expect(() => readLiveFileReadReplay(sealLiveFileReadReplay({ ...value, ...fields }), owner)).toThrow(LiveFileReadReplayError)
    }
    expect(readLiveFileReadReplay(sealLiveFileReadReplay(value), owner).approvalIds).toEqual(['aitxt-1'])
  })
})

describe('checkLiveFileReadReplay: why a resume has no usable snapshot (metadata only)', () => {
  const replayOwner = { userId: 'u', sessionId: 's', agentId: 'a', messageId: 'reply' }
  const snapshotOf = async () => turn({ openReader: fakeOpener(() => 'x\n').openReader }).snapshotFor('appended', async () => [candidate(1)])

  it('names a null field replay-missing, an expired one replay-expired, and a seal of another process replay-unverifiable', async () => {
    expect(checkLiveFileReadReplay(null, replayOwner)).toEqual({ unavailable: 'replay-missing' })
    const replay = replayOf(await snapshotOf(), ['approval-1'], undefined, replayOwner)
    expect(checkLiveFileReadReplay(replay, replayOwner)).toEqual({ replay })
    expect(checkLiveFileReadReplay(replay, replayOwner, new Date(Date.now() + 120_000))).toEqual({ unavailable: 'replay-expired' })
    expect(checkLiveFileReadReplay({ ...replay, seal: 'A'.repeat(43) }, replayOwner)).toEqual({ unavailable: 'replay-unverifiable' })
    expect(() => checkLiveFileReadReplay({ ...replay, messageId: 'other' }, replayOwner)).toThrow(LiveFileReadReplayError)
    expect(() => checkLiveFileReadReplay({ nope: true }, replayOwner)).toThrow(LiveFileReadReplayError)
  })

  it('a resume without a usable snapshot reads nothing and keeps every copy static with that reason', async () => {
    const reader = fakeOpener(() => 'new\n')
    const resumed = turn({ openReader: reader.openReader, replayUnavailable: 'replay-unverifiable' })
    const snapshot = await resumed.snapshotFor('appended', async () => [candidate(1), candidate(2)])
    expect(snapshot.copies.get(candidate(1).zipId)).toEqual({ status: 'static', reason: 'replay-unverifiable' })
    expect(snapshot.copies.get(candidate(2).zipId)).toEqual({ status: 'static', reason: 'replay-unverifiable' })
    expect(snapshot.refreshed.size).toBe(0)
    expect(resumed.replayUnavailable).toBe('replay-unverifiable')
    expect(reader.calls).toEqual({ opens: 0, reads: 0 })
  })
})

describe('liveReadReplayApprovalIds', () => {
  it('names the approvals the pause waits on, within the bounds a replay holds', () => {
    const entry = (approvalId: unknown, status = 'pending') => ({ approvalId, status })
    expect(liveReadReplayApprovalIds({ approvals: [entry('old', 'approved'), entry('aitxt-2'), entry('aitxt-3')] })).toEqual(['aitxt-2', 'aitxt-3'])
    expect(liveReadReplayApprovalIds({ approvals: [entry('done', 'expired')] })).toBeNull()
    expect(liveReadReplayApprovalIds({ approvals: [entry('has space')] })).toBeNull()
    expect(liveReadReplayApprovalIds({ approvals: [entry(7)] })).toBeNull()
    expect(liveReadReplayApprovalIds({ approvals: Array.from({ length: 33 }, (_, index) => entry(`a${index}`)) })).toBeNull()
    expect(liveReadReplayApprovalIds(null)).toBeNull()
  })
})

/**
 * Round 2 follow-up (R2-4, Ashe 2026-10-22): the after-read ask is not the cutoff. The turn asks the
 * other readers once more right before its first model request leaves (`beforeDispatch`, called by
 * the innermost model middleware after every awaited setup), and a revocation then means the request
 * is never sent. Nothing is read again and the frozen snapshot is not changed.
 */
describe('the last check before the first model request (Round 2 follow-up)', () => {
  const answering = (...answers: LiveReadOtherReaders[]) => {
    const queue = [...answers]
    return vi.fn(async (_asked: readonly string[]) => queue.shift() ?? readersAre([]))
  }
  const delayedSetup = () => new Promise((resolve) => setTimeout(resolve, 25))

  it('sharing turned off during a delayed setup, after the after-read ask, refuses the dispatch; nothing is read again', async () => {
    const reader = fakeOpener(() => 'SHARED-BYTES\n')
    const theirs = readBy(candidate(1), 'b')
    const own = candidate(2)
    const shared = readersAre(['b'], ['read_file'])
    const otherReaders = answering(shared, shared, readersAre(['b'], ['bash']))
    const live = turn({ openReader: reader.openReader, otherReaders })
    const snapshot = await live.snapshotFor('appended', async () => [theirs, own])
    // Before access and after the reads, both still shared: the copy refreshed.
    expect(otherReaders).toHaveBeenCalledTimes(2)
    expect(snapshot.copies.get(theirs.zipId)?.status).toBe('refreshed')
    expect(live.dispatchCheckPending).toBe(true)

    // The compile's Judge Juice call, the route's and the tools' setup: awaited work, then the revocation.
    await delayedSetup()
    await expect(live.beforeDispatch()).rejects.toBeInstanceOf(LiveFileReadSharingChangedError)
    expect(otherReaders).toHaveBeenCalledTimes(3)
    expect(otherReaders.mock.calls[2][0]).toEqual(['b'])
    // Still pending: a retried request is refused again, never let through.
    expect(live.dispatchCheckPending).toBe(true)
    await expect(live.beforeDispatch()).rejects.toBeInstanceOf(LiveFileReadSharingChangedError)
    // No filesystem access after the read phase; the frozen snapshot is the same object.
    expect(reader.calls).toEqual({ opens: 1, reads: 2 })
    expect(live.snapshot).toBe(snapshot)
  })

  it.each([
    ['the reader is gone', readersAre([], ['read_file'])],
    ['the reader moved to a sandbox', readersAre({ b: 'apple_container' }, ['read_file'])],
    ['no answer', readersAre([])]
  ])('%s at dispatch refuses it', async (_name, atDispatch) => {
    const shared = readersAre(['b'], ['read_file'])
    const live = turn({ openReader: fakeOpener(() => 'x\n').openReader, otherReaders: answering(shared, shared, atDispatch) })
    await withPlatform('darwin', () => live.snapshotFor('appended', async () => [readBy(candidate(1), 'b')]))
    await delayedSetup()
    await expect(live.beforeDispatch()).rejects.toBeInstanceOf(LiveFileReadSharingChangedError)
  })

  it('still shared at dispatch: the request goes; once it was sent, later requests of the reply ask nothing more', async () => {
    const shared = readersAre(['b'], ['read_file'])
    const otherReaders = answering(shared, shared, shared)
    const live = turn({ openReader: fakeOpener(() => 'x\n').openReader, otherReaders })
    await live.snapshotFor('appended', async () => [readBy(candidate(1), 'b'), candidate(2)])
    await delayedSetup()
    await expect(live.beforeDispatch()).resolves.toBeUndefined()
    live.dispatchSent()
    expect(live.dispatchCheckPending).toBe(false)
    // A tool step, a context continuation: the same bytes already went, so no fourth ask.
    await live.beforeDispatch()
    expect(otherReaders).toHaveBeenCalledTimes(3)
  })

  it('a check that passed whose request then failed to send is asked again on the retry: revoked by then, the retry is refused (review S1)', async () => {
    const shared = readersAre(['b'], ['read_file'])
    const otherReaders = answering(shared, shared, shared, readersAre([]))
    const live = turn({ openReader: fakeOpener(() => 'x\n').openReader, otherReaders })
    await live.snapshotFor('appended', async () => [readBy(candidate(1), 'b')])
    await expect(live.beforeDispatch()).resolves.toBeUndefined()
    // The send failed before the provider took it (no `dispatchSent`); the SDK waits and retries.
    expect(live.dispatchCheckPending).toBe(true)
    await delayedSetup()
    await expect(live.beforeDispatch()).rejects.toBeInstanceOf(LiveFileReadSharingChangedError)
    expect(otherReaders).toHaveBeenCalledTimes(4)
  })

  it('a turn that refreshed only its own copies, or that dropped the other reader\'s copy already, has no dispatch check', async () => {
    const ownOnly = turn({ openReader: fakeOpener(() => 'x\n').openReader, otherReaders: answering() })
    await ownOnly.snapshotFor('appended', async () => [candidate(1)])
    expect(ownOnly.dispatchCheckPending).toBe(false)

    const shared = readersAre(['b'], ['read_file'])
    const otherReaders = answering(shared, readersAre(['b'], ['bash']))
    const dropped = turn({ openReader: fakeOpener(() => 'x\n').openReader, otherReaders })
    const snapshot = await dropped.snapshotFor('appended', async () => [readBy(candidate(1), 'b'), candidate(2)])
    expect(snapshot.copies.get(readBy(candidate(1), 'b').zipId)).toEqual({ status: 'static', reason: 'sharing-changed' })
    expect(dropped.dispatchCheckPending).toBe(false)
    await dropped.beforeDispatch()
    expect(otherReaders).toHaveBeenCalledTimes(2)
  })

  it('an approval resume replays bytes the paused call already sent: no dispatch check, nothing asked (frozen replay contract)', async () => {
    const shared = readersAre(['b'], ['read_file'])
    const paused = await turn({ openReader: fakeOpener(() => 'frozen\n').openReader, otherReaders: answering(shared, shared) })
      .snapshotFor('appended', async () => [readBy(candidate(1), 'b')])
    const replay = readLiveFileReadReplay(JSON.parse(JSON.stringify(replayOf(paused))), owner)!
    const otherReaders = answering(readersAre([]))
    const resumed = turn({ replay, otherReaders })
    const snapshot = await resumed.snapshotFor('appended', async () => [readBy(candidate(1), 'b')])
    expect(snapshot.copies.get(readBy(candidate(1), 'b').zipId)?.status).toBe('refreshed')
    expect(resumed.dispatchCheckPending).toBe(false)
    await resumed.beforeDispatch()
    expect(otherReaders).not.toHaveBeenCalled()
  })
})

describe('the replay expiry', () => {
  it('expires with the card, at most a day out', () => {
    const now = new Date('2026-10-21T12:00:00.000Z')
    const pending = (expiresAt: string) => ({ status: 'pending', expiresAt })
    expect(liveFileReadReplayExpiry({ approvals: [pending('2026-10-21T12:03:00.000Z')] }, now).toISOString()).toBe('2026-10-21T12:03:00.000Z')
    expect(liveFileReadReplayExpiry({ approvals: [] }, now).toISOString()).toBe('2026-10-21T12:03:00.000Z')
    expect(liveFileReadReplayExpiry({ approvals: [pending('2026-10-30T00:00:00.000Z')] }, now).toISOString()).toBe('2026-10-22T12:00:00.000Z')
    // An older, answered entry on the same record never sets this pause's end.
    expect(liveFileReadReplayExpiry({ approvals: [{ status: 'approved', expiresAt: '2026-10-21T12:09:00.000Z' }, pending('2026-10-21T12:03:00.000Z')] }, now)
      .toISOString()).toBe('2026-10-21T12:03:00.000Z')
  })

  it('clears the field at expiry only while it is the same pause', async () => {
    const sessionId = `sa137-expiry-${Date.now()}`
    await redis.createSession({ id: sessionId, user_id: 'u', name: 'chat', agent_id: 'a' } as any)
    const save = async (messageId: string, pauseId: string) => redis.saveMessage({
      id: messageId, session_id: sessionId, user_id: 'u', agent_id: 'a', role: 'assistant', content: 'paused',
      metadata: { liveFileReadSnapshot: { schema_version: 1, pauseId } }
    } as any)
    await save('same', 'p1')
    await save('newer', 'p2')
    scheduleLiveFileReadReplayExpiry({ sessionId, messageId: 'same', pauseId: 'p1', expiresAt: new Date(Date.now() - 1).toISOString() })
    scheduleLiveFileReadReplayExpiry({ sessionId, messageId: 'newer', pauseId: 'p1', expiresAt: new Date(Date.now() - 1).toISOString() })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const same = await redis.execute((client: any) => client.json.get(`message:${sessionId}:same`))
    const newer = await redis.execute((client: any) => client.json.get(`message:${sessionId}:newer`))
    expect(same.metadata.liveFileReadSnapshot).toBeNull()
    expect(newer.metadata.liveFileReadSnapshot).toEqual({ schema_version: 1, pauseId: 'p2' })
  })
})
