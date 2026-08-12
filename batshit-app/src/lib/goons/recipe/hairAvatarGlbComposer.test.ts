import { describe, expect, it } from 'vitest'
import {
  composeHairIntoAvatarGlb,
  HAIR_AVATAR_GLB_COMPOSER_CONTRACT
} from './hairAvatarGlbComposer'
import { parseSemanticGlb } from './semanticGlb'
import {
  createEmbeddedSecondaryMotion,
  HAIR_MOTION_DEFAULT_ANCHORED_LENGTH,
  HAIR_MOTION_DEFAULT_INTENSITY,
  HAIR_MOTION_WEIGHT_CURVE,
  HAIR_ROOT_WEIGHTED_MOTION_CONTRACT,
  HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE
} from '../secondaryMotion'
import { secondaryMotionFixture } from '../secondaryMotion.test'

type JsonRecord = Record<string, unknown>

const ENCODER = new TextEncoder()
const IDENTITY_WITH_ATTACHMENT_OFFSET = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.125, 0.25, -0.5, 1
] as const

function align4(value: number): number {
  return Math.ceil(value / 4) * 4
}

function makeGlb(gltf: JsonRecord, binary: Uint8Array): Uint8Array {
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

function trianglePositions(): Uint8Array {
  const values = new Float32Array([-0.1, 0, 0, 0.1, 0, 0, 0, 0.2, 0])
  return new Uint8Array(values.buffer.slice(0))
}

function sourceFixture(): {
  gltf: JsonRecord
  binary: Uint8Array
  bytes: Uint8Array
} {
  const binary = trianglePositions()
  const gltf: JsonRecord = {
    asset: { version: '2.0', generator: 'verified-source-fixture' },
    extensionsUsed: ['KHR_materials_unlit'],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }
    ],
    materials: [
      {
        name: 'BodyMaterial',
        extensions: { KHR_materials_unlit: {} }
      }
    ],
    meshes: [
      {
        name: 'BodyMesh',
        weights: [0],
        primitives: [
          {
            attributes: { POSITION: 0 },
            material: 0,
            targets: [{ POSITION: 1 }]
          }
        ]
      }
    ],
    skins: [{ name: 'AvatarSkin', joints: [1] }],
    nodes: [
      { name: 'AvatarRoot', children: [1, 2] },
      { name: 'Head' },
      { name: 'Body', mesh: 0, skin: 0, weights: [0] }
    ],
    scenes: [{ name: 'AvatarScene', nodes: [0] }],
    scene: 0,
    extras: { preservedSourceMarker: 'source-semantics' }
  }
  return { gltf, binary, bytes: makeGlb(gltf, binary) }
}

function hairFixture(): {
  gltf: JsonRecord
  binary: Uint8Array
  bytes: Uint8Array
} {
  const positions = trianglePositions()
  const binary = new Uint8Array(48)
  binary.set(positions, 0)
  const view = new DataView(binary.buffer)
  view.setUint16(36, 0, true)
  view.setUint16(38, 1, true)
  view.setUint16(40, 2, true)
  binary.set([0x89, 0x50, 0x4e, 0x47], 44)
  const gltf: JsonRecord = {
    asset: { version: '2.0', generator: 'verified-hair-fixture' },
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
      { buffer: 0, byteOffset: 44, byteLength: 4 }
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
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    images: [{ name: 'HairBase', bufferView: 2, mimeType: 'image/png' }],
    samplers: [{ magFilter: 9729, minFilter: 9987 }],
    textures: [{ name: 'HairBaseTexture', sampler: 0, source: 0 }],
    materials: [
      {
        name: 'HairMaterial',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0,
          roughnessFactor: 0.8
        }
      }
    ],
    meshes: [
      {
        name: 'HairMesh',
        primitives: [
          {
            attributes: { POSITION: 0 },
            indices: 1,
            material: 0,
            mode: 4
          }
        ]
      }
    ],
    nodes: [
      { name: 'HairRoot', translation: [7, 8, 9], children: [1] },
      { name: 'HairGeometry', mesh: 0 }
    ],
    scenes: [{ name: 'HairScene', nodes: [0] }],
    scene: 0
  }
  return { gltf, binary, bytes: makeGlb(gltf, binary) }
}

