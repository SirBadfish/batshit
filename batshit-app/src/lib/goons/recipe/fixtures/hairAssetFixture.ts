import {
  HAIR_ASSET_AUDIT_CONTRACT,
  HAIR_ASSET_CONTRACT,
  HAIR_FIT_RECEIPT_CONTRACT,
  HAIR_FOLLOWER_DECLARATION_CONTRACT,
  HAIR_MATERIAL_DECLARATION_CONTRACT,
  HAIR_PHYSICS_DECLARATION_CONTRACT,
  hairAssetRevisionSha256,
  hairFitReceiptSha256,
  hairMaterialDefinitionSha256,
  verifyHairAsset,
  type HairAssetSourceClass,
  type HairAssetV1
} from '../../hairAssets'
import {
  HAIR_APPEARANCE_FOLLOWER_CONTRACT,
  HAIR_FOLLOWER_RISK_MATRIX_CONTRACT,
  HAIR_SCALP_CAGE_CONTRACT,
  type HairFollowerDefinitionV1
} from '../../hairFollowers'
import {
  HAIR_MOTION_DEFAULT_ANCHORED_LENGTH,
  HAIR_MOTION_DEFAULT_INTENSITY,
  HAIR_MOTION_WEIGHT_CURVE,
  HAIR_ROOT_WEIGHTED_MOTION_CONTRACT,
  HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE,
  SECONDARY_MOTION_CONTRACT,
  SECONDARY_MOTION_STRESS_MATRIX_CONTRACT,
  type SecondaryMotionDefinitionV1
} from '../../secondaryMotion'
import { sha256Hex } from '../recipeCanonical'
import type { RecipeSource } from '../recipeContracts'

const ENCODER = new TextEncoder()
const ZERO_SHA256 = '0'.repeat(64)
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

export const HAIR_NEUTRAL_VALUE_PNG_FIXTURE = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0,
  0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5, 1, 1, 39, 24,
  227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
])

export const HAIR_HIGHLIGHT_MASK_PNG_FIXTURE = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0,
  0, 58, 126, 155, 85, 0, 0, 0, 10, 73, 68, 65, 84, 120, 218, 99, 248, 15, 0, 1, 1, 1, 0, 27, 182,
  238, 86, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
])

function align4(value: number): number {
  return Math.ceil(value / 4) * 4
}

function writeGlb(gltf: Record<string, unknown>, binary: Uint8Array): Uint8Array {
  const json = ENCODER.encode(JSON.stringify(gltf))
  const jsonLength = align4(json.byteLength)
  const binaryLength = align4(binary.byteLength)
  const output = new Uint8Array(12 + 8 + jsonLength + 8 + binaryLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, output.byteLength, true)
  view.setUint32(12, jsonLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  output.fill(0x20, 20, 20 + jsonLength)
  output.set(json, 20)
  const binaryHeader = 20 + jsonLength
  view.setUint32(binaryHeader, binaryLength, true)
  view.setUint32(binaryHeader + 4, 0x004e4942, true)
  output.set(binary, binaryHeader + 8)
  return output
}

export function createRigidHairGlbFixture(): Uint8Array {
  const positions = new Float32Array([-0.1, 0, 0, 0.1, 0, 0, 0, 0.2, 0])
  const uvs = new Float32Array([0, 0, 1, 0, 0.5, 1])
  const binary = new Uint8Array(positions.byteLength + uvs.byteLength)
  binary.set(new Uint8Array(positions.buffer.slice(0)), 0)
  binary.set(new Uint8Array(uvs.buffer.slice(0)), positions.byteLength)
  return writeGlb(
    {
      asset: { version: '2.0', generator: 'Batshit H1 rigid Hair fixture' },
      buffers: [{ byteLength: binary.byteLength }],
      bufferViews: [
        {
          buffer: 0,
          byteOffset: 0,
          byteLength: binary.byteLength,
          target: 34962
        },
        {
          buffer: 0,
          byteOffset: positions.byteLength,
          byteLength: uvs.byteLength,
          target: 34962
        }
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [-0.1, 0, 0],
          max: [0.1, 0.2, 0]
        },
        {
          bufferView: 1,
          componentType: 5126,
          count: 3,
          type: 'VEC2',
          min: [0, 0],
          max: [1, 1]
        }
      ],
      meshes: [
        {
          name: 'HairFixtureMesh',
          primitives: [
            {
              attributes: { POSITION: 0, TEXCOORD_0: 1 },
              material: 0,
              mode: 4
            }
          ]
        }
      ],
      materials: [
        {
          name: 'HairFixtureMaterial',
          pbrMetallicRoughness: { baseColorFactor: [0.25, 0.1, 0.35, 1] }
        }
      ],
      nodes: [
        { name: 'HairFixtureRoot', children: [1] },
        { name: 'HairFixtureGeometry', mesh: 0 }
      ],
      scenes: [{ name: 'HairFixtureScene', nodes: [0] }],
      scene: 0
    },
    binary
  )
}

