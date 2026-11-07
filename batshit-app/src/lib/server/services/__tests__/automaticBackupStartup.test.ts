import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ set: vi.fn(), start: vi.fn(), delay: vi.fn(), now: 0 }))
vi.mock('../automaticBackupService', () => ({
  setAutomaticBackupStartup: mocks.set,
  startAutomaticBackupScheduler: mocks.start
}))
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.delay, default: { setTimeout: mocks.delay } }))

import {
  automaticBackupBuildId,
  beginAutomaticBackupStartup,
  completeAutomaticBackupStartup,
  waitForAutomaticBackupFileService,
  type AutomaticBackupStartupWork
} from '../automaticBackupStartup'
import { closeRegisteredRuntimeResources, resetRuntimeShutdownTasksForTests } from '../runtimeShutdown'

function work(): AutomaticBackupStartupWork {
  return {
    recovery: Promise.resolve(), skills: Promise.resolve({ complete: true, failed: 0 }),
    zipPrompts: Promise.resolve(), promptDefaults: Promise.resolve(),
    retiredPrompts: Promise.resolve(), retiredClips: Promise.resolve(),
    retiredZipFields: Promise.resolve(),
    zipDefaults: Promise.resolve({ status: 'swept', records: 0, rows: 0, fields: 0, changed: [] }),
    memoryIndexes: Promise.resolve({ status: 'created', embeddingModel: 'builtin', dims: 384 }),
    memoryMedia: Promise.resolve({ status: 'migrated', records: 2, media: 1, unresolved: 0 })
  }
}

const options = { buildId: 'sveltekit:actual-artifact-1', schedulersDisabled: false }
const healthy = () => new Response(JSON.stringify({
  ok: true, service: 'batshit-server', checks: { http: true, redis: true }
}))

beforeEach(() => {
  mocks.set.mockReset()
  mocks.start.mockReset()
  mocks.now = 0
  mocks.delay.mockReset().mockImplementation(async (ms: number, _value: unknown, opts: { signal: AbortSignal; ref: boolean }) => {
    opts.signal.throwIfAborted()
    mocks.now += ms
  })
  vi.spyOn(Date, 'now').mockImplementation(() => mocks.now)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => healthy()))
  resetRuntimeShutdownTasksForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetRuntimeShutdownTasksForTests()
})

describe('automatic backup startup readiness', () => {
  it('waits for original pending work and file-service startup before arming', async () => {
    let finish!: (value: { complete: boolean; failed: number }) => void
    const pending = work()
    pending.skills = new Promise((resolve) => { finish = resolve })
    const started = completeAutomaticBackupStartup(pending, options)
    await Promise.resolve()
    expect(mocks.set).toHaveBeenLastCalledWith({ ready: false, buildId: options.buildId, dataGeneration: '' })
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
    finish({ complete: true, failed: 0 })
    await started
    expect(mocks.set).toHaveBeenLastCalledWith({ ready: true, buildId: options.buildId, dataGeneration: expect.stringMatching(/^startup-v1:[a-f0-9]{64}$/) })
    expect(mocks.start).toHaveBeenCalledTimes(1)
  })

  it('retains the original rejection even when normal startup logged and swallowed it', async () => {
    const original = Promise.reject(new Error('migration failed'))
    await original.catch(() => undefined)
    await completeAutomaticBackupStartup({ ...work(), zipPrompts: original }, options)
    expect(mocks.set).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false, error: expect.stringContaining('zipPrompts') }))
    expect(mocks.start).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['skills', { complete: false, failed: 1 }, 'Skill file migration'],
    ['memoryMedia', { status: 'already-complete', records: 2, media: 0, unresolved: -1 }, 'valid completion receipt']
  ])('refuses internally incomplete %s results', async (name, value, message) => {
    await completeAutomaticBackupStartup({ ...work(), [name]: Promise.resolve(value) }, options)
    expect(mocks.set).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false, error: expect.stringContaining(message) }))
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('keeps the accepted terminal clean-break outcome visible without blocking all later backups', async () => {
    await completeAutomaticBackupStartup({ ...work(), memoryMedia: Promise.resolve({
      status: 'already-complete', records: 2, media: 0, unresolved: 1
    }) }, options)
    expect(mocks.set).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true, warning: expect.stringContaining('1 memory image sources') }))
    expect(mocks.start).toHaveBeenCalledTimes(1)
  })

  it('keeps build and data-generation provenance stable across an ordinary restart', async () => {
    await completeAutomaticBackupStartup(work(), options)
    const first = mocks.set.mock.calls.at(-1)![0]
    await completeAutomaticBackupStartup({ ...work(), memoryMedia: Promise.resolve({
      status: 'already-complete', records: 2, media: 1, unresolved: 0
    }) }, options)
    expect(mocks.set).toHaveBeenLastCalledWith(first)
    expect(automaticBackupBuildId('build-1', false)).toBe('sveltekit:build-1')
    expect(automaticBackupBuildId('build-2', false)).not.toBe('sveltekit:build-1')
    expect(automaticBackupBuildId('per-start-1', true)).toBe('development')
    expect(automaticBackupBuildId('per-start-2', true)).toBe('development')
  })

  it('records readiness with schedulers explicitly disabled without arming', async () => {
    await completeAutomaticBackupStartup(work(), { ...options, schedulersDisabled: true })
    expect(mocks.set).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true }))
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('waits through pre-listen refusal and rejects a superficially healthy wrong service', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, service: 'another-service' })))
      .mockResolvedValueOnce(healthy())
    await completeAutomaticBackupStartup(work(), options)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(mocks.delay).toHaveBeenCalledTimes(2)
    expect(mocks.delay).toHaveBeenCalledWith(1_000, undefined, expect.objectContaining({ ref: false }))
    expect(mocks.start).toHaveBeenCalledTimes(1)
  })

  it('reports the real 15-minute conditional wait as unavailable when the file service never becomes ready', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: false })))
    await completeAutomaticBackupStartup(work(), options)
    expect(mocks.set).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false, error: expect.stringContaining('within 15 minutes') }))
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('cancels readiness on shutdown and never publishes success or arms later', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('connection refused'))
    let waiting!: () => void
    const atWait = new Promise<void>((resolve) => { waiting = resolve })
    mocks.delay.mockImplementationOnce((_ms, _value, opts) => new Promise((_resolve, reject) => {
      waiting()
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true })
    }))
    const started = completeAutomaticBackupStartup(work(), options)
    await atWait
    await closeRegisteredRuntimeResources('test shutdown')
    await started
    expect(mocks.set).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false, error: expect.stringContaining('stopped before') }))
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('cannot become ready when shutdown happened during earlier restore or migration work', async () => {
    const guard = beginAutomaticBackupStartup(options.buildId)
    await closeRegisteredRuntimeResources('shutdown during recovery')
    await completeAutomaticBackupStartup(work(), { ...options, guard })
    expect(mocks.set).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false, error: expect.stringContaining('stopped before') }))
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('rejects an already stopped file-service waiter without making a request', async () => {
    const stop = new AbortController()
    stop.abort()
    await expect(waitForAutomaticBackupFileService(stop.signal)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})