function rootWeightedHairFixture(): Uint8Array {
  const binary = new Uint8Array(244)
  binary.set(trianglePositions(), 0)
  const view = new DataView(binary.buffer)
  view.setUint16(36, 0, true)
  view.setUint16(38, 1, true)
  view.setUint16(40, 2, true)
  binary.set(new Uint8Array(new Float32Array([0, 0.58, 1]).buffer), 44)
  binary.set(new Uint8Array([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0]), 56)
  binary.set(
    new Uint8Array(
      new Float32Array([1, 0, 0, 0, 0.42, 0.58, 0, 0, 0, 1, 0, 0]).buffer
    ),
    68
  )
  const inverseBinds = new Float32Array(32)
  for (const offset of [0, 16]) {
    inverseBinds[offset] = 1
    inverseBinds[offset + 5] = 1
    inverseBinds[offset + 10] = 1
    inverseBinds[offset + 15] = 1
  }
  binary.set(new Uint8Array(inverseBinds.buffer), 116)
  return makeGlb(
    {
      asset: { version: '2.0', generator: 'root-weighted-hair-fixture' },
      buffers: [{ byteLength: binary.byteLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
        { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
        { buffer: 0, byteOffset: 44, byteLength: 12, target: 34962 },
        { buffer: 0, byteOffset: 56, byteLength: 12, target: 34962 },
        { buffer: 0, byteOffset: 68, byteLength: 48, target: 34962 },
        { buffer: 0, byteOffset: 116, byteLength: 128 }
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
        { bufferView: 2, componentType: 5126, count: 3, type: 'SCALAR' },
        { bufferView: 3, componentType: 5121, count: 3, type: 'VEC4' },
        { bufferView: 4, componentType: 5126, count: 3, type: 'VEC4' },
        { bufferView: 5, componentType: 5126, count: 2, type: 'MAT4' }
      ],
      meshes: [
        {
          name: 'HairMesh',
          primitives: [
            {
              attributes: {
                POSITION: 0,
                _BATSHAIR_TIP: 2,
                JOINTS_0: 3,
                WEIGHTS_0: 4
              },
              indices: 1,
              mode: 4
            }
          ]
        }
      ],
      skins: [
        {
          name: 'HairSkin',
          skeleton: 0,
          joints: [0, 2],
          inverseBindMatrices: 5
        }
      ],
      nodes: [
        { name: 'HairRoot', children: [1, 2] },
        { name: 'HairGeometry', mesh: 0, skin: 0 },
        {
          name: 'HairMotion',
          translation: [0, 0, 0],
          extras: {
            batshitHairRootWeightedMotion: {
              contract: HAIR_ROOT_WEIGHTED_MOTION_CONTRACT,
              meshNode: 'HairGeometry',
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
      scenes: [{ name: 'HairScene', nodes: [0] }],
      scene: 0
    },
    binary
  )
}

function mixedRigidAndRootWeightedHairFixture(): Uint8Array {
  const parsed = parseSemanticGlb(rootWeightedHairFixture())
  const gltf = cloneRecord(parsed.gltf)
  const meshes = gltf.meshes as JsonRecord[]
  const nodes = gltf.nodes as JsonRecord[]
  const root = nodes[0]!
  const rigidNodeIndex = nodes.length
  meshes.push({
    name: 'RigidHairMesh',
    primitives: [
      {
        attributes: { POSITION: 0 },
        indices: 1,
        mode: 4
      }
    ]
  })
  nodes.push({ name: 'RigidHairGeometry', mesh: meshes.length - 1 })
  root.children = [...(root.children as number[]), rigidNodeIndex]
  return makeGlb(gltf, parsed.binary)
}

function cloneRecord(value: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord
}

function compose(
  sourceBytes: Uint8Array,
  hairBytes: Uint8Array,
  attachment: {
    headNode?: string
    authoredRootMatrix?: readonly number[]
  } = {}
): Uint8Array {
  return composeHairIntoAvatarGlb({
    sourceAvatarGlb: sourceBytes,
    hairGlb: hairBytes,
    attachment: {
      headNode: attachment.headNode ?? 'Head',
      authoredRootMatrix: attachment.authoredRootMatrix ?? IDENTITY_WITH_ATTACHMENT_OFFSET
    }
  })
}

describe('composeHairIntoAvatarGlb', () => {
  it('deterministically appends polygon Hair resources beneath the declared head', () => {
    const source = sourceFixture()
    const hair = hairFixture()
    const sourceBefore = Uint8Array.from(source.bytes)
    const hairBefore = Uint8Array.from(hair.bytes)

    const first = compose(source.bytes, hair.bytes)
    const second = compose(source.bytes, hair.bytes)

    expect(first).toEqual(second)
    expect(source.bytes).toEqual(sourceBefore)
    expect(hair.bytes).toEqual(hairBefore)

    const parsed = parseSemanticGlb(first)
    expect(parsed.binary.byteLength).toBe(84)
    expect(parsed.binary.subarray(0, source.binary.byteLength)).toEqual(source.binary)
    expect(parsed.binary.subarray(36)).toEqual(hair.binary)
    expect(parsed.gltf.scene).toBe(0)
    expect(parsed.gltf.scenes).toEqual(source.gltf.scenes)
    expect(parsed.gltf.extensionsUsed).toEqual(['KHR_materials_unlit'])
    expect(parsed.gltf.extras).toEqual({
      preservedSourceMarker: 'source-semantics'
    })
    expect(parsed.skins).toEqual([{ name: 'AvatarSkin', joints: [1] }])

    expect(parsed.nodes).toHaveLength(5)
    expect(parsed.nodes[1]?.children).toEqual([3])
    expect(parsed.nodes[2]).toEqual({
      name: 'Body',
      mesh: 0,
      skin: 0,
      weights: [0]
    })
    expect(parsed.nodes[3]).toEqual({
      name: 'HairRoot',
      children: [4],
      matrix: [...IDENTITY_WITH_ATTACHMENT_OFFSET]
    })
    expect(parsed.nodes[4]).toEqual({ name: 'HairGeometry', mesh: 1 })
    expect(parsed.parents.get(3)).toBe(1)
    expect(parsed.parents.get(4)).toBe(3)

    const meshes = parsed.gltf.meshes as JsonRecord[]
    expect(meshes[0]).toEqual(source.gltf.meshes?.[0])
    expect(meshes[1]).toMatchObject({
      name: 'HairMesh',
      primitives: [
        {
          attributes: { POSITION: 2 },
          indices: 3,
          material: 1,
          mode: 4
        }
      ]
    })
    expect(parsed.gltf.images).toEqual([{ name: 'HairBase', bufferView: 3, mimeType: 'image/png' }])
    expect(parsed.gltf.textures).toEqual([{ name: 'HairBaseTexture', sampler: 0, source: 0 }])
    expect(parsed.gltf.materials).toEqual([
      source.gltf.materials?.[0],
      {
        name: 'HairMaterial',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0,
          roughnessFactor: 0.8
        }
      }
    ])
  })

  it('preserves only the declared root-weighted Hair skin and remaps its ownership', async () => {
    const source = sourceFixture()
    const definition = secondaryMotionFixture()
    const segment = definition.chains[0]!.segments[0]!
    segment.node = 'HairMotion'
    segment.pivot = [0, 0, 0]
    segment.tip = [0, 0.2, 0]
    const secondaryMotion = await createEmbeddedSecondaryMotion(definition, { values: {} })
    const output = composeHairIntoAvatarGlb({
      sourceAvatarGlb: source.bytes,
      hairGlb: rootWeightedHairFixture(),
      attachment: {
        headNode: 'Head',
        authoredRootMatrix: IDENTITY_WITH_ATTACHMENT_OFFSET
      },
      sourceSecondaryMotion: definition,
      secondaryMotion
    })
    const parsed = parseSemanticGlb(output)
    expect(parsed.skins).toHaveLength(2)
    expect(parsed.skins[1]).toMatchObject({
      name: 'HairSkin',
      skeleton: 3,
      joints: [3, 5]
    })
    expect(parsed.nodes[4]).toMatchObject({ name: 'HairGeometry', mesh: 1, skin: 1 })
    expect(parsed.nodes[5]).toMatchObject({ name: 'HairMotion', translation: [0, 0, 0] })
    expect((parsed.nodes[3]!.extras as JsonRecord).batshitSecondaryMotion).toEqual(
      secondaryMotion
    )
  })

  it('preserves rigid Hair meshes beside root-weighted moving meshes', async () => {
    const source = sourceFixture()
    const definition = secondaryMotionFixture()
    const segment = definition.chains[0]!.segments[0]!
    segment.node = 'HairMotion'
    segment.pivot = [0, 0, 0]
    segment.tip = [0, 0.2, 0]
    const secondaryMotion = await createEmbeddedSecondaryMotion(definition, { values: {} })
    const output = composeHairIntoAvatarGlb({
      sourceAvatarGlb: source.bytes,
      hairGlb: mixedRigidAndRootWeightedHairFixture(),
      attachment: {
        headNode: 'Head',
        authoredRootMatrix: IDENTITY_WITH_ATTACHMENT_OFFSET
      },
      sourceSecondaryMotion: definition,
      secondaryMotion
    })
    const parsed = parseSemanticGlb(output)
    expect(parsed.nodes.find((node) => node.name === 'HairGeometry')).toMatchObject({
      name: 'HairGeometry',
      skin: 1
    })
    expect(parsed.nodes.find((node) => node.name === 'RigidHairGeometry')).toEqual({
      name: 'RigidHairGeometry',
      mesh: 2
    })
  })

  it('validates authored Hair joints against source pivots while embedding resolved pivots', async () => {
    const definition = secondaryMotionFixture()
    const segment = definition.chains[0]!.segments[0]!
    segment.node = 'HairMotion'
    segment.pivot = [0, 0, 0]
    segment.tip = [0, 0.2, 0]
    segment.drivers = [
      {
        kind: 'dial-endpoint',
        dialId: 'head_size',
        endpoint: 1,
        pivotDelta: [0.05, 0, 0],
        tipDelta: [0.05, 0, 0]
      }
    ]
    const secondaryMotion = await createEmbeddedSecondaryMotion(definition, {
      values: { head_size: 1 }
    })
    const output = composeHairIntoAvatarGlb({
      sourceAvatarGlb: sourceFixture().bytes,
      hairGlb: rootWeightedHairFixture(),
      attachment: {
        headNode: 'Head',
        authoredRootMatrix: IDENTITY_WITH_ATTACHMENT_OFFSET
      },
      sourceSecondaryMotion: definition,
      secondaryMotion
    })
    const parsed = parseSemanticGlb(output)
    expect(parsed.nodes[5]).toMatchObject({ name: 'HairMotion', translation: [0, 0, 0] })
    expect(
      ((parsed.nodes[3]!.extras as JsonRecord).batshitSecondaryMotion as {
        chains: Array<{ segments: Array<{ pivot: number[] }> }>
      }).chains[0]!.segments[0]!.pivot
    ).toEqual([0.05, 0, 0])
  })

  it('rejects saved motion settings on a rigid Hair representation', async () => {
    const definition = secondaryMotionFixture()
    const secondaryMotion = await createEmbeddedSecondaryMotion(
      definition,
      { values: {} },
      { enabled: true, intensity: 1.1 }
    )

    expect(() =>
      composeHairIntoAvatarGlb({
        sourceAvatarGlb: sourceFixture().bytes,
        hairGlb: hairFixture().bytes,
        attachment: {
          headNode: 'Head',
          authoredRootMatrix: IDENTITY_WITH_ATTACHMENT_OFFSET
        },
        secondaryMotion
      })
    ).toThrow('saved Hair motion settings require root-weighted Hair skinning')
  })

  it.each([
    {
      name: 'skins',
      mutate(gltf: JsonRecord) {
        gltf.skins = [{ joints: [0] }]
      },
      error: 'Hair skinning requires embedded root-weighted secondary motion'
    },
    {
      name: 'animations',
      mutate(gltf: JsonRecord) {
        gltf.animations = [{}]
      },
      error: 'Hair GLB may not contain animations'
    },
    {
      name: 'morph targets',
      mutate(gltf: JsonRecord) {
        const mesh = (gltf.meshes as JsonRecord[])[0]!
        const primitive = (mesh.primitives as JsonRecord[])[0]!
        primitive.targets = [{ POSITION: 0 }]
      },
      error: 'may not use morph targets'
    },
    {
      name: 'cameras',
      mutate(gltf: JsonRecord) {
        gltf.cameras = [{ type: 'perspective' }]
      },
      error: 'Hair GLB may not contain cameras'
    },
    {
      name: 'lights and other extensions',
      mutate(gltf: JsonRecord) {
        gltf.extensionsUsed = ['KHR_lights_punctual']
        gltf.extensions = { KHR_lights_punctual: { lights: [] } }
      },
      error: 'Hair GLB may not declare extensionsUsed'
    }
  ])('rejects Hair $name', ({ mutate, error }) => {
    const source = sourceFixture()
    const hair = hairFixture()
    const gltf = cloneRecord(hair.gltf)
    mutate(gltf)
    expect(() => compose(source.bytes, makeGlb(gltf, hair.binary))).toThrow(error)
  })

  it('rejects external buffers and image URIs', () => {
    const source = sourceFixture()
    const hair = hairFixture()
    const externalBuffer = cloneRecord(hair.gltf)
    ;(externalBuffer.buffers as JsonRecord[])[0]!.uri = 'hair.bin'
    expect(() => compose(source.bytes, makeGlb(externalBuffer, hair.binary))).toThrow(
      'Hair GLB may not declare an external buffer URI'
    )

    const remoteImage = cloneRecord(hair.gltf)
    ;(remoteImage.images as JsonRecord[])[0]!.uri = 'https://example.invalid/hair.png'
    expect(() => compose(source.bytes, makeGlb(remoteImage, hair.binary))).toThrow(
      'Hair gltf.images[0] may not use a URI'
    )
  })

  it('rejects ambiguous scenes and hierarchy ownership', () => {
    const source = sourceFixture()
    const hair = hairFixture()
    const multipleScenes = cloneRecord(hair.gltf)
    multipleScenes.scenes = [{ nodes: [0] }, { nodes: [0] }]
    expect(() => compose(source.bytes, makeGlb(multipleScenes, hair.binary))).toThrow(
      'Hair GLB must contain exactly one unambiguous scene'
    )

    const multipleRoots = cloneRecord(hair.gltf)
    ;(multipleRoots.nodes as JsonRecord[])[0]!.children = []
    multipleRoots.scenes = [{ nodes: [0, 1] }]
    expect(() => compose(source.bytes, makeGlb(multipleRoots, hair.binary))).toThrow(
      'Hair GLB scene must have exactly one authored root'
    )

    const orphan = cloneRecord(hair.gltf)
    ;(orphan.nodes as JsonRecord[]).push({ name: 'UnownedHairNode' })
    expect(() => compose(source.bytes, makeGlb(orphan, hair.binary))).toThrow(
      'Hair GLB contains nodes outside its sole scene hierarchy'
    )
  })

  it('rejects missing or colliding attachment ownership', () => {
    const source = sourceFixture()
    const hair = hairFixture()
    expect(() => compose(source.bytes, hair.bytes, { headNode: 'MissingHead' })).toThrow(
      'source avatar head node MissingHead is missing'
    )

    const collision = cloneRecord(hair.gltf)
    ;(collision.nodes as JsonRecord[])[0]!.name = 'Head'
    expect(() => compose(source.bytes, makeGlb(collision, hair.binary))).toThrow(
      'Hair node name Head collides with the source avatar'
    )
  })

  it('rejects non-affine or non-invertible authored attachment matrices', () => {
    const source = sourceFixture()
    const hair = hairFixture()
    const projective = [...IDENTITY_WITH_ATTACHMENT_OFFSET]
    projective[3] = 1
    expect(() => compose(source.bytes, hair.bytes, { authoredRootMatrix: projective })).toThrow(
      'attachment.authoredRootMatrix must be an affine matrix'
    )

    const singular = [...IDENTITY_WITH_ATTACHMENT_OFFSET]
    singular[0] = 0
    expect(() => compose(source.bytes, hair.bytes, { authoredRootMatrix: singular })).toThrow(
      'attachment.authoredRootMatrix must be invertible'
    )
  })

  it('uses one stable diagnostic contract', () => {
    const source = sourceFixture()
    const hair = hairFixture()
    expect(() => compose(source.bytes, hair.bytes, { headNode: 'MissingHead' })).toThrow(
      `[${HAIR_AVATAR_GLB_COMPOSER_CONTRACT}]`
    )
  })
})