export const HAIR_FOLLOWER_NEGATIVE_FIXTURE = 'HairFollower_head_size_neg'
export const HAIR_FOLLOWER_POSITIVE_FIXTURE = 'HairFollower_head_size_pos'

export function createFollowerHairGlbFixture(): Uint8Array {
  const positions = new Float32Array([-0.1, 0, 0, 0.1, 0, 0, 0, 0.2, 0])
  const uvs = new Float32Array([0, 0, 1, 0, 0.5, 1])
  const negative = new Float32Array([-0.1, 0, 0, -0.1, 0, 0, -0.1, 0, 0])
  const positive = new Float32Array([0.1, 0, 0, 0.1, 0, 0, 0.1, 0, 0])
  const arrays = [positions, uvs, negative, positive]
  const offsets: number[] = []
  let byteLength = 0
  for (const array of arrays) {
    offsets.push(byteLength)
    byteLength += array.byteLength
  }
  const binary = new Uint8Array(byteLength)
  arrays.forEach((array, index) => {
    binary.set(new Uint8Array(array.buffer.slice(0)), offsets[index])
  })
  return writeGlb(
    {
      asset: { version: '2.0', generator: 'Batshit H4 follower Hair fixture' },
      buffers: [{ byteLength }],
      bufferViews: arrays.map((array, index) => ({
        buffer: 0,
        byteOffset: offsets[index],
        byteLength: array.byteLength,
        target: 34962
      })),
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [-0.1, 0, 0],
          max: [0.1, 0.2, 0]
        },
        {
          bufferView: 1,
          componentType: 5126,
          count: 3,
          type: 'VEC2',
          min: [0, 0],
          max: [1, 1]
        },
        {
          bufferView: 2,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [-0.1, 0, 0],
          max: [-0.1, 0, 0]
        },
        {
          bufferView: 3,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [0.1, 0, 0],
          max: [0.1, 0, 0]
        }
      ],
      meshes: [
        {
          name: 'HairFollowerFixtureMesh',
          extras: {
            targetNames: [HAIR_FOLLOWER_NEGATIVE_FIXTURE, HAIR_FOLLOWER_POSITIVE_FIXTURE]
          },
          primitives: [
            {
              attributes: { POSITION: 0, TEXCOORD_0: 1 },
              targets: [{ POSITION: 2 }, { POSITION: 3 }],
              material: 0,
              mode: 4
            }
          ]
        }
      ],
      materials: [{ name: 'HairFollowerFixtureMaterial' }],
      nodes: [
        { name: 'HairFollowerFixtureRoot', children: [1] },
        { name: 'HairFollowerFixtureGeometry', mesh: 0 }
      ],
      scenes: [{ name: 'HairFollowerFixtureScene', nodes: [0] }],
      scene: 0
    },
    binary
  )
}

