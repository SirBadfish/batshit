import { describe, expect, it } from 'vitest'
import type { GoonRecord } from '$lib/types/goons'
import {
  isGoonRuntimeReady,
  isRecipePreparationRequired,
  resolveRecipeProductReadiness
} from './recipeProductLifecycle'

function goon(overrides: Partial<GoonRecord> = {}): GoonRecord {
  return {
    id: 'goon-r9-readiness',
    user_id: 'user-r9-readiness',
    name: 'Batshit Base',
    kind: 'custom',
    sourceProfile: 'expert-custom-glb',
    files: {},
    customAvatar: {
      package: { filename: 'batshit-base.bgoon', url: '/uploads/batshit-base.bgoon' },
      model: { filename: 'avatar.glb', url: '/uploads/avatar.glb' },
      manifest: { filename: 'avatar.json', url: '/uploads/avatar.json' },
      manifestSummary: {
        contractVersion: 1,
        baseId: 'batshit-base-f-v1',
        recipeReady: true
      }
    },
    created_at: '2026-07-18T00:00:00.000Z',
    updated_at: '2026-07-18T00:00:00.000Z',
    ...overrides
  } as GoonRecord
}

function owner(active: boolean, liveStatus: 'up_to_date' | 'failed' = 'up_to_date') {
  return {
    contract: 'goon-recipe/v2',
    liveStatus,
    activeRevision: active ? { ref: 'active' } : null
  } as unknown as NonNullable<GoonRecord['recipe']>
}

describe('first-party Goon product readiness', () => {
  it('does not apply Recipe preparation gates to legacy or independent Advanced/GLB packages', () => {
    const independent = goon({
      customAvatar: {
        ...goon().customAvatar!,
        manifestSummary: { contractVersion: 1, recipeReady: false }
      }
    })
    expect(isRecipePreparationRequired(independent)).toBe(false)
    expect(isGoonRuntimeReady(independent)).toBe(true)
    expect(resolveRecipeProductReadiness(independent)).toBe('not-required')

    const spoofedIndependent = goon({
      customAvatar: {
        ...goon().customAvatar!,
        manifestSummary: {
          contractVersion: 1,
          baseId: 'independent-avatar',
          recipeReady: true
        }
      }
    })
    expect(isRecipePreparationRequired(spoofedIndependent)).toBe(false)
  })

  it('keeps a newly imported eligible Goon unavailable until preparation commits', () => {
    const imported = goon()
    expect(isRecipePreparationRequired(imported)).toBe(true)
    expect(isGoonRuntimeReady(imported)).toBe(false)
    expect(resolveRecipeProductReadiness(imported)).toBe('preparing')
  })

  it('reports a recoverable failed preparation when no active version exists', () => {
    const failed = goon({ recipe: owner(false, 'failed') })
    expect(isGoonRuntimeReady(failed)).toBe(false)
    expect(resolveRecipeProductReadiness(failed)).toBe('failed')
  })

  it('keeps the previous active Goon ready while a later update is failed', () => {
    const failedUpdate = goon({ recipe: owner(true, 'failed') })
    expect(isGoonRuntimeReady(failedUpdate)).toBe(true)
    expect(resolveRecipeProductReadiness(failedUpdate)).toBe('ready')
  })
})
