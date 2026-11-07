// @vitest-environment node
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnchoredReaderCleanupError } from '../anchoredProjectReader'
import {
  LiveFileReadCleanupError,
  LiveFileReadStoppedError,
  admitLiveFileReads,
  liveFileReadPermitsInUseForTests,
  liveReadBackendMountsHostWorkspace,
  liveReadSourceRefusal,
  readLiveFiles,
  resetLiveFileReadPermitsForTests,
  type LiveReadAdmission,
  type LiveReadReader
} from '../liveFileReadSnapshot.server'
import type { FileReadSource } from '$lib/utils/fileReadSource'

/**
 * SA-137 (D4, D5): the read half of live file reads. Real files go through the installed anchored
 * reader (built from its C source by the test setup): only regular UTF-8 text inside the admitted
 * root, no link, within the envelope. A busy, slow, stopped or uncertain reader has its own
 * outcome; only a Stop and an unconfirmed close are not "static".
 */

const supported = process.platform === 'darwin' || process.platform === 'linux'

/** Runs `run` with `process.platform` reported as `platform`, then restores it (the admission and refusal rules read it directly). */
async function withPlatform<T>(platform: string, run: () => T | Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

describe.runIf(supported)('live file reads through the real anchored reader', () => {
  let root = ''
  let outside = ''
  let admission: LiveReadAdmission

  beforeEach(async () => {
    resetLiveFileReadPermitsForTests()
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'batshit-sa137-read-')))
    outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'batshit-sa137-outside-')))
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src', 'a.js'), 'const a = 1\n')
    await writeFile(path.join(root, 'src', 'é.txt'), 'naïve – ✓\n')
    await writeFile(path.join(root, 'empty.txt'), '')
    await writeFile(path.join(outside, 'secret.txt'), 'outside\n')
    const details = await stat(root, { bigint: true })
    admission = { userId: 'u', agentId: 'a', sessionId: 's', root, rootIdentity: `${details.dev}:${details.ino}` }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('reads each distinct file once, in order, with its exact text, and releases the reader', async () => {
    const outcomes = await readLiveFiles(admission, ['src/a.js', 'src/é.txt', 'src/a.js', 'empty.txt'])
    expect([...outcomes.entries()]).toEqual([
      ['src/a.js', { status: 'read', text: 'const a = 1\n' }],
      ['src/é.txt', { status: 'read', text: 'naïve – ✓\n' }],
      ['empty.txt', { status: 'read', text: '' }]
    ])
    expect(liveFileReadPermitsInUseForTests()).toBe(0)
  }, 20_000)

  it('keeps a byte-order mark, as `cat` and the read proof print it', async () => {
    await writeFile(path.join(root, 'bom.txt'), '\uFEFFfirst\nsecond\n')
    const outcomes = await readLiveFiles(admission, ['bom.txt'])
    expect(outcomes.get('bom.txt')).toEqual({ status: 'read', text: '\uFEFFfirst\nsecond\n' })
  }, 20_000)

  it('names why a file stays static: missing, a link, a linked folder, outside, a folder, too big, not text', async () => {
    await symlink(path.join(root, 'src', 'a.js'), path.join(root, 'link.js'))
    await symlink(path.join(outside), path.join(root, 'linked-dir'))
    await mkdir(path.join(root, 'folder'))
    await writeFile(path.join(root, 'huge.txt'), 'x'.repeat(480_001))
    await writeFile(path.join(root, 'long.txt'), 'x'.repeat(130_000))
    await writeFile(path.join(root, 'nul.bin'), Buffer.from([0x61, 0x00, 0x62]))
    await writeFile(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    const outcomes = await readLiveFiles(admission, [
      'missing.js',
      'link.js',
      'linked-dir/secret.txt',
      '../' + path.basename(outside) + '/secret.txt',
      'folder',
      'huge.txt',
      'long.txt',
      'nul.bin',
      'latin1.txt',
      'src/a.js'
    ])
    expect(Object.fromEntries([...outcomes].map(([locator, outcome]) => [locator, outcome.status === 'static' ? outcome.reason : 'read']))).toEqual({
      'missing.js': 'not-readable',
      'link.js': 'not-readable',
      'linked-dir/secret.txt': 'not-readable',
      ['../' + path.basename(outside) + '/secret.txt']: 'not-readable',
      folder: 'not-regular-or-too-large',
      'huge.txt': 'not-regular-or-too-large',
      'long.txt': 'not-bounded-text',
      'nul.bin': 'not-bounded-text',
      'latin1.txt': 'not-bounded-text',
      'src/a.js': 'read'
    })
    expect(liveFileReadPermitsInUseForTests()).toBe(0)
  }, 20_000)

  it('reads nothing when the directory the reader admitted is not the admitted root', async () => {
    const outcomes = await readLiveFiles({ ...admission, rootIdentity: '1:2' }, ['src/a.js'])
    expect(outcomes.get('src/a.js')).toEqual({ status: 'static', reason: 'root-changed' })
    expect(liveFileReadPermitsInUseForTests()).toBe(0)
  }, 20_000)

  it('admits the Bash tool\'s root for the project path on the local backend', async () => {
    const admitted = await admitLiveFileReads({ userId: 'u', agentId: 'a', sessionId: 's', executionBackend: 'local', projectPath: root })
    expect(admitted).toEqual({ admitted: true, admission })
    expect(await admitLiveFileReads({ userId: 'u', agentId: 'a', sessionId: 's', executionBackend: 'local', projectPath: path.join(root, 'nope') }))
      .toEqual({ admitted: false, reason: 'root-unavailable' })
  }, 20_000)

  it('admits Apple Container and Docker Sandbox only on a Mac, and refuses every other backend', async () => {
    const ask = (executionBackend: string) => admitLiveFileReads({ userId: 'u', agentId: 'a', sessionId: 's', executionBackend, projectPath: root })
    for (const backend of ['apple_container', 'docker_sandbox']) {
      expect(await withPlatform('darwin', () => ask(backend)), `${backend} on darwin`).toEqual({ admitted: true, admission })
      expect(await withPlatform('linux', () => ask(backend)), `${backend} on linux`).toEqual({ admitted: false, reason: 'backend-not-local' })
    }
    for (const platform of ['darwin', 'linux']) {
      expect(await withPlatform(platform, () => ask('local')), `local on ${platform}`).toEqual({ admitted: true, admission })
    }
    for (const backend of ['docker', 'remote', 'apple-container', '', 'container']) {
      expect(await ask(backend), backend).toEqual({ admitted: false, reason: 'backend-not-local' })
    }
  }, 20_000)

  it('admits nothing inside the app container, whatever the backend: its workspace mapping is not qualified', async () => {
    const previous = process.env.BATSHIT_CONTAINERIZED
    process.env.BATSHIT_CONTAINERIZED = '1'
    try {
      for (const executionBackend of ['local', 'apple_container', 'docker_sandbox']) {
        expect(await admitLiveFileReads({ userId: 'u', agentId: 'a', sessionId: 's', executionBackend, projectPath: root }), executionBackend)
          .toEqual({ admitted: false, reason: 'unsupported-platform' })
      }
    } finally {
      if (previous === undefined) delete process.env.BATSHIT_CONTAINERIZED
      else process.env.BATSHIT_CONTAINERIZED = previous
    }
    // Outside it, the same ask is admitted.
    expect(await admitLiveFileReads({ userId: 'u', agentId: 'a', sessionId: 's', executionBackend: 'local', projectPath: root })).toEqual({ admitted: true, admission })
  }, 20_000)

  it('admits nothing on a host that is not a Mac or Linux', async () => {
    expect(await withPlatform('win32', () => admitLiveFileReads({ userId: 'u', agentId: 'a', sessionId: 's', executionBackend: 'local', projectPath: root })))
      .toEqual({ admitted: false, reason: 'unsupported-platform' })
  })
})