export function createRootWeightedFollowerHairGlbFixture(): Uint8Array {
  const positions = new Float32Array([-0.1, 0, 0, 0.1, 0, 0, 0, 0.2, 0])
  const uvs = new Float32Array([0, 0, 1, 0, 0.5, 1])
  const negative = new Float32Array([-0.1, 0, 0, -0.1, 0, 0, -0.1, 0, 0])
  const positive = new Float32Array([0.1, 0, 0, 0.1, 0, 0, 0.1, 0, 0])
  const authoredMotionWeights = new Float32Array([0, 0.58, 1])
  const joints = new Uint8Array([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0])
  const weights = new Float32Array([1, 0, 0, 0, 0.42, 0.58, 0, 0, 0, 1, 0, 0])
  const inverseBinds = new Float32Array(32)
  for (const offset of [0, 16]) {
    inverseBinds[offset] = 1
    inverseBinds[offset + 5] = 1
    inverseBinds[offset + 10] = 1
    inverseBinds[offset + 15] = 1
  }
  const arrays = [
    positions,
    uvs,
    negative,
    positive,
    authoredMotionWeights,
    joints,
    weights,
    inverseBinds
  ]
  const offsets: number[] = []
  let byteLength = 0
  for (const array of arrays) {
    byteLength = align4(byteLength)
    offsets.push(byteLength)
    byteLength += array.byteLength
  }
  const binary = new Uint8Array(byteLength)
  arrays.forEach((array, index) => {
    binary.set(
      new Uint8Array(array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength)),
      offsets[index]
    )
  })
  return writeGlb(
    {
      asset: {
        version: '2.0',
        generator: 'Batshit H5 root-weighted follower Hair fixture'
      },
      buffers: [{ byteLength }],
      bufferViews: arrays.map((array, index) => ({
        buffer: 0,
        byteOffset: offsets[index],
        byteLength: array.byteLength,
        ...(index === 7 ? {} : { target: 34962 })
      })),
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [-0.1, 0, 0],
          max: [0.1, 0.2, 0]
        },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
        { bufferView: 2, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 3, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 4, componentType: 5126, count: 3, type: 'SCALAR' },
        { bufferView: 5, componentType: 5121, count: 3, type: 'VEC4' },
        { bufferView: 6, componentType: 5126, count: 3, type: 'VEC4' },
        { bufferView: 7, componentType: 5126, count: 2, type: 'MAT4' }
      ],
      meshes: [
        {
          name: 'HairFollowerFixtureMesh',
          extras: {
            targetNames: [HAIR_FOLLOWER_NEGATIVE_FIXTURE, HAIR_FOLLOWER_POSITIVE_FIXTURE]
          },
          primitives: [
            {
              attributes: {
                POSITION: 0,
                TEXCOORD_0: 1,
                _BATSHAIR_TIP: 4,
                JOINTS_0: 5,
                WEIGHTS_0: 6
              },
              targets: [{ POSITION: 2 }, { POSITION: 3 }],
              material: 0,
              mode: 4
            }
          ]
        }
      ],
      materials: [{ name: 'HairFollowerFixtureMaterial' }],
      skins: [
        {
          name: 'HairFollowerFixtureSkin',
          skeleton: 0,
          joints: [0, 2],
          inverseBindMatrices: 7
        }
      ],
      nodes: [
        { name: 'HairFollowerFixtureRoot', children: [1, 2] },
        { name: 'HairFollowerFixtureGeometry', mesh: 0, skin: 0 },
        {
          name: 'HairFollowerFixtureMotion',
          translation: [0, 0, 0],
          extras: {
            batshitHairRootWeightedMotion: {
              contract: HAIR_ROOT_WEIGHTED_MOTION_CONTRACT,
              meshNode: 'HairFollowerFixtureGeometry',
              tipAttribute: HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE,
              dynamicJointSlot: 1,
              anchoredLength: HAIR_MOTION_DEFAULT_ANCHORED_LENGTH,
              weightCurve: HAIR_MOTION_WEIGHT_CURVE,
              defaultEnabled: true,
              defaultIntensity: HAIR_MOTION_DEFAULT_INTENSITY
            }
          }
        }
      ],
      scenes: [{ name: 'HairFollowerFixtureScene', nodes: [0] }],
      scene: 0
    },
    binary
  )
}

