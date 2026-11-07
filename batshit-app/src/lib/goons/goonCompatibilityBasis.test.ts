import { describe, expect, it } from 'vitest'
import type { GoonRecord } from '$lib/types/goons'
import {
  captureGoonCompatibilityBasis, compatibilityOwnerForBasis,
  collectGoonCompatibilityMotionFiles, isCurrentGoonCompatibilityOwner, MAX_COMPATIBILITY_GOONS,
  preserveSavedMotionOption
} from './goonCompatibilityBasis'

function goon(id: string, model: string): GoonRecord {
  return {
    id, user_id: 'owner', name: id, kind: 'custom', sourceProfile: 'expert-custom-glb',
    files: { animations: [] },
    customAvatar: {
      model: { url: model, filename: 'body.glb' },
      manifest: { url: '/uploads/goon_custom_manifests/body.json', filename: 'body.json' }
    },
    created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z'
  }
}

describe('Goon compatibility producer basis', () => {
  it('keeps an absent saved Motion visible as an unverified, disabled option', () => {
    const options = [{ name: 'ready', label: 'Ready' }]
    expect(preserveSavedMotionOption(options, 'saved')).toEqual([
      ...options, { name: 'saved', label: 'saved', sourceLabel: 'Saved · unverified', disabled: true }
    ])
    expect(options).toEqual([{ name: 'ready', label: 'Ready' }])
    expect(preserveSavedMotionOption(options, 'ready')).toBe(options)
  })
  it('keeps the Dock shared-first order and first file for a duplicate reference', () => {
    const target = goon('a', '/body.glb')
    const shared = { url: '/wave.glb', filename: 'shared.glb' }
    const duplicate = { url: '/wave.glb', filename: 'local.glb' }
    const local = { url: '/sit.glb', filename: 'sit.glb' }
    target.files.animations = [duplicate, local]
    expect(collectGoonCompatibilityMotionFiles([target], [shared])).toEqual([shared, local])
  })

  it('skips unsafe load rows without qualifying the filtered inventory or dropping a usable legacy URL', () => {
    const target = goon('a', '/body.glb')
    const valid = { url: '/valid.glb', filename: 'valid.glb' }
    const legacy = { url: '/legacy.glb' }
    const invalid = { url: '/bad.glb', filename: 42 }
    target.files.animations = [valid, legacy, invalid] as any
    expect(collectGoonCompatibilityMotionFiles([target], [])).toEqual([valid, legacy])
    expect(() => captureGoonCompatibilityBasis(target, [target], [], { eager: [], deferred: [] }))
      .toThrow('valid motion inventory')
    expect(target.files.animations).toEqual([valid, legacy, invalid])
  })

  it('preserves exact resolved refs and source and plan identity without changing inputs', () => {
    const target = goon('a', 'http://127.0.0.1:5641/uploads/goon_custom_models/body.glb')
    const other = goon('b', '/uploads/goon_custom_models/other.glb')
    const motion = { url: 'http://127.0.0.1:5641/uploads/goon_animations/wave.glb', filename: 'wave.glb', size: 42 }
    other.files.animations = [motion]
    const before = structuredClone({ target, other, motion })
    const basis = captureGoonCompatibilityBasis(target, [target, other], [], { eager: [motion], deferred: [] })
    const owner = compatibilityOwnerForBasis(basis)

    const storedTarget = goon('a', target.customAvatar!.model!.url)
    const storedOther = goon('b', '/uploads/goon_custom_models/other.glb')
    const storedMotion = { ...motion }
    storedOther.files.animations = [storedMotion]
    const equivalent = captureGoonCompatibilityBasis(storedTarget, [storedOther, storedTarget], [], {
      eager: [storedMotion], deferred: []
    })
    expect(compatibilityOwnerForBasis(equivalent)).toEqual(owner)
    expect({ target, other, motion }).toEqual(before)

    const deferred = captureGoonCompatibilityBasis(storedTarget, [storedTarget, storedOther], [], {
      eager: [], deferred: [storedMotion]
    })
    expect(compatibilityOwnerForBasis(deferred).motionPlanSha256).not.toBe(owner.motionPlanSha256)
    expect(isCurrentGoonCompatibilityOwner(owner, deferred)).toBe(true)

    const foreignTarget = goon('a', 'https://other.example/uploads/goon_custom_models/body.glb')
    expect(isCurrentGoonCompatibilityOwner(owner, captureGoonCompatibilityBasis(
      foreignTarget, [foreignTarget, storedOther], [], { eager: [storedMotion], deferred: [] }
    ))).toBe(false)
  })

  it('marks a changed model or motion source unverified while retaining the old owner', () => {
    const target = goon('a', '/uploads/goon_custom_models/body.glb')
    const motion = { url: '/uploads/goon_animations/wave.glb', filename: 'wave.glb' }
    target.files.animations = [motion]
    const basis = captureGoonCompatibilityBasis(target, [target], [], { eager: [motion], deferred: [] })
    const owner = compatibilityOwnerForBasis(basis)
    const changedModel = goon('a', '/uploads/goon_custom_models/new-body.glb')
    changedModel.files.animations = [motion]
    expect(isCurrentGoonCompatibilityOwner(owner, captureGoonCompatibilityBasis(
      changedModel, [changedModel], [], { eager: [motion], deferred: [] }
    ))).toBe(false)
    const changedMotion = { ...motion, url: '/uploads/goon_animations/new-wave.glb' }
    target.files.animations = [changedMotion]
    expect(isCurrentGoonCompatibilityOwner(owner, captureGoonCompatibilityBasis(
      target, [target], [], { eager: [changedMotion], deferred: [] }
    ))).toBe(false)
    expect(isCurrentGoonCompatibilityOwner(null, basis)).toBe(false)
  })

  it('refuses incomplete, duplicate and oversized diagnostic inventories without touching the Goon', () => {
    const target = goon('a', '/uploads/goon_custom_models/body.glb')
    const before = structuredClone(target)
    const emptyPlan = { eager: [], deferred: [] }
    expect(() => captureGoonCompatibilityBasis(target, [], [], emptyPlan)).toThrow('current Goon inventory')
    expect(() => captureGoonCompatibilityBasis(target, [target, target], [], emptyPlan)).toThrow('complete Goon inventory')
    const foreign = { ...goon('foreign', '/other.glb'), user_id: 'other-owner' }
    expect(() => captureGoonCompatibilityBasis(target, [target, foreign], [], emptyPlan)).toThrow('complete Goon inventory')
    const malformed = { ...target, files: { animations: [{ filename: 'missing-url.glb' }] } } as unknown as GoonRecord
    expect(() => captureGoonCompatibilityBasis(malformed, [malformed], [], emptyPlan)).toThrow('valid motion inventory')
    const tooMany = Array.from({ length: MAX_COMPATIBILITY_GOONS + 1 }, (_, index) => goon(String(index), '/body.glb'))
    expect(() => captureGoonCompatibilityBasis(target, tooMany, [], emptyPlan)).toThrow('unavailable')
    expect(target).toEqual(before)
  })
})
