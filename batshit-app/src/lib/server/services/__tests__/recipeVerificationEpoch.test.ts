import { describe, expect, it, vi } from 'vitest'
import {
  RecipeVerificationInvalidatedError,
  captureRecipeVerificationEpoch,
  isRecipeVerificationEpochCurrent,
  publishInRecipeVerificationEpoch,
  withRecipeVerificationRestore
} from '../recipeVerificationEpoch.server'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('Recipe verification epoch', () => {
  it('drains an already acquired publication before restore mutates stored state', async () => {
    const epoch = captureRecipeVerificationEpoch()
    const releasePublication = deferred<void>()
    const events: string[] = []
    const publication = publishInRecipeVerificationEpoch(epoch, async () => {
      events.push('publication-started')
      await releasePublication.promise
      events.push('publication-settled')
    })
    const restore = withRecipeVerificationRestore(async () => {
      events.push('restore-mutated')
    })

    await Promise.resolve()
    expect(events).toContain('publication-started')
    expect(events).not.toContain('restore-mutated')
    expect(captureRecipeVerificationEpoch()).toBeNull()

    releasePublication.resolve()
    await Promise.all([publication, restore])
    expect(events).toEqual(['publication-started', 'publication-settled', 'restore-mutated'])
  })

  it('rejects new and stale publications during and after restore without calling their callbacks', async () => {
    const staleEpoch = captureRecipeVerificationEpoch()
    const releaseRestore = deferred<void>()
    let published = 0
    const restore = withRecipeVerificationRestore(async () => releaseRestore.promise)

    expect(captureRecipeVerificationEpoch()).toBeNull()
    await expect(publishInRecipeVerificationEpoch(staleEpoch, async () => { published++ }))
      .rejects.toBeInstanceOf(RecipeVerificationInvalidatedError)
    await expect(publishInRecipeVerificationEpoch(null, async () => { published++ }))
      .rejects.toBeInstanceOf(RecipeVerificationInvalidatedError)

    releaseRestore.resolve()
    await restore
    expect(isRecipeVerificationEpochCurrent(staleEpoch)).toBe(false)
    await expect(publishInRecipeVerificationEpoch(staleEpoch, async () => { published++ }))
      .rejects.toBeInstanceOf(RecipeVerificationInvalidatedError)
    expect(published).toBe(0)

    const currentEpoch = captureRecipeVerificationEpoch()
    await publishInRecipeVerificationEpoch(currentEpoch, async () => { published++ })
    expect(published).toBe(1)
  })

  it('keeps suspension active through nested restore and releases it after errors', async () => {
    const beforeRestore = captureRecipeVerificationEpoch()
    await expect(withRecipeVerificationRestore(async () => {
      expect(captureRecipeVerificationEpoch()).toBeNull()
      await withRecipeVerificationRestore(async () => {
        expect(captureRecipeVerificationEpoch()).toBeNull()
      })
      expect(captureRecipeVerificationEpoch()).toBeNull()
      throw new Error('injected restore failure')
    })).rejects.toThrow('injected restore failure')

    const recoveredEpoch = captureRecipeVerificationEpoch()
    expect(recoveredEpoch).not.toBeNull()
    expect(recoveredEpoch).not.toBe(beforeRestore)
    expect(isRecipeVerificationEpochCurrent(recoveredEpoch)).toBe(true)
  })

  it('lets a failed publication settle before restore and then invalidates its old epoch', async () => {
    const epoch = captureRecipeVerificationEpoch()
    const releasePublication = deferred<void>()
    let restoreMutated = false
    const publication = publishInRecipeVerificationEpoch(epoch, async () => {
      await releasePublication.promise
      throw new Error('injected CAS failure')
    })
    const publicationFailure = expect(publication).rejects.toThrow('injected CAS failure')
    const restore = withRecipeVerificationRestore(async () => { restoreMutated = true })
    await Promise.resolve()
    expect(restoreMutated).toBe(false)

    releasePublication.resolve()
    await publicationFailure
    await restore
    expect(restoreMutated).toBe(true)
    expect(isRecipeVerificationEpochCurrent(epoch)).toBe(false)
  })

  it('times out without running restore mutation while a publication is unsettled', async () => {
    vi.useFakeTimers()
    const releasePublication = deferred<void>()
    try {
      const epoch = captureRecipeVerificationEpoch()
      const publication = publishInRecipeVerificationEpoch(epoch, () => releasePublication.promise)
      let restoreMutated = false
      const restore = withRecipeVerificationRestore(async () => { restoreMutated = true })
      const restoreFailure = expect(restore).rejects.toThrow(
        'Backup restore is waiting for a Goon publication to finish. Retry restore.'
      )

      await vi.advanceTimersByTimeAsync(30_000)
      await restoreFailure
      expect(restoreMutated).toBe(false)
      expect(isRecipeVerificationEpochCurrent(epoch)).toBe(false)
      releasePublication.resolve()
      await publication
    } finally {
      releasePublication.resolve()
      vi.useRealTimers()
    }
  })
})