export function createHairFollowerDefinitionFixture(input: {
  recipeSource: RecipeSource
  geometrySha256: string
  headNode: string
}): HairFollowerDefinitionV1 {
  return {
    contract: HAIR_APPEARANCE_FOLLOWER_CONTRACT,
    appearanceFollowerContract: 'appearance-followers/v2',
    assetId: 'h1-test-hair',
    revisionId: 'h1-test-hair-r1',
    geometrySha256: input.geometrySha256,
    fitFamily: input.recipeSource.identities.fitFamily,
    appearanceDefinitionSha256: input.recipeSource.identities.definitionSha256,
    headNode: input.headNode,
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
      {
        id: 'global-head',
        curve: 'smoothstep-root-to-tip/v1',
        tipWeight: 0.78
      },
      {
        id: 'scalp-shape',
        curve: 'smoothstep-root-to-tip/v1',
        tipWeight: 0.32
      },
      {
        id: 'local-clearance',
        curve: 'smoothstep-root-to-tip/v1',
        tipWeight: 0.08
      }
    ],
    morphTargets: [
      {
        name: HAIR_FOLLOWER_NEGATIVE_FIXTURE,
        driver: { kind: 'dial-endpoint', dialId: 'head_size', endpoint: -1 },
        falloffProfile: 'global-head'
      },
      {
        name: HAIR_FOLLOWER_POSITIVE_FIXTURE,
        driver: { kind: 'dial-endpoint', dialId: 'head_size', endpoint: 1 },
        falloffProfile: 'global-head'
      }
    ],
    correctives: [],
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

export function createHairSecondaryMotionDefinitionFixture(input: {
  recipeSource: RecipeSource
  geometrySha256: string
  motionNode: string
  colliderNode: string
}): SecondaryMotionDefinitionV1 {
  return {
    contract: SECONDARY_MOTION_CONTRACT,
    owner: {
      kind: 'hair',
      assetId: 'h1-test-hair',
      revisionId: 'h1-test-hair-r1',
      geometrySha256: input.geometrySha256,
      fitFamily: input.recipeSource.identities.fitFamily,
      appearanceDefinitionSha256: input.recipeSource.identities.definitionSha256
    },
    chainSpace: 'asset-root-rest',
    colliderSpace: 'node-local-rest',
    simulation: {
      fixedStepSeconds: 1 / 120,
      maxSubsteps: 8,
      interruptionResetSeconds: 0.25,
      gravity: [0, -9.81, 0],
      collisionIterations: 2
    },
    chains: [
      {
        id: 'Hair_Fixture',
        segments: [
          {
            node: input.motionNode,
            pivot: [0, 0, 0],
            tip: [0, 0.2, 0],
            stiffness: 80,
            damping: 12,
            drag: 0.01,
            gravityScale: 0.05,
            maxAngleRadians: 0.4,
            collisionRadius: 0.01,
            collisionGroups: ['head'],
            drivers: []
          }
        ]
      }
    ],
    colliders: [
      {
        id: 'fixture-head',
        group: 'head',
        shape: 'sphere',
        node: input.colliderNode,
        offset: [0, 0, 0],
        tailOffset: [0, 0, 0],
        radius: 0.1,
        drivers: []
      }
    ],
    stressMatrix: {
      contract: SECONDARY_MOTION_STRESS_MATRIX_CONTRACT,
      scenarios: [
        { id: 'idle', durationSeconds: 1 },
        { id: 'head-turn', durationSeconds: 1 },
        { id: 'walk-dance', durationSeconds: 1 },
        { id: 'bend', durationSeconds: 1 },
        { id: 'interruption', durationSeconds: 1 }
      ],
      thresholds: {
        maximumStretchRatio: 1.001,
        maximumColliderPenetration: 0.002,
        maximumSettleSeconds: 2
      }
    }
  }
}

export async function createHairAssetFixture(input: {
  recipeSource: RecipeSource
  mainBytes: Uint8Array
  headNode: string
  sourceClass?: HairAssetSourceClass
  tags?: string[]
  follower?: {
    bytes: Uint8Array
    definitionSha256: string
  }
  physics?: {
    bytes: Uint8Array
    definitionSha256: string
  }
}): Promise<HairAssetV1> {
  const mainSha256 = await sha256Hex(input.mainBytes)
  const neutralValueSha256 = await sha256Hex(HAIR_NEUTRAL_VALUE_PNG_FIXTURE)
  const highlightMaskSha256 = await sha256Hex(HAIR_HIGHLIGHT_MASK_PNG_FIXTURE)
  const sourceClass = input.sourceClass ?? 'builtin'
  const followerSha256 = input.follower ? await sha256Hex(input.follower.bytes) : null
  const physicsSha256 = input.physics ? await sha256Hex(input.physics.bytes) : null
  const prefix =
    sourceClass === 'builtin'
      ? '/goon-assets/hair/v1/h1-test-fixture/'
      : '/uploads/goon_hair_assets/h1-test-fixture/'
  const draft = {
    schemaVersion: HAIR_ASSET_CONTRACT,
    assetId: 'h1-test-hair',
    revisionId: 'h1-test-hair-r1',
    revision: 1,
    revisionSha256: ZERO_SHA256,
    sourceClass,
    display: {
      name: 'H1 Test Hair',
      previewImage: {
        ref: `${prefix}preview.json`,
        sha256: HASH_A,
        bytes: 1,
        mimeType: 'application/json'
      },
      tags: ['test-fixture', ...(input.tags ?? [])].sort()
    },
    compatibility: {
      baseId: input.recipeSource.identities.baseId,
      fitFamily: input.recipeSource.identities.fitFamily
    },
    geometry: {
      main: {
        ref: `${prefix}hair.glb`,
        sha256: mainSha256,
        bytes: input.mainBytes.byteLength,
        mimeType: 'model/gltf-binary'
      },
      sparseAccent: null
    },
    attachment: {
      headNode: input.headNode,
      authoredRootMatrix: [...IDENTITY],
      fitReceipt: {
        contract: HAIR_FIT_RECEIPT_CONTRACT,
        receiptId: 'h1-test-hair-fit-r1',
        assetId: 'h1-test-hair',
        assetRevisionId: 'h1-test-hair-r1',
        assetRevisionSha256: ZERO_SHA256,
        baseId: input.recipeSource.identities.baseId,
        fitFamily: input.recipeSource.identities.fitFamily,
        headAttachmentNode: input.headNode,
        appearanceDefinitionSha256: input.recipeSource.identities.definitionSha256,
        physicalBasisSha256: input.recipeSource.identities.physicalBasisSha256,
        topologySha256: input.recipeSource.identities.topologySha256,
        skeletonHierarchySha256: input.recipeSource.identities.skeletonHierarchySha256,
        fitSha256: ZERO_SHA256
      }
    },
    material: {
      contract: HAIR_MATERIAL_DECLARATION_CONTRACT,
      status: 'ready' as const,
      definitionSha256: ZERO_SHA256,
      layout: {
        width: 1,
        height: 1,
        uvSet: 0 as const,
        flipY: false as const,
        neutralValue: {
          colorSpace: 'srgb' as const,
          channel: 'rgb' as const,
          pivot: 0.5 as const,
          highlightStrength: 0.35 as const
        },
        highlightMask: { colorSpace: 'linear' as const, channel: 'r' as const },
        normal: null,
        roughness: null
      },
      neutralValueTexture: {
        ref: `${prefix}neutral-value.png`,
        sha256: neutralValueSha256,
        bytes: HAIR_NEUTRAL_VALUE_PNG_FIXTURE.byteLength,
        mimeType: 'image/png'
      },
      highlightMask: {
        ref: `${prefix}highlight-mask.png`,
        sha256: highlightMaskSha256,
        bytes: HAIR_HIGHLIGHT_MASK_PNG_FIXTURE.byteLength,
        mimeType: 'image/png'
      },
      normalTexture: null,
      roughnessTexture: null,
      defaults: {
        baseColor: '#2a1738',
        highlightColor: '#6f4a8e',
        metalness: 0,
        roughness: 0.55,
        alphaMode: 'OPAQUE' as const
      }
    },
    follower: {
      contract: HAIR_FOLLOWER_DECLARATION_CONTRACT,
      ...(input.follower
        ? {
            mode: 'appearance-followers/v2' as const,
            definitionSha256: input.follower.definitionSha256,
            asset: {
              ref: `${prefix}appearance-followers.json`,
              sha256: followerSha256!,
              bytes: input.follower.bytes.byteLength,
              mimeType: 'application/json'
            },
            staticReason: null
          }
        : {
            mode: 'static' as const,
            definitionSha256: null,
            asset: null,
            staticReason: 'approved-short-static' as const
          })
    },
    physics: {
      contract: HAIR_PHYSICS_DECLARATION_CONTRACT,
      ...(input.physics
        ? {
            mode: 'secondary-motion/v1' as const,
            definitionSha256: input.physics.definitionSha256,
            asset: {
              ref: `${prefix}secondary-motion.json`,
              sha256: physicsSha256!,
              bytes: input.physics.bytes.byteLength,
              mimeType: 'application/json'
            },
            staticReason: null
          }
        : {
            mode: 'static' as const,
            definitionSha256: null,
            asset: null,
            staticReason: 'approved-short-static' as const
          })
    },
    audit: {
      contract: HAIR_ASSET_AUDIT_CONTRACT,
      meshCount: 1,
      vertexCount: 3,
      triangleCount: 1,
      materialCount: 1,
      textureCount: 2,
      sparseAccent: false,
      receiptSha256: HASH_A
    },
    provenance: {
      author: sourceClass === 'builtin' ? 'Batshit test fixture' : 'Local test user',
      license: sourceClass === 'builtin' ? 'test-only' : 'user-provided',
      sourceTool: 'deterministic fixture',
      sourceSha256: mainSha256,
      catalogEligible: sourceClass === 'builtin',
      productExportApproved: sourceClass === 'builtin'
    },
    receiptRefs: [
      {
        ref: `${prefix}creation-receipt.json`,
        sha256: HASH_B,
        bytes: 1,
        mimeType: 'application/json'
      }
    ]
  }
  draft.material.definitionSha256 = await hairMaterialDefinitionSha256(draft.material)
  draft.revisionSha256 = await hairAssetRevisionSha256(draft)
  draft.attachment.fitReceipt.assetRevisionSha256 = draft.revisionSha256
  draft.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(draft.attachment.fitReceipt)
  return verifyHairAsset(draft)
}
