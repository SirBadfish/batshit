import { describe, expect, it } from 'vitest'
import {
  GOON_BASE_POSE_FALLBACK_NAMES,
  buildGoonAnimationPriorityNames,
  resolveGoonAnimationName,
  sanitizeGoonAnimationName
} from './animationLoadPlan'
import type { GoonFileRef } from '$lib/types/goons'

describe('goon animation naming helpers', () => {
  it('normalizes animation labels without extensions', () => {
    const file: GoonFileRef = {
      filename: 'Idle Loop.vrma',
      originalName: 'Idle Loop!!.vrma',
      url: '/uploads/goons/idle-loop.vrma'
    }

    expect(resolveGoonAnimationName(file, 'fallback')).toBe('Idle_Loop')
  })

  it('uses fallbacks when animation labels normalize to nothing', () => {
    expect(sanitizeGoonAnimationName('!!!.vrma', 'motion_preview')).toBe('motion_preview')
    expect(resolveGoonAnimationName(null, 'base_stand')).toBe('base_stand')
  })

  it('builds deduped priority names with base pose fallbacks', () => {
    expect(buildGoonAnimationPriorityNames('idle')).toEqual([
      'idle',
      ...GOON_BASE_POSE_FALLBACK_NAMES
    ])

    expect(buildGoonAnimationPriorityNames('base_stand_pose')).toEqual([
      ...GOON_BASE_POSE_FALLBACK_NAMES
    ])
  })
})
