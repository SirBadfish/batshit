import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { HairFollowerEngineRuntime } from './hairFollowers.engine'
import {
  HAIR_APPEARANCE_FOLLOWER_CONTRACT,
  HAIR_FOLLOWER_RISK_MATRIX_CONTRACT,
  HAIR_SCALP_CAGE_CONTRACT,
  hairFollowerDefinitionSha256,
  parseHairFollowerDefinition,
  resolveHairFollowerWeights,
  type HairFollowerDefinitionV1
} from './hairFollowers'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function definition(): HairFollowerDefinitionV1 {
  return {
    contract: HAIR_APPEARANCE_FOLLOWER_CONTRACT,
    appearanceFollowerContract: 'appearance-followers/v2',
    assetId: 'hair-test',
    revisionId: 'hair-test-r2',
    geometrySha256: HASH_A,
    fitFamily: 'test-base',
    appearanceDefinitionSha256: HASH_B,
    headNode: 'Head',
    sourceBodyNode: 'Body',
    scalpCage: {
      contract: HAIR_SCALP_CAGE_CONTRACT,
      space: 'avatar-root-rest',
      rootBounds: { minimum: [-1, 0, -1], maximum: [1, 2, 1] },
      transferBounds: { minimum: [-2, -1, -2], maximum: [2, 2, 2] },
      nearestNeighbors: 4,
      rootSeedFraction: 0.08,
      topology: 'triangle-geodesic/v1'
    },
    falloffProfiles: [
      { id: 'global-head', curve: 'smoothstep-root-to-tip/v1', tipWeight: 0.78 },
      { id: 'scalp-shape', curve: 'smoothstep-root-to-tip/v1', tipWeight: 0.32 },
      { id: 'local-clearance', curve: 'smoothstep-root-to-tip/v1', tipWeight: 0.08 }
    ],
    morphTargets: [
      {
        name: 'HairFollower_head_size_neg',
        driver: { kind: 'dial-endpoint', dialId: 'head_size', endpoint: -1 },
        falloffProfile: 'global-head'
      },
      {
        name: 'HairFollower_head_size_pos',
        driver: { kind: 'dial-endpoint', dialId: 'head_size', endpoint: 1 },
        falloffProfile: 'global-head'
      },
      {
        name: 'HairFollower_macro_muscle_pos',
        driver: { kind: 'dial-endpoint', dialId: 'macro_muscle', endpoint: 0.5 },
        falloffProfile: 'local-clearance'
      }
    ],
    correctives: [
      {
        name: 'HairFollower_combination_corrective',
        activation: {
          kind: 'bounded-product',
          terms: [
            { dialId: 'head_size', endpoint: 1 },
            { dialId: 'macro_muscle', endpoint: 0.5 }
          ],
          maxWeight: 0.8
        }
      }
    ],
    riskMatrix: {
      contract: HAIR_FOLLOWER_RISK_MATRIX_CONTRACT,
      scenarios: Array.from({ length: 8 }, (_, index) => ({
        id: `risk-${index + 1}`,
        values: { head_size: index % 2 === 0 ? -1 : 1 }
      })),
      thresholds: {
        maximumRootGapChange: 0.025,
        maximumClearanceLoss: 0.018,
        structuralEdgeMinimumLength: 0.005,
        minimumAbsoluteStretch: 0.005,
        maximumTipEdgeStretchRatio: 1.4,
        minimumSilhouetteDimensionRatio: 0.7,
        maximumSilhouetteDimensionRatio: 1.45
      }
    }
  }
}

function runtimeRoot(targetNames: string[]) {
  const root = new THREE.Group()
  for (const name of ['HairA', 'HairB']) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.1, 0, 0, 0.1, 0, 0, 0, 0.2, 0], 3)
    )
    geometry.morphAttributes.position = targetNames.map((targetName) => {
      const attribute = new THREE.Float32BufferAttribute(new Array(9).fill(0), 3)
      attribute.name = targetName
      return attribute
    })
    geometry.morphTargetsRelative = true
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
    mesh.name = name
    root.add(mesh)
  }
  return root
}

describe('hair-appearance-followers/v1', () => {
  it('parses and hashes the exact scalp, falloff, driver, corrective, and risk contracts', async () => {
    const value = definition()
    expect(parseHairFollowerDefinition(value)).toEqual(value)
    await expect(hairFollowerDefinitionSha256(value)).resolves.toMatch(/^[a-f0-9]{64}$/)

    const drifted = structuredClone(value)
    drifted.scalpCage.nearestNeighbors = 3 as 4
    expect(() => parseHairFollowerDefinition(drifted)).toThrow('canonical cage contract')
  })

  it('normalizes asymmetric endpoint ranges and bounds combination correctives', () => {
    const weights = resolveHairFollowerWeights(definition(), {
      values: { head_size: 0.5, macro_muscle: 0.25 }
    })
    expect(weights.get('HairFollower_head_size_neg')).toBe(0)
    expect(weights.get('HairFollower_head_size_pos')).toBe(0.5)
    expect(weights.get('HairFollower_macro_muscle_pos')).toBe(0.5)
    expect(weights.get('HairFollower_combination_corrective')).toBe(0.25)
  })

  it('applies the exact morph inventory to every Hair mesh and clears it on disposal', () => {
    const value = definition()
    const names = [
      ...value.morphTargets.map((entry) => entry.name),
      ...value.correctives.map((entry) => entry.name)
    ]
    const root = runtimeRoot(names)
    const runtime = new HairFollowerEngineRuntime(root, value)
    runtime.apply({ values: { head_size: 1, macro_muscle: 0.5 } })
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      expect(object.morphTargetInfluences).toEqual([0, 1, 1, 0.8])
    })
    runtime.dispose()
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) expect(object.morphTargetInfluences).toEqual([0, 0, 0, 0])
    })
  })

  it('fails closed when even one runtime mesh has a drifted target inventory', () => {
    const value = definition()
    const root = runtimeRoot(value.morphTargets.map((entry) => entry.name))
    expect(() => new HairFollowerEngineRuntime(root, value)).toThrow(
      'drifted follower morph inventory'
    )
  })
})
