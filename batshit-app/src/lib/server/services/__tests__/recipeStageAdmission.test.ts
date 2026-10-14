import { describe, expect, it } from 'vitest'
import { createRecipeStageAdmissionCache } from '../recipeStageAdmission.server'
import {
  captureRecipeVerificationEpoch,
  withRecipeVerificationRestore
} from '../recipeVerificationEpoch.server'

describe('Recipe Stage admission cache', () => {
  it('takes exact ready-job evidence once without consuming a nearby key', () => {
    const cache = createRecipeStageAdmissionCache()
    const epoch = captureRecipeVerificationEpoch()
    expect(epoch).not.toBeNull()

    const key = 'user-a:goon-a:job-a:ready-version-4'
    cache.remember(key, 'dependency-digest-a', epoch)
    expect(cache.take('user-a:goon-a:job-b:ready-version-4')).toBeNull()
    expect(cache.take('user-b:goon-a:job-a:ready-version-4')).toBeNull()
    expect(cache.take('user-a:goon-a:job-a:ready-version-5')).toBeNull()
    expect(cache.take(key)).toEqual({ epoch, dependenciesSha256: 'dependency-digest-a' })
    expect(cache.take(key)).toBeNull()
  })

  it('expires at the exact monotonic deadline and evicts the oldest entry at capacity', () => {
    let monotonicNow = 100
    const cache = createRecipeStageAdmissionCache({ now: () => monotonicNow, ttlMs: 50, capacity: 2 })
    const epoch = captureRecipeVerificationEpoch()
    cache.remember('a', 'digest-a', epoch)
    cache.remember('b', 'digest-b', epoch)
    cache.remember('c', 'digest-c', epoch)
    expect(cache.take('a')).toBeNull()

    monotonicNow = 149
    expect(cache.take('b')).toEqual({ epoch, dependenciesSha256: 'digest-b' })
    cache.remember('b', 'digest-b-new', epoch)
    monotonicNow = 150
    expect(cache.take('c')).toBeNull()
    monotonicNow = 198
    expect(cache.take('b')).toEqual({ epoch, dependenciesSha256: 'digest-b-new' })
    cache.remember('deadline', 'digest-deadline', epoch)
    monotonicNow = 248
    expect(cache.take('deadline')).toBeNull()
  })

  it('does not transfer admission to a fresh cache instance after restart', () => {
    const epoch = captureRecipeVerificationEpoch()
    const original = createRecipeStageAdmissionCache()
    original.remember('same-ready-job', 'same-dependencies', epoch)

    const restarted = createRecipeStageAdmissionCache()
    expect(restarted.take('same-ready-job')).toBeNull()
    expect(original.take('same-ready-job')).toEqual({ epoch, dependenciesSha256: 'same-dependencies' })
  })

  it('invalidates an identical restored ready key and refuses admission while restore is active', async () => {
    const cache = createRecipeStageAdmissionCache()
    const beforeRestore = captureRecipeVerificationEpoch()
    cache.remember('identical-ready-key', 'identical-dependencies', beforeRestore)

    await withRecipeVerificationRestore(async () => {
      expect(captureRecipeVerificationEpoch()).toBeNull()
      expect(cache.take('identical-ready-key')).toBeNull()
      cache.remember('identical-ready-key', 'identical-dependencies', beforeRestore)
      expect(cache.take('identical-ready-key')).toBeNull()
    })

    expect(captureRecipeVerificationEpoch()).not.toBe(beforeRestore)
    cache.remember('identical-ready-key', 'identical-dependencies', beforeRestore)
    expect(cache.take('identical-ready-key')).toBeNull()
    const freshEpoch = captureRecipeVerificationEpoch()
    cache.remember('identical-ready-key', 'identical-dependencies', freshEpoch)
    expect(cache.take('identical-ready-key')).toEqual({
      epoch: freshEpoch,
      dependenciesSha256: 'identical-dependencies'
    })
  })
})
