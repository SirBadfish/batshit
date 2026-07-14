import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  APPEARANCE_CLIP_REMAP_CONTRACT,
  APPEARANCE_DIALS_CONTRACT,
  APPEARANCE_DIAL_VALUES_CONTRACT,
  APPEARANCE_FIT_EVIDENCE_CONTRACT,
  APPEARANCE_FOLLOWER_CONTRACT,
  APPEARANCE_JOINT_FOLLOW_CONTRACT,
  APPEARANCE_PRODUCT_RESOLUTION_CONTRACT,
  type AppearanceDialValueState,
  type AppearanceDialsManifest
} from './appearanceDials'
import { AppearanceDialsEngineRuntime } from './appearanceDials.engine'
import type { GoonCustomAvatarManifest } from './customAvatar'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const HASH_D = 'd'.repeat(64)
const HASH_E = 'e'.repeat(64)
const HASH_F = 'f'.repeat(64)

function provenance(componentId: string) {
  return {
    catalogId: `mh.core.fixture.${componentId}`,
    componentId,
    license: 'CC0-1.0',
    reviewStatus: 'approved',
    contentSha256: HASH_A,
    containerSha256: HASH_B
  }
}

function samples(kind: 'scale' | 'translation') {
  return [-1, 0, 1].map((input) => ({
    input,
    translation: kind === 'translation' ? [input * 0.1, 0, 0] : [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: kind === 'scale'
      ? [1 + input * 0.5, 1 + input * 0.5, 1 + input * 0.5]
      : [1, 1, 1],
    pivot: [0, 0, 0]
  }))
}

function buildManifest(): GoonCustomAvatarManifest {
  return {
    contractVersion: 2,
    face: {
      mesh: 'Face',
      expressions: { blink: 'blink' },
      controls: {
        eyelids_left: { positive: 'eyeWideLeft', negative: 'eyeBlinkLeft' }
      },
      customMorphs: { scar: 'scar' }
    },
    appearanceDials: {
      contract: APPEARANCE_DIALS_CONTRACT,
      definitionSha256: HASH_C,
      neutral: { id: 'batshit-base-f-v1-neutral', recipeSha256: HASH_D },
      productResolution: {
        contract: APPEARANCE_PRODUCT_RESOLUTION_CONTRACT,
        catalogSha256: HASH_A,
        policySha256: HASH_B,
        resolutionSha256: HASH_E
      },
      fitEvidence: {
        contract: APPEARANCE_FIT_EVIDENCE_CONTRACT,
        definitionSha256: HASH_C,
        modelSha256: HASH_D,
        scenarioSetSha256: HASH_E,
        eyeReportSha256: HASH_A,
        oralReportSha256: HASH_B,
        facialArtworkDefinitionSha256: HASH_F,
        facialArtworkContractFileSha256: HASH_E,
        facialArtworkProofSha256: HASH_D
      },
      nodes: {
        body: {
          node: 'Body', kind: 'mesh', role: 'body', side: 'none', required: true,
          scalePolicy: 'any', exactNodeMatches: 1
        },
        face: {
          node: 'Face', kind: 'mesh', role: 'face', side: 'none', required: true,
          scalePolicy: 'any', exactNodeMatches: 1
        },
        eyes: {
          node: 'Eyes', kind: 'anchor', role: 'generic-follower', side: 'none', required: true,
          scalePolicy: 'uniform-only', parent: { kind: 'bone', name: 'Head' }, exactNodeMatches: 1
        },
        sclera_left: {
          node: 'ScleraLeft', kind: 'mesh', role: 'eye-sclera', side: 'left', required: true,
          scalePolicy: 'any', parent: { kind: 'bone', name: 'Head' }, exactNodeMatches: 1
        }
      },
      regions: [
        { id: 'body', label: 'Body', surface: 'body', order: 0 },
        { id: 'head', label: 'Head', surface: 'head-face', order: 0 }
      ],
      targets: {
        head_forward: {
          usages: ['identity'], runtimeRetention: 'recipe-only', side: 'bilateral',
          bindings: [{ node: 'face', morph: 'head_forward' }], baselineValue: 0,
          influenceMin: -1, influenceMax: 1, combine: 'exclusive', impact: 'structural',
          requirements: { jointFollow: true, followerRefs: ['head-assets'] },
          provenance: provenance('head_forward')
        },
        seated_corrective: {
          usages: ['identity'], runtimeRetention: 'recipe-only', side: 'none',
          bindings: [{ node: 'face', morph: 'seated_corrective' }], baselineValue: 0,
          influenceMin: -1, influenceMax: 1, combine: 'sum-clamp', impact: 'surface',
          provenance: provenance('seated_corrective')
        }
      },
      dials: [
        {
          id: 'head_projection', label: 'Head Projection', region: 'head', tier: 'core', order: 0,
          description: 'Moves the head.', keywords: ['head'], kind: 'tracks', range: [-1, 1],
          default: 0, step: 0.01,
          members: [{ target: 'head_forward', track: [[-1, -1], [0, 0], [1, 1]] }]
        },
        {
          id: 'butt_size', label: 'Butt Size', region: 'body', tier: 'core', order: 0,
          description: 'Corrective anchor.', keywords: ['butt'], kind: 'tracks', range: [0, 1],
          default: 0, step: 0.01,
          members: [{ target: 'seated_corrective', track: [[0, 0], [1, 1]] }]
        },
        {
          id: 'overall_height', label: 'Overall Height', region: 'body', tier: 'core', order: 1,
          description: 'Uniform scale.', keywords: ['height'], kind: 'root-scale', range: [-1, 1],
          default: 0, step: 0.01, scalePerUnit: 0.15,
          requirements: { followerRefs: ['head-assets'] }
        }
      ],
      jointFollow: {
        contract: APPEARANCE_JOINT_FOLLOW_CONTRACT,
        space: 'avatar-root',
        units: 'meters',
        restSkeletonSha256: HASH_E,
        deltas: {
          head_forward: { Head: [0, 0, 0.2], 'mixamorig:Hips': [0, 0.5, 0] }
        },
        clipRemap: { contract: APPEARANCE_CLIP_REMAP_CONTRACT, hipsBone: 'mixamorig:Hips' }
      },
      followers: {
        'head-assets': {
          contract: APPEARANCE_FOLLOWER_CONTRACT,
          space: 'node-parent-rest',
          composition: 'rest-relative-follower-channel-id-order/v2',
          interpolation: 'linear-trs-slerp-rotation-morph/v2',
          extrapolation: 'clamp',
          provenance: { ...provenance('head-assets'), license: 'LicenseRef-Batshit-First-Party' },
          nodeIds: ['eyes', 'sclera_left'],
          drivers: [{
            driver: { kind: 'target', id: 'head_forward' },
            channels: [
              { id: 'a-eye-scale', kind: 'node-trs', node: 'eyes', samples: samples('scale') },
              {
                id: 'sclera-fit', kind: 'morph-weight', node: 'sclera_left',
                morph: 'follow_head_forward', weightRange: [-1, 1], runtimeRetention: 'recipe-only',
                samples: [[-1, -1], [0, 0], [1, 1]]
              }
            ]
          }, {
            driver: { kind: 'dial', id: 'overall_height' },
            channels: [
              { id: 'b-eye-translate', kind: 'node-trs', node: 'eyes', samples: samples('translation') }
            ]
          }]
        }
      }
    }
  } as GoonCustomAvatarManifest
}

function morphMesh(name: string, morphs: string[], skinned = false) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0
    ], 3)
  )
  geometry.setIndex([0, 1, 2])
  geometry.morphTargetsRelative = true
  geometry.morphAttributes.position = morphs.map((_, index) =>
    new THREE.Float32BufferAttribute([
      index + 1, 0, 0,
      index + 1, 0, 0,
      index + 1, 0, 0
    ], 3)
  )
  const mesh = skinned
    ? new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
    : new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  mesh.name = name
  mesh.morphTargetDictionary = Object.fromEntries(morphs.map((morph, index) => [morph, index]))
  mesh.morphTargetInfluences = morphs.map(() => 0)
  return mesh
}

