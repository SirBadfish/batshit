import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ pipeline: vi.fn(), cacheRoot: vi.fn(() => '/never-read-memory-readiness-test') }))
// The production pipeline owner is exercised, but transformers and its model
// loader are replaced before dynamic import. No real library/model is loaded.
vi.mock('@huggingface/transformers', () => ({ env: { cacheDir: '' }, pipeline: mocks.pipeline }))
vi.mock('$lib/server/services/voiceLocalRuntimePaths', () => ({ resolveManagedInstallsRoot: mocks.cacheRoot }))

const GEMMA = 'builtin:embeddinggemma-300m'
const MINILM = 'builtin:all-minilm-l6-v2'
const extractor = async () => ({ tolist: () => [] })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.pipeline.mockReset()
})

describe('builtin fulfilled-promise readiness owner', () => {
  it('observes an unprepared/restarted process without loading, creating a cache path or preparing', async () => {
    const owner = await import('./memoryEmbedder')
    const observed = owner.observeBuiltinMemoryReadiness(GEMMA)
    expect(observed.state).toBe('preparation-required')
    expect(observed.isCurrent()).toBe(false)
    expect(mocks.pipeline).not.toHaveBeenCalled()
    expect(mocks.cacheRoot).not.toHaveBeenCalled()
  })

  it('distinguishes a pending cached promise from its fulfilled success and keeps a pending capture unready', async () => {
    const prepared = deferred<typeof extractor>()
    mocks.pipeline.mockReturnValue(prepared.promise)
    const owner = await import('./memoryEmbedder')
    const preparation = owner.ensureBuiltinModelReady(GEMMA)
    const pending = owner.observeBuiltinMemoryReadiness(GEMMA)
    expect(pending.state).toBe('preparing')
    expect(pending.isCurrent()).toBe(false)
    prepared.resolve(extractor)
    await preparation
    const ready = owner.observeBuiltinMemoryReadiness(GEMMA)
    expect(ready.state).toBe('ready')
    expect(ready.isCurrent()).toBe(true)
    expect(pending.isCurrent()).toBe(false)
    expect(mocks.pipeline).toHaveBeenCalledTimes(1)
    await owner.ensureBuiltinModelReady(GEMMA)
    expect(mocks.pipeline).toHaveBeenCalledTimes(1)
  })

  it('removes rejected readiness and allows a fresh promise to be prepared', async () => {
    const failed = deferred<typeof extractor>()
    mocks.pipeline.mockReturnValueOnce(failed.promise).mockResolvedValueOnce(extractor)
    const owner = await import('./memoryEmbedder')
    const preparation = owner.ensureBuiltinModelReady(GEMMA)
    const rejection = expect(preparation).rejects.toThrow('controlled failure')
    failed.reject(new Error('controlled failure'))
    await rejection
    expect(owner.observeBuiltinMemoryReadiness(GEMMA).state).toBe('preparation-required')
    await owner.ensureBuiltinModelReady(GEMMA)
    expect(owner.observeBuiltinMemoryReadiness(GEMMA).isCurrent()).toBe(true)
    expect(mocks.pipeline).toHaveBeenCalledTimes(2)
  })

  it('keeps the fulfilled current model ready while another model is pending or rejected', async () => {
    const other = deferred<typeof extractor>()
    mocks.pipeline.mockResolvedValueOnce(extractor).mockReturnValueOnce(other.promise)
    const owner = await import('./memoryEmbedder')
    await owner.ensureBuiltinModelReady(GEMMA)
    const ready = owner.observeBuiltinMemoryReadiness(GEMMA)
    const preparation = owner.ensureBuiltinModelReady(MINILM)
    const rejection = expect(preparation).rejects.toThrow('other model failed')
    expect(owner.observeBuiltinMemoryReadiness(MINILM).state).toBe('preparing')
    expect(ready.isCurrent()).toBe(true)
    other.reject(new Error('other model failed'))
    await rejection
    expect(owner.observeBuiltinMemoryReadiness(MINILM).state).toBe('preparation-required')
    expect(ready.isCurrent()).toBe(true)
    expect(owner.observeBuiltinMemoryReadiness(GEMMA).state).toBe('ready')
  })

  it('does not recover readiness from the old module/cache owner after a process-like restart', async () => {
    mocks.pipeline.mockResolvedValue(extractor)
    const before = await import('./memoryEmbedder')
    await before.ensureBuiltinModelReady(GEMMA)
    expect(before.observeBuiltinMemoryReadiness(GEMMA).state).toBe('ready')
    vi.resetModules()
    const after = await import('./memoryEmbedder')
    expect(after.observeBuiltinMemoryReadiness(GEMMA).state).toBe('preparation-required')
    expect(mocks.pipeline).toHaveBeenCalledTimes(1)
  })
})
