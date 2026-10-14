import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRecipePreviewAttempt } from './recipePreviewAttempt'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('Recipe preview attempt', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('cancels never-settling work immediately and keeps its exact abort reason', async () => {
    const attempt = createRecipePreviewAttempt({ timeoutMs: 1000, label: 'eyelid' })
    const outcome = attempt.run(new Promise<string>(() => {}))

    attempt.cancel()

    expect(attempt.signal.reason).toMatchObject({ name: 'AbortError' })
    expect(attempt.signal.reason.message).toBe('The eyelid preview was canceled.')
    await expect(outcome).rejects.toBe(attempt.signal.reason)
    expect(vi.getTimerCount()).toBe(0)
    attempt.finish()
  })

  it('times out never-settling work and rejects with the exact timeout reason', async () => {
    const attempt = createRecipePreviewAttempt({ timeoutMs: 20, label: 'eyelid' })
    const outcome = attempt.run(new Promise<string>(() => {}))
    const caught = outcome.catch(error => error)

    await vi.advanceTimersByTimeAsync(20)

    expect(attempt.signal.reason).toMatchObject({ name: 'TimeoutError' })
    expect(attempt.signal.reason.message).toBe('Building the eyelid preview took too long. Try again.')
    expect(await caught).toBe(attempt.signal.reason)
    attempt.finish()
  })

  it('observes late work rejection after cancellation', async () => {
    const attempt = createRecipePreviewAttempt({ timeoutMs: 1000 })
    const work = deferred<string>()
    const outcome = attempt.run(work.promise)

    attempt.cancel()
    await expect(outcome).rejects.toBe(attempt.signal.reason)
    work.reject(new Error('Late preview failure'))
    await Promise.resolve()

    expect(attempt.signal.reason.name).toBe('AbortError')
    attempt.finish()
  })

  it('keeps one deadline across preparation and mounting rather than restarting it per stage', async () => {
    const attempt = createRecipePreviewAttempt({ timeoutMs: 100 })
    await expect(attempt.run(Promise.resolve('prepared'))).resolves.toBe('prepared')
    await vi.advanceTimersByTimeAsync(80)
    const mount = attempt.run(new Promise<void>(() => {})).catch(error => error)

    await vi.advanceTimersByTimeAsync(20)

    expect(await mount).toBe(attempt.signal.reason)
    expect(attempt.signal.reason.name).toBe('TimeoutError')
    attempt.finish()
  })

  it('propagates its parent deadline reason and detaches from the parent on finish', async () => {
    const parent = new AbortController()
    const attempt = createRecipePreviewAttempt({ signal: parent.signal })
    const waiting = attempt.run(new Promise<void>(() => {})).catch(error => error)
    const reason = new DOMException('Parent deadline', 'TimeoutError')
    parent.abort(reason)
    expect(await waiting).toBe(reason)
    expect(attempt.signal.reason).toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
    attempt.finish()

    const laterParent = new AbortController()
    const finished = createRecipePreviewAttempt({ signal: laterParent.signal })
    finished.finish()
    laterParent.abort()
    expect(finished.signal.aborted).toBe(false)
  })

  it('lets cancellation win when work resolves in the same turn', async () => {
    const attempt = createRecipePreviewAttempt({ timeoutMs: 1000 })
    const work = deferred<string>()
    const outcome = attempt.run(work.promise)

    work.resolve('ready')
    attempt.cancel()

    await expect(outcome).rejects.toBe(attempt.signal.reason)
    attempt.finish()
  })

  it('returns successful work and finish disposes the deadline idempotently', async () => {
    const attempt = createRecipePreviewAttempt({ timeoutMs: 100 })
    await expect(attempt.run(Promise.resolve('ready'))).resolves.toBe('ready')
    attempt.finish()
    attempt.finish()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(200)
    attempt.cancel()
    expect(attempt.signal.aborted).toBe(false)
  })

  it('rejects immediately when already canceled and observes later work settlement', async () => {
    const attempt = createRecipePreviewAttempt()
    const work = deferred<string>()
    attempt.cancel()

    const outcome = attempt.run(work.promise)
    await expect(outcome).rejects.toBe(attempt.signal.reason)
    work.reject(new Error('Late failure after prior cancellation'))
    await Promise.resolve()
    attempt.finish()
  })

  it('keeps the first abort reason when finish follows cancellation', async () => {
    const attempt = createRecipePreviewAttempt({ timeoutMs: 20 })
    attempt.cancel()
    const reason = attempt.signal.reason
    attempt.finish()
    await vi.advanceTimersByTimeAsync(30)

    expect(attempt.signal.reason).toBe(reason)
    await expect(attempt.run(Promise.resolve('late'))).rejects.toBe(reason)
  })
})
