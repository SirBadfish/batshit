import { describe, expect, test } from 'vitest'

import {
  EMBEDDED_SECONDARY_MOTION_CONTRACT,
  SECONDARY_MOTION_CONTRACT,
  SECONDARY_MOTION_STRESS_MATRIX_CONTRACT,
  createEmbeddedSecondaryMotion,
  parseEmbeddedSecondaryMotion,
  parseSecondaryMotionDefinition,
  resolveSecondaryMotionColliders,
  runtimeSecondaryMotionDefinition,
  secondaryMotionDefinitionSha256,
  type SecondaryMotionDefinitionV1
} from './secondaryMotion'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

export function secondaryMotionFixture(): SecondaryMotionDefinitionV1 {
  return {
    contract: SECONDARY_MOTION_CONTRACT,
    owner: {
      kind: 'hair',
      assetId: 'style-01',
      revisionId: 'style-01-r5',
      geometrySha256: HASH_A,
      fitFamily: 'batshit-base-female-v1',
      appearanceDefinitionSha256: HASH_B
    },
    chainSpace: 'asset-root-rest',
    colliderSpace: 'node-local-rest',
    simulation: {
      fixedStepSeconds: 1 / 120,
      maxSubsteps: 8,
      interruptionResetSeconds: 0.25,
      gravity: [0, -9.81, 0],
      collisionIterations: 3
    },
    chains: [
      {
        id: 'Hair_FrontClump',
        segments: [
          {
            node: 'HairClump01',
            pivot: [0, 0.16, 0],
            tip: [0, 0.34, 0.02],
            stiffness: 85,
            damping: 12,
            drag: 0.01,
            gravityScale: 0.08,
            maxAngleRadians: 0.45,
            collisionRadius: 0.015,
            collisionGroups: ['head', 'body'],
            drivers: [
              {
                kind: 'dial-endpoint',
                dialId: 'head_size',
                endpoint: 1,
                pivotDelta: [0, 0.01, 0],
                tipDelta: [0, 0.02, 0]
              }
            ]
          }
        ]
      }
    ],
    colliders: [
      {
        id: 'head-shell',
        group: 'head',
        shape: 'sphere',
        node: 'head',
        offset: [0, 0.08, 0],
        tailOffset: [0, 0.08, 0],
        radius: 0.12,
        drivers: [
          {
            dialId: 'head_size',
            endpoint: 1,
            offsetDelta: [0, 0.01, 0],
            tailOffsetDelta: [0, 0.01, 0],
            radiusDelta: 0.02
          }
        ]
      },
      {
        id: 'torso-shell',
        group: 'body',
        shape: 'capsule',
        node: 'chest',
        offset: [0, 0.08, 0],
        tailOffset: [0, -0.12, 0],
        radius: 0.1,
        drivers: []
      }
    ],
    stressMatrix: {
      contract: SECONDARY_MOTION_STRESS_MATRIX_CONTRACT,
      scenarios: [
        { id: 'idle', durationSeconds: 4 },
        { id: 'head-turn', durationSeconds: 3 },
        { id: 'walk-dance', durationSeconds: 6 },
        { id: 'bend', durationSeconds: 4 },
        { id: 'interruption', durationSeconds: 2 }
      ],
      thresholds: {
        maximumStretchRatio: 1.001,
        maximumColliderPenetration: 0.002,
        maximumSettleSeconds: 2
      }
    }
  }
}

describe('secondary-motion/v1', () => {
  test('strictly parses the reusable H5 contract and hashes deterministically', async () => {
    const fixture = secondaryMotionFixture()
    const parsed = parseSecondaryMotionDefinition(fixture)
    expect(parsed).toEqual(fixture)
    expect(await secondaryMotionDefinitionSha256(parsed)).toMatch(/^[a-f0-9]{64}$/)
    expect(() => parseSecondaryMotionDefinition({ ...fixture, surprise: true })).toThrow(
      /must contain exactly/
    )
    const wrongPrefix = structuredClone(fixture)
    wrongPrefix.chains[0]!.id = 'front-clump'
    expect(() => parseSecondaryMotionDefinition(wrongPrefix)).toThrow(/Hair_ prefix/)
  })

  test('resolves collider dial drivers without mutating the immutable definition', () => {
    const fixture = secondaryMotionFixture()
    const resolved = resolveSecondaryMotionColliders(fixture, {
      values: { head_size: 0.5 }
    })
    expect(resolved[0]).toMatchObject({
      radius: 0.13,
      offset: [0, 0.085, 0],
      tailOffset: [0, 0.085, 0]
    })
    expect(fixture.colliders[0]!.radius).toBe(0.12)
  })

  test('embeds only resolved self-contained runtime state for the Live Goon', async () => {
    const embedded = await createEmbeddedSecondaryMotion(secondaryMotionFixture(), {
      values: { head_size: 1 }
    }, {
      enabled: true,
      intensity: 1.1
    })
    expect(embedded.contract).toBe(EMBEDDED_SECONDARY_MOTION_CONTRACT)
    expect(embedded.motionSettings).toEqual({
      enabled: true,
      intensity: 1.1
    })
    expect(embedded.chains[0]!.segments[0]!.pivot).toEqual([0, 0.17, 0])
    expect('drivers' in embedded.chains[0]!.segments[0]!).toBe(false)
    expect(embedded.colliders[0]!.radius).toBeCloseTo(0.14)
    expect('drivers' in embedded.colliders[0]!).toBe(false)
    expect(parseEmbeddedSecondaryMotion(embedded)).toEqual(embedded)
    expect(runtimeSecondaryMotionDefinition(embedded).colliders).toEqual(embedded.colliders)
  })
})