describe('liveReadBackendMountsHostWorkspace', () => {
  it('is true for the local backend on a Mac or Linux', () => {
    expect(liveReadBackendMountsHostWorkspace('local', 'darwin')).toBe(true)
    expect(liveReadBackendMountsHostWorkspace('local', 'linux')).toBe(true)
    expect(liveReadBackendMountsHostWorkspace('local', 'win32')).toBe(false)
  })

  it('is true for Apple Container and Docker Sandbox on a Mac only', () => {
    for (const backend of ['apple_container', 'docker_sandbox']) {
      expect(liveReadBackendMountsHostWorkspace(backend, 'darwin'), `${backend} darwin`).toBe(true)
      expect(liveReadBackendMountsHostWorkspace(backend, 'linux'), `${backend} linux`).toBe(false)
      expect(liveReadBackendMountsHostWorkspace(backend, 'win32'), `${backend} win32`).toBe(false)
    }
  })

  it('is false for the containerized app, an unknown backend, and a value that is not a backend', () => {
    for (const backend of ['docker', 'remote', 'apple-container', '', undefined, null, 1]) {
      expect(liveReadBackendMountsHostWorkspace(backend, 'darwin'), String(backend)).toBe(false)
      expect(liveReadBackendMountsHostWorkspace(backend, 'linux'), String(backend)).toBe(false)
    }
  })

  it('defaults to the host the app runs on', () => {
    expect(liveReadBackendMountsHostWorkspace('local')).toBe(liveReadBackendMountsHostWorkspace('local', process.platform))
    expect(liveReadBackendMountsHostWorkspace('apple_container')).toBe(process.platform === 'darwin')
  })
})

