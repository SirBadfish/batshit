import { describe, expect, it } from 'vitest'

import {
  resolveEyeContactChannels,
  resolveEyeLookRuntimeLane,
  resolveEyeLookExpressionWeights
} from '$lib/goons/eyeContact'

describe('resolveEyeContactChannels', () => {
  it('keeps eye influence stronger than head near the front orbit', () => {
    const result = resolveEyeContactChannels(10, 0)

    expect(result.amount).toBeCloseTo(1, 5)
    expect(Math.abs(result.eyeYaw)).toBeGreaterThan(Math.abs(result.headYaw))
  })

  it('brings the head to its comfortable max by the wide orbit band', () => {
    const result = resolveEyeContactChannels(52, 0)

    expect(result.amount).toBeGreaterThan(0.9)
    expect(Math.abs(result.headYaw)).toBeCloseTo(1, 5)
    expect(Math.abs(result.eyeYaw)).toBeGreaterThan(0.05)
  })

  it('lets goon tuning delay head yaw while boosting eye yaw sensitivity', () => {
    const baseline = resolveEyeContactChannels(45, 0)
    const tuned = resolveEyeContactChannels(45, 0, {
      eyeYawSensitivity: 3,
      eyePitchSensitivity: 1,
      headYawStartOutDeg: 55,
      headYawSensitivity: 0.5
    })

    expect(Math.abs(tuned.eyeYaw)).toBeGreaterThan(Math.abs(baseline.eyeYaw))
    expect(Math.abs(tuned.headYaw)).toBeLessThan(Math.abs(baseline.headYaw))
  })

  it('splits one shared target so head movement reduces the eye target', () => {
    const uncompensated = resolveEyeContactChannels(70, 0, {
      eyeYawHeadCompensation: 0
    })
    const compensated = resolveEyeContactChannels(70, 0, {
      eyeYawHeadCompensation: 1
    })

    expect(Math.abs(compensated.headYaw)).toBeCloseTo(Math.abs(uncompensated.headYaw), 5)
    expect(Math.abs(compensated.eyeYaw)).toBeLessThan(Math.abs(uncompensated.eyeYaw))
    expect(Math.abs(compensated.eyeYaw)).toBeGreaterThan(0)
  })

  it('lets eyes finish the leftover target after the head reaches max', () => {
    const wide = resolveEyeContactChannels(52, 0)
    const nearGiveUp = resolveEyeContactChannels(92, 0)

    expect(Math.abs(wide.headYaw)).toBeCloseTo(1, 5)
    expect(Math.abs(nearGiveUp.headYaw)).toBeCloseTo(1, 5)
    expect(Math.abs(nearGiveUp.eyeYaw)).toBeGreaterThan(Math.abs(wide.eyeYaw))
    expect(Math.abs(nearGiveUp.eyeYaw)).toBeCloseTo(0.72, 5)
    expect(nearGiveUp.amount).toBeCloseTo(1, 5)
  })

  it('keeps trying eye contact when the head is maxed but the eyes still have range', () => {
    const result = resolveEyeContactChannels(90, 0)

    expect(result.amount).toBeCloseTo(1, 5)
    expect(Math.abs(result.headYaw)).toBeCloseTo(1, 5)
    expect(Math.abs(result.eyeYaw)).toBeGreaterThan(0.4)
  })

  it('uses the inward start angle when the target is returning toward center', () => {
    const outward = resolveEyeContactChannels(35, 0, {
      headYawStartOutDeg: 55,
      headYawStartInDeg: 90
    })
    const inward = resolveEyeContactChannels(
      35,
      0,
      {
        headYawStartOutDeg: 55,
        headYawStartInDeg: 90
      },
      { yawTravel: 'in' }
    )

    expect(Math.abs(outward.headYaw)).toBeCloseTo(0, 5)
    expect(Math.abs(inward.headYaw)).toBeGreaterThan(0.25)
    expect(Math.abs(inward.eyeYaw)).toBeLessThan(Math.abs(outward.eyeYaw))
  })

  it('smoothly fades out only after head and eye yaw are both saturated', () => {
    const result = resolveEyeContactChannels(120, 0)

    expect(result.amount).toBeLessThan(0.4)
  })

  it('uses the same sign for eyes and head so both channels support the same side', () => {
    const left = resolveEyeContactChannels(24, -10)
    const right = resolveEyeContactChannels(-24, 10)

    expect(left.eyeYaw).toBeGreaterThan(0)
    expect(left.headYaw).toBeGreaterThan(0)
    expect(left.eyePitch).toBeLessThan(0)
    expect(left.headPitch).toBeLessThan(0)

    expect(right.eyeYaw).toBeLessThan(0)
    expect(right.headYaw).toBeLessThan(0)
    expect(right.eyePitch).toBeGreaterThan(0)
    expect(right.headPitch).toBeGreaterThan(0)
  })

  it('maps eye channels to look expression fallback weights', () => {
    expect(resolveEyeLookExpressionWeights(0.4, -0.25)).toEqual({
      lookLeft: 0.4,
      lookRight: 0,
      lookUp: 0.25,
      lookDown: 0
    })

    expect(resolveEyeLookExpressionWeights(-0.3, 0.2)).toEqual({
      lookLeft: 0,
      lookRight: 0.3,
      lookUp: 0,
      lookDown: 0.2
    })
  })

  it('applies expression fallback range separately from sensitivity', () => {
    expect(
      resolveEyeLookExpressionWeights(0.4, -0.25, {
        eyeYawRange: 2,
        eyePitchRange: 0.5
      })
    ).toEqual({
      lookLeft: 0.8,
      lookRight: 0,
      lookUp: 0.125,
      lookDown: 0
    })
  })

  it('keeps bone mode strict instead of silently switching to expression', () => {
    expect(
      resolveEyeLookRuntimeLane({
        requestedMode: 'bone',
        lookAtApplierType: 'expression',
        hasUsableLookAtEyeBones: false,
        hasUsableLookExpressions: true,
        hasGuidedDirectionControls: true
      })
    ).toBe('none')
  })

  it('uses the expression look-at applier when expression mode has a real VRM lane', () => {
    expect(
      resolveEyeLookRuntimeLane({
        requestedMode: 'expression',
        lookAtApplierType: 'expression',
        hasUsableLookAtEyeBones: false,
        hasUsableLookExpressions: true,
        hasGuidedDirectionControls: true
      })
    ).toBe('expression-look-at')
  })

  it('uses direct look presets in expression mode when the applier is not expression', () => {
    expect(
      resolveEyeLookRuntimeLane({
        requestedMode: 'expression',
        lookAtApplierType: 'bone',
        hasUsableLookAtEyeBones: true,
        hasUsableLookExpressions: true,
        hasGuidedDirectionControls: true
      })
    ).toBe('expression-presets')
  })

  it('uses guided direction controls in expression mode when VRM look presets are empty', () => {
    expect(
      resolveEyeLookRuntimeLane({
        requestedMode: 'expression',
        lookAtApplierType: 'bone',
        hasUsableLookAtEyeBones: true,
        hasUsableLookExpressions: false,
        hasGuidedDirectionControls: true
      })
    ).toBe('expression-guided-controls')
  })
})
