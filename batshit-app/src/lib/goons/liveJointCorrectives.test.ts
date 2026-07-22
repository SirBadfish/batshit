import { describe, expect, it } from 'vitest'
import {
  evaluateLiveJointCorrectiveAngles,
  evaluateLiveJointCorrectives,
  parseLiveJointCorrectives,
  type LiveJointCorrectivesSpec
} from './liveJointCorrectives'

function fixture(): LiveJointCorrectivesSpec {
  const parsed = parseLiveJointCorrectives({
    contract: 'joint-angle-live-corrective/v1',
    drivers: [
      {
        id: 'hips-flex',
        kind: 'swing-angle',
        combine: 'mean',
        clampDeg: [0, 120],
        bones: [
          {
            bone: 'LeftUpLeg',
            restRotation: [0, 0, 0, 1],
            axisRestLocal: [1, 0, 0]
          }
        ]
      }
    ],
    entries: [
      {
        id: 'left-seat',
        driver: 'hips-flex',
        node: 'Body',
        morph: 'seat_corrective',
        baseInfluence: 0.2,
        anchor: 0.4,
        influenceMin: -1,
        influenceMax: 1,
        angleCurve: [
          [0, 0],
          [90, 1]
        ],
        mode: 'additive'
      },
      {
        id: 'right-seat',
        driver: 'hips-flex',
        node: 'Body',
        morph: 'seat_corrective',
        baseInfluence: 0.2,
        anchor: 0.3,
        influenceMin: -1,
        influenceMax: 1,
        angleCurve: [
          [0, 0],
          [90, 1]
        ],
        mode: 'additive'
      }
    ]
  })
  if (!parsed) throw new Error('fixture did not parse')
  return parsed
}

describe('Live Goon joint correctives', () => {
  it('accumulates projected entries onto the baked base and clamps once', () => {
    const values = evaluateLiveJointCorrectiveAngles(fixture(), { 'hips-flex': 45 })
    expect(values.get('Body\u0000seat_corrective')).toBeCloseTo(0.55, 12)
  })

  it('uses the shared measured driver frame for posed rotations', () => {
    const halfAngle = Math.PI / 8
    const values = evaluateLiveJointCorrectives(fixture(), {
      'hips-flex': [[Math.sin(halfAngle), 0, 0, Math.cos(halfAngle)]]
    })
    expect(values.get('Body\u0000seat_corrective')).toBeCloseTo(0.55, 12)
  })

  it('fails closed on inconsistent duplicate binding contracts', () => {
    const raw = structuredClone(fixture())
    raw.entries[1]!.baseInfluence = 0.1
    expect(() => parseLiveJointCorrectives(raw)).toThrow(/disagree on base influence/)
  })

  it('rejects unknown fields at every runtime-contract level', () => {
    const invalidRoot = { ...fixture(), ignored: true }
    expect(() => parseLiveJointCorrectives(invalidRoot)).toThrow(/must contain exactly/)

    const invalidDriver = structuredClone(fixture())
    const driverRecord = invalidDriver.drivers[0] as unknown as Record<string, unknown>
    driverRecord.ignored = true
    expect(() => parseLiveJointCorrectives(invalidDriver)).toThrow(/must contain exactly/)

    const invalidEntry = structuredClone(fixture())
    const entryRecord = invalidEntry.entries[0] as unknown as Record<string, unknown>
    entryRecord.ignored = true
    expect(() => parseLiveJointCorrectives(invalidEntry)).toThrow(/must contain exactly/)
  })
})