describe('liveReadSourceRefusal', () => {
  const admission: LiveReadAdmission = { userId: 'u', agentId: 'a', sessionId: 's', root: '/r', rootIdentity: '1:2' }
  const source: FileReadSource = {
    version: 1,
    owner: { userId: 'u', agentId: 'a', sessionId: 's', messageId: 'm', toolCallId: 't' },
    backend: 'local',
    workspaceRoot: '/r',
    rootIdentity: '1:2',
    cwd: '/r',
    locator: 'a.js',
    view: { kind: 'whole', numbering: 'none' }
  }
  it('refreshes only a read of the same user, chat and reader under the same, unchanged root', () => {
    expect(liveReadSourceRefusal(source, admission)).toBeNull()
    expect(liveReadSourceRefusal({ ...source, owner: { ...source.owner, agentId: 'b' } }, admission)).toBe('reader-gone')
    expect(liveReadSourceRefusal({ ...source, owner: { ...source.owner, sessionId: 'x' } }, admission)).toBe('other-actor')
    expect(liveReadSourceRefusal({ ...source, owner: { ...source.owner, userId: 'x' } }, admission)).toBe('other-actor')
    expect(liveReadSourceRefusal({ ...source, workspaceRoot: '/other' }, admission)).toBe('root-changed')
    expect(liveReadSourceRefusal({ ...source, rootIdentity: '1:3' }, admission)).toBe('root-changed')
  })
  it('refreshes a read from a sandbox that mounts the host workspace, on a Mac, under the same unchanged root', async () => {
    for (const backend of ['apple_container', 'docker_sandbox'] as const) {
      for (const liveReadsOn of [true, false]) {
        expect(await withPlatform('darwin', () => liveReadSourceRefusal({ ...source, backend, liveReadsOn }, admission)), `${backend} ${liveReadsOn}`).toBeNull()
      }
      // The same proof is a different folder or a different directory: still refused as such.
      expect(await withPlatform('darwin', () => liveReadSourceRefusal({ ...source, backend, liveReadsOn: true, workspaceRoot: '/other' }, admission))).toBe('root-changed')
      expect(await withPlatform('darwin', () => liveReadSourceRefusal({ ...source, backend, liveReadsOn: true, rootIdentity: '1:3' }, admission))).toBe('root-changed')
    }
  })

  it('refuses a sandbox origin on Linux, where nothing mounts the host workspace at the same path', async () => {
    for (const backend of ['apple_container', 'docker_sandbox'] as const) {
      expect(await withPlatform('linux', () => liveReadSourceRefusal({ ...source, backend, liveReadsOn: true }, admission)), backend).toBe('source-backend-not-local')
    }
    expect(await withPlatform('linux', () => liveReadSourceRefusal(source, admission))).toBeNull()
  })

  it('refuses a backend that is not one a record may name, before it asks anything else', () => {
    // A descriptor never validates with such a backend; the refusal still answers for it, first.
    const forged = { ...source, backend: 'docker', owner: { ...source.owner, userId: 'x' } } as unknown as FileReadSource
    expect(liveReadSourceRefusal(forged, admission)).toBe('source-backend-not-local')
  })

  it('refreshes another member\'s read only when the caller confirmed its reader is allowed (R2-4)', () => {
    const theirs = { ...source, owner: { ...source.owner, agentId: 'b' } }
    expect(liveReadSourceRefusal(theirs, admission)).toBe('reader-gone')
    expect(liveReadSourceRefusal(theirs, admission, false)).toBe('reader-gone')
    expect(liveReadSourceRefusal(theirs, admission, true)).toBeNull()
    // The caller's word for the reader never lets another chat's or another user's read through.
    expect(liveReadSourceRefusal({ ...theirs, owner: { ...theirs.owner, sessionId: 'x' } }, admission, true)).toBe('other-actor')
    expect(liveReadSourceRefusal({ ...theirs, owner: { ...theirs.owner, userId: 'x' } }, admission, true)).toBe('other-actor')
    // Nor a changed folder.
    expect(liveReadSourceRefusal({ ...theirs, workspaceRoot: '/other' }, admission, true)).toBe('root-changed')
    expect(liveReadSourceRefusal({ ...theirs, rootIdentity: '1:3' }, admission, true)).toBe('root-changed')
  })

  it('refuses the same actor\'s read when the caller says its reader is not allowed', () => {
    expect(liveReadSourceRefusal(source, admission, false)).toBe('reader-gone')
  })
})