function buildScene() {
  const root = new THREE.Group()
  root.name = 'AvatarRoot'
  // Real GLBs commonly carry unnamed transport/helper nodes. They are not
  // part of the exact manifest inventory and must not invalidate it.
  root.add(new THREE.Object3D())
  const hips = new THREE.Bone()
  hips.name = 'mixamorigHips'
  hips.position.y = 1
  const head = new THREE.Bone()
  head.name = 'Head'
  head.position.y = 1
  root.add(hips, head)

  const body = morphMesh('Body', [], true) as THREE.SkinnedMesh
  body.bind(new THREE.Skeleton([hips, head]))
  root.add(body)

  const face = morphMesh('Face', [
    'head_forward', 'seated_corrective', 'blink', 'eyeWideLeft', 'eyeBlinkLeft', 'scar'
  ])
  root.add(face)
  const eyes = new THREE.Object3D()
  eyes.name = 'Eyes'
  eyes.position.x = 1
  head.add(eyes)
  const sclera = morphMesh('ScleraLeft', ['follow_head_forward'])
  head.add(sclera)
  root.updateMatrixWorld(true)
  return { root, hips, head, body, face, eyes, sclera }
}

function values(manifest: AppearanceDialsManifest, next: Record<string, number>): AppearanceDialValueState {
  return {
    contract: APPEARANCE_DIAL_VALUES_CONTRACT,
    definitionSha256: manifest.definitionSha256,
    neutralId: manifest.neutral.id,
    neutralRecipeSha256: manifest.neutral.recipeSha256,
    values: next,
    unlockedDialIds: []
  }
}