describe('the reader permit, budget, Stop and an unconfirmed end', () => {
  const admission: LiveReadAdmission = { userId: 'u', agentId: 'a', sessionId: 's', root: '/r', rootIdentity: '1:2' }
  beforeEach(() => resetLiveFileReadPermitsForTests())

  function fakeReader(options: { read?: (locator: string, call: any) => Promise<string>; close?: () => Promise<void> } = {}) {
    const events: string[] = []
    const reader: LiveReadReader = {
      rootIdentity: '1:2',
      readText: async (locator, _max, call) => {
        events.push(`read:${locator}:${call.timeoutMs}`)
        return options.read ? options.read(locator, call) : `text of ${locator}`
      },
      close: async () => {
        events.push('close')
        if (options.close) await options.close()
      }
    }
    return { reader, events }
  }

  it('a third overlapping turn gets reader-busy at once, and a released permit is free again', async () => {
    let releaseOpen!: () => void
    const gate = new Promise<void>((resolve) => { releaseOpen = resolve })
    const { reader } = fakeReader()
    const slowOpen = async () => { await gate; return reader }
    const first = readLiveFiles(admission, ['a'], { openReader: slowOpen })
    const second = readLiveFiles(admission, ['b'], { openReader: slowOpen })
    let opened = false
    const third = await readLiveFiles(admission, ['c', 'd'], { openReader: async () => { opened = true; return reader } })
    expect(opened).toBe(false)
    expect([...third.values()]).toEqual([{ status: 'static', reason: 'reader-busy' }, { status: 'static', reason: 'reader-busy' }])
    expect(liveFileReadPermitsInUseForTests()).toBe(2)
    releaseOpen()
    await Promise.all([first, second])
    expect(liveFileReadPermitsInUseForTests()).toBe(0)
    expect((await readLiveFiles(admission, ['e'], { openReader: async () => reader })).get('e')).toEqual({ status: 'read', text: 'text of e' })
  })

  it('a read that runs out of time ends the phase: that file and the rest are deadline, no retry', async () => {
    const { reader, events } = fakeReader({
      read: async (locator) => {
        if (locator === 'slow') throw new Error('anchored project read took too long')
        return locator
      }
    })
    const outcomes = await readLiveFiles(admission, ['first', 'slow', 'after'], { openReader: async () => reader, fileMs: 40 })
    expect([...outcomes.entries()]).toEqual([
      ['first', { status: 'read', text: 'first' }],
      ['slow', { status: 'static', reason: 'deadline' }],
      ['after', { status: 'static', reason: 'deadline' }]
    ])
    expect(events).toEqual(['read:first:40', 'read:slow:40', 'close'])
    expect(liveFileReadPermitsInUseForTests()).toBe(0)
  })

  it('each read gets the smaller of its own limit and what is left of the phase; none starts after it', async () => {
    let clock = 0
    const { reader, events } = fakeReader({ read: async (locator) => { clock += 600; return locator } })
    const outcomes = await readLiveFiles(admission, ['one', 'two', 'three'], {
      openReader: async () => reader,
      now: () => clock,
      phaseMs: 1_000,
      fileMs: 700
    })
    expect(events).toEqual(['read:one:700', 'read:two:400', 'close'])
    expect(outcomes.get('three')).toEqual({ status: 'static', reason: 'deadline' })
  })

  it('a Stop is never static: it throws once the reader has closed, and frees the permit', async () => {
    const controller = new AbortController()
    const { reader, events } = fakeReader({
      read: async () => {
        controller.abort()
        throw new Error('anchored project read stopped')
      }
    })
    const stopped = readLiveFiles(admission, ['a', 'b'], { openReader: async () => reader, signal: controller.signal })
    await expect(stopped).rejects.toBeInstanceOf(LiveFileReadStoppedError)
    expect(events).toEqual(['read:a:100', 'close'])
    expect(liveFileReadPermitsInUseForTests()).toBe(0)
    await expect(readLiveFiles(admission, ['a'], { openReader: async () => reader, signal: controller.signal }))
      .rejects.toBeInstanceOf(LiveFileReadStoppedError)
  })

  it('an end Batshit cannot confirm fails setup and keeps the permit taken', async () => {
    const { reader } = fakeReader({ close: async () => { throw new AnchoredReaderCleanupError('unverified') } })
    await expect(readLiveFiles(admission, ['a'], { openReader: async () => reader })).rejects.toBeInstanceOf(LiveFileReadCleanupError)
    expect(liveFileReadPermitsInUseForTests()).toBe(1)
    const failingOpen = async () => { throw new AnchoredReaderCleanupError('unverified') }
    await expect(readLiveFiles(admission, ['a'], { openReader: failingOpen })).rejects.toBeInstanceOf(LiveFileReadCleanupError)
    expect(liveFileReadPermitsInUseForTests()).toBe(2)
    // Both permits are gone until the app restarts: every later turn is reader-busy.
    expect((await readLiveFiles(admission, ['a'], { openReader: async () => reader })).get('a')).toEqual({ status: 'static', reason: 'reader-busy' })
  })

  it('an already stopped turn reads nothing and opens no reader; a Stop after the last read still stops', async () => {
    const stopped = new AbortController()
    stopped.abort()
    let opened = false
    await expect(readLiveFiles(admission, ['a'], { signal: stopped.signal, openReader: async () => { opened = true; return fakeReader().reader } }))
      .rejects.toBeInstanceOf(LiveFileReadStoppedError)
    expect(opened).toBe(false)
    const late = new AbortController()
    const { reader, events } = fakeReader({ read: async (locator) => { late.abort(); return locator } })
    await expect(readLiveFiles(admission, ['a'], { signal: late.signal, openReader: async () => reader })).rejects.toBeInstanceOf(LiveFileReadStoppedError)
    expect(events).toEqual(['read:a:100', 'close'])
    expect(liveFileReadPermitsInUseForTests()).toBe(0)
  })

  it('an open that runs out of the phase is deadline; any other failed open is reader-unavailable; a broken clock takes no permit', async () => {
    let clock = 0
    const slowOpen = async () => { clock = 1_500; throw new Error('anchored project read took too long') }
    expect((await readLiveFiles(admission, ['a'], { openReader: slowOpen, now: () => clock })).get('a')).toEqual({ status: 'static', reason: 'deadline' })
    await expect(readLiveFiles(admission, ['a'], { openReader: async () => fakeReader().reader, now: () => { throw new Error('clock') } })).rejects.toThrow('clock')
    expect(liveFileReadPermitsInUseForTests()).toBe(0)
  })

  it('a locator too long for one helper request is that file\'s refusal, not the end of the phase', async () => {
    const { reader, events } = fakeReader()
    const long = 'é/'.repeat(1_500) + 'a.js'
    const outcomes = await readLiveFiles(admission, [long, 'b'], { openReader: async () => reader })
    expect(outcomes.get(long)).toEqual({ status: 'static', reason: 'not-readable' })
    expect(outcomes.get('b')).toEqual({ status: 'read', text: 'text of b' })
    expect(events).toEqual(['read:b:100', 'close'])
  })

  it('an unconfirmed end while stopped fails as unconfirmed, never as a plain Stop', async () => {
    const controller = new AbortController()
    const failingOpen = async () => { controller.abort(); throw new AnchoredReaderCleanupError('unverified') }
    await expect(readLiveFiles(admission, ['a'], { openReader: failingOpen, signal: controller.signal })).rejects.toBeInstanceOf(LiveFileReadCleanupError)
    expect(liveFileReadPermitsInUseForTests()).toBe(1)
  })

  it('a reader that cannot open leaves every file static with its reason', async () => {
    const outcomes = await readLiveFiles(admission, ['a', 'b'], { openReader: async () => { throw new Error('anchored project reader closed') } })
    expect([...outcomes.values()]).toEqual([{ status: 'static', reason: 'reader-unavailable' }, { status: 'static', reason: 'reader-unavailable' }])
    expect(liveFileReadPermitsInUseForTests()).toBe(0)
  })
})