describe('AppearanceDialsEngineRuntime', () => {
  it('binds the scene inventory, applies every v2 output, and resets to captured rest', () => {
    const scene = buildScene()
    const runtime = new AppearanceDialsEngineRuntime(scene.root, buildManifest(), {
      faceMeshes: [scene.face]
    })
    const active = values(runtime.manifest, { head_projection: 0.5, overall_height: 1 })
    runtime.setValues(active)

    expect(scene.face.morphTargetDictionary).toEqual({
      blink: 0,
      eyeWideLeft: 1,
      eyeBlinkLeft: 2,
      scar: 3
    })
    expect(scene.sclera.morphTargetDictionary).toEqual({})
    expect(scene.face.geometry.getAttribute('position').getX(0)).toBeCloseTo(0.5)
    expect(scene.sclera.geometry.getAttribute('position').getX(0)).toBeCloseTo(0.5)
    expect(scene.head.position.z).toBeCloseTo(0.1)
    expect(scene.hips.position.y).toBeCloseTo(1.25)
    expect(scene.root.scale.toArray()).toEqual([1.15, 1.15, 1.15])
    // Channel-id order is scale first, then translation: 1 * 1.25 + 0.1.
    expect(scene.eyes.position.x).toBeCloseTo(1.35)

    runtime.setValues(values(runtime.manifest, {}))
    expect(scene.face.geometry.getAttribute('position').getX(0)).toBe(0)
    expect(scene.sclera.geometry.getAttribute('position').getX(0)).toBe(0)
    expect(scene.head.position.toArray()).toEqual([0, 1, 0])
    expect(scene.hips.position.toArray()).toEqual([0, 1, 0])
    expect(scene.eyes.position.toArray()).toEqual([1, 0, 0])
    expect(scene.eyes.scale.toArray()).toEqual([1, 1, 1])
    expect(scene.root.scale.toArray()).toEqual([1, 1, 1])
  })

  it('bakes recipe targets out of the renderer inventory while retaining live face morphs', () => {
    const scene = buildScene()
    const runtime = new AppearanceDialsEngineRuntime(scene.root, buildManifest(), {
      faceMeshes: [scene.face]
    })

    expect(scene.face.geometry.morphAttributes.position).toHaveLength(4)
    expect(scene.sclera.geometry.morphAttributes.position).toBeUndefined()
    expect(Object.keys(scene.face.morphTargetDictionary ?? {})).toEqual([
      'blink', 'eyeWideLeft', 'eyeBlinkLeft', 'scar'
    ])

    const facePosition = scene.face.geometry.getAttribute('position') as THREE.BufferAttribute
    const scleraPosition = scene.sclera.geometry.getAttribute('position') as THREE.BufferAttribute
    const faceVersionBeforeEdit = facePosition.version
    const scleraVersionBeforeEdit = scleraPosition.version
    runtime.setValues(values(runtime.manifest, { butt_size: 0.8 }))
    // seated_corrective was source index 1, whose fixture delta is +2 X.
    expect(scene.face.geometry.getAttribute('position').getX(0)).toBeCloseTo(1.6)
    expect(scene.face.morphTargetInfluences).toEqual([0, 0, 0, 0])
    expect(facePosition.version).toBeGreaterThan(faceVersionBeforeEdit)
    expect(scleraPosition.version).toBeGreaterThan(scleraVersionBeforeEdit)

    scene.face.morphTargetInfluences[0] = 0.25
    // blink was source index 2, whose fixture delta is +3 X. The live target
    // remains a renderer morph while the baked identity base stays at +1.6.
    expect(scene.face.geometry.morphAttributes.position?.[0]?.getX(0)).toBe(3)
    expect(scene.face.geometry.getAttribute('position').getX(0)).toBeCloseTo(1.6)
  })

  it('keeps dynamic face mappings outside appearance ownership and remaps posed hips once', () => {
    const scene = buildScene()
    const runtime = new AppearanceDialsEngineRuntime(scene.root, buildManifest(), {
      faceMeshes: [scene.face]
    })
    runtime.setValues(values(runtime.manifest, { head_projection: 1 }))
    expect(runtime.ownedFaceMorphNames).toEqual(
      new Set(['head_forward', 'seated_corrective', 'follow_head_forward'])
    )
    expect(runtime.ownedFaceMorphNames.has('blink')).toBe(false)

    // Mixer output 2.5 against base rest 1, remapped to new rest 1.5 at ratio 1.5.
    scene.hips.position.y = 2.5
    runtime.applyHipsClipRemap()
    expect(scene.hips.position.y).toBeCloseTo(3.75)
    runtime.applyHipsClipRemap()
    expect(scene.hips.position.y).toBeCloseTo(3.75)
  })

  it('fails the real scene binding when an identity target collides with a face expression', () => {
    const manifest = buildManifest() as Record<string, any>
    manifest.appearanceDials.targets.head_forward.bindings[0].morph = 'blink'
    const scene = buildScene()
    expect(
      () => new AppearanceDialsEngineRuntime(scene.root, manifest as GoonCustomAvatarManifest, {
        faceMeshes: [scene.face]
      })
    ).toThrow(/collides with face animation\/custom morph/)
  })
})
