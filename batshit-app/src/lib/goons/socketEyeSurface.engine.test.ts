import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import {
  SOCKET_EYE_COMPOSITE_RENDER_ORDER,
  SOCKET_EYE_TREATMENT_RENDER_ORDER,
  SocketEyeCompositeMaterialRuntime,
  SocketEyeSurfaceEngineRuntime,
  resolveSocketEyeSurfaceMetricFrame,
  type SocketEyeCompositeVisualState,
  type SocketEyeSurfaceMetricFrame
} from './socketEyeSurface.engine'
import { parseSocketEyeSurfaceDefinition } from './socketEyeSurface'
import {
  parseEyeApertureSeamDefinition,
  SOCKET_EYE_TREATMENT_FOLLOWER_MORPH_COUNT
} from './eyeApertureSeam'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const HASH_D = 'd'.repeat(64)

function retainedPerformanceMorphs(side: 'left' | 'right') {
  const suffix = side === 'left' ? 'Left' : 'Right'
  return [
    `eyeBlink${suffix}`,
    `eyeLookDown${suffix}`,
    `eyeLookIn${suffix}`,
    `eyeLookOut${suffix}`,
    `eyeLookUp${suffix}`,
    `eyeSquint${suffix}`,
    `eyeWide${suffix}`
  ].sort()
}

function followerMorphs(side: 'left' | 'right') {
  const suffix = side === 'left' ? 'Left' : 'Right'
  const retained = retainedPerformanceMorphs(side)
  return [
    ...retained,
    ...Array.from(
      { length: SOCKET_EYE_TREATMENT_FOLLOWER_MORPH_COUNT - retained.length },
      (_, index) => `appearanceFollower_${suffix}_${String(index).padStart(2, '0')}`
    )
  ].sort()
}

function surfaceCorrection(side: 'left' | 'right') {
  const suffix = side === 'left' ? 'Left' : 'Right'
  return {
    contract: 'head-projection-blink-surface-correction/v1',
    projectionMorph: `headProjection${suffix}`,
    blinkLinearMorph: `eyeTreatmentBlinkLinear${suffix}`,
    blinkResidualMorph: `eyeTreatmentBlinkResidual${suffix}`,
    blinkMorph: `eyeBlink${suffix}`,
    projectionWeightLaw: 'appearance-follower-weight',
    blinkLinearWeightLaw: 'blink-times-projection',
    blinkResidualWeightLaw: 'four-blink-one-minus-blink-times-projection'
  }
}

function treatmentInventory(side: 'left' | 'right', kind: 'recipe-source' | 'compact-runtime') {
  const correction = surfaceCorrection(side)
  return (
    kind === 'recipe-source'
      ? [
          ...followerMorphs(side),
          correction.projectionMorph,
          correction.blinkLinearMorph,
          correction.blinkResidualMorph
        ]
      : [
          ...retainedPerformanceMorphs(side),
          correction.blinkLinearMorph,
          correction.blinkResidualMorph
        ]
  ).sort()
}

function seamDefinition() {
  const side = (name: 'left' | 'right') => {
    const code = name === 'left' ? 'L' : 'R'
    return {
      side: name,
      sourceBodyNode: 'Body',
      physicalEyeNode: `BS_PhysicalEye_${code}`,
      lashesEyeOutlineNode: `BS_EyeTreatmentCanvas_${code}`,
      upperBoundary: {
        sampleCount: 48,
        bindingSha256: name === 'left' ? HASH_C : HASH_D
      },
      lowerBoundary: {
        sampleCount: 48,
        bindingSha256: name === 'left' ? HASH_D : HASH_C
      },
      innerCanthusVertexIndex: name === 'left' ? 1 : 3,
      outerCanthusVertexIndex: name === 'left' ? 2 : 4,
      treatment: {
        geometryLaw: 'animated-upper-lower-thin-surface/v1',
        upperMaterialName: `BS_EyeTreatment_Upper_${code}`,
        lowerMaterialName: `BS_EyeTreatment_Lower_${code}`,
        appearanceFollowerContract: 'appearance-followers/v2',
        followerInventorySha256: HASH_D,
        followerMorphs: followerMorphs(name),
        retainedPerformanceMorphs: retainedPerformanceMorphs(name),
        surfaceCorrection: surfaceCorrection(name),
        doubleSided: true,
        ordinaryDepthTest: true,
        depthWrite: false,
        renderOrder: 'after-physical-eye'
      }
    }
  }
  return parseEyeApertureSeamDefinition({
    schemaVersion: 'eye-aperture-seam/v2',
    definitionSha256: HASH_B,
    status: 'product-export-approved',
    productExportApproved: true,
    sharedCanthusRoots: true,
    blinkClosure: {
      composition: 'authored-independent/v2',
      fullBlinkSquintFloor: 0
    },
    runtimeBindings: { left: side('left'), right: side('right') }
  })
}

function socketDefinition() {
  const side = (name: 'left' | 'right') => {
    const code = name === 'left' ? 'L' : 'R'
    return {
      side: name,
      nodes: { physicalEye: `BS_PhysicalEye_${code}` },
      apertureSeamDefinitionSha256: HASH_B,
      gazeAnchorHeadLocal: [name === 'left' ? -0.032 : 0.032, 0, -0.0125],
      surfaceCenterHeadLocal: [name === 'left' ? -0.032 : 0.032, 0, 0],
      horizontalAxisHeadLocal: [1, 0, 0],
      verticalAxisHeadLocal: [0, 1, 0],
      forwardAxisHeadLocal: [0, 0, 1],
      sphere: {
        geometryLaw: 'static-full-sphere/v1',
        radiusMeters: 0.0125,
        artworkProjection: 'front-hemisphere-uv/v1',
        stableNeutralRear: true,
        surfaceMorphTargets: [],
        physicalFit: {
          mode: 'transform-only/v1',
          translation: true,
          rotation: true,
          uniformScale: true,
          nonUniformScale: false
        }
      },
      gaze: {
        maximumHorizontal: 0.55,
        maximumVertical: 0.42,
        headFollowStart: 0.8
      }
    }
  }
  return parseSocketEyeSurfaceDefinition({
    schemaVersion: 'socket-eye-surface/v2',
    definitionSha256: HASH_A,
    status: 'product-export-approved',
    productExportApproved: true,
    coordinateSpace: 'head-local',
    surfaceKind: 'static-full-sphere',
    compositeLayers: ['sclera', 'scleraArtwork', 'iris', 'pupil', 'highlight', 'cornea'],
    rendering: {
      eyelidsOwnApertureOcclusion: true,
      sphereDepthTest: true,
      sphereDepthWrite: true,
      sphereSide: 'front',
      renderOrder: 'after-face-before-treatment',
      requiredMaxTextureArrayLayers: 501
    },
    artwork: {
      scleraOverlay: {
        projection: 'front-hemisphere-only/v1',
        transparentRgba: true,
        rearPresentation: 'stable-neutral-base',
        gazeLinked: false
      }
    },
    runtimeBindings: { left: side('left'), right: side('right') }
  })
}

function visualState(): SocketEyeCompositeVisualState {
  const emptyLayer = () => ({
    texture: null,
    tint: [1, 1, 1, 1] as [number, number, number, number],
    opacity: 1
  })
  return {
    scleraColor: [0.8, 0.8, 0.8, 1],
    irisColor: [0.1, 0.2, 0.3, 1],
    pupilColor: [0, 0, 0, 1],
    irisRadiusMeters: 0.006,
    pupilRadiusRatio: 0.4,
    irisHorizontalOffsetMeters: 0.001,
    irisVerticalOffsetMeters: -0.001,
    edgeSoftnessMeters: 0.0001,
    scleraArtwork: emptyLayer(),
    irisArtwork: emptyLayer(),
    pupilArtwork: emptyLayer(),
    highlight: emptyLayer(),
    cornea: { roughness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.1 }
  }
}

function metricFrame(): SocketEyeSurfaceMetricFrame {
  return {
    sphereCenterLocal: new THREE.Vector3(),
    horizontalAxisLocal: new THREE.Vector3(1, 0, 0),
    verticalAxisLocal: new THREE.Vector3(0, 1, 0),
    forwardAxisLocal: new THREE.Vector3(0, 0, 1)
  }
}

function treatmentPrimitive(
  materialName: string,
  side: 'left' | 'right',
  kind: 'recipe-source' | 'compact-runtime'
) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 3)
  )
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2))
  geometry.setIndex([0, 1, 2])
  geometry.morphTargetsRelative = true
  const inventory = treatmentInventory(side, kind)
  geometry.morphAttributes.position = inventory.map((name) => {
    const attribute = new THREE.Float32BufferAttribute(new Float32Array(9), 3)
    attribute.name = name
    return attribute
  })
  const material = new THREE.MeshBasicMaterial({
    side: THREE.DoubleSide,
    depthWrite: false
  })
  material.name = materialName
  const mesh = new THREE.Mesh(geometry, material)
  mesh.morphTargetDictionary = Object.fromEntries(inventory.map((name, index) => [name, index]))
  mesh.morphTargetInfluences = inventory.map(() => 0)
  return mesh
}

function rootFixture(kind: 'recipe-source' | 'compact-runtime' = 'recipe-source') {
  const root = new THREE.Group()
  root.name = 'Head'
  const bodyMaterial = new THREE.MeshBasicMaterial({ depthWrite: false })
  const body = new THREE.Mesh(new THREE.BufferGeometry(), bodyMaterial)
  body.name = 'Body'
  root.add(body)
  for (const side of ['left', 'right'] as const) {
    const code = side === 'left' ? 'L' : 'R'
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.0125, 16, 8),
      new THREE.MeshBasicMaterial()
    )
    eye.name = `BS_PhysicalEye_${code}`
    root.add(eye)
    const treatment = new THREE.Group()
    treatment.name = `BS_EyeTreatmentCanvas_${code}`
    const upper = treatmentPrimitive(`BS_EyeTreatment_Upper_${code}`, side, kind)
    upper.name = `BS_EyeTreatment_UpperPrimitive_${code}`
    const lower = treatmentPrimitive(`BS_EyeTreatment_Lower_${code}`, side, kind)
    lower.name = `BS_EyeTreatment_LowerPrimitive_${code}`
    treatment.add(lower, upper)
    root.add(treatment)
  }
  return root
}

function setMorphWeight(mesh: THREE.Mesh, morphName: string, weight: number) {
  const index = mesh.morphTargetDictionary?.[morphName]
  if (!Number.isInteger(index) || !mesh.morphTargetInfluences) {
    throw new Error(`test fixture is missing ${morphName}`)
  }
  mesh.morphTargetInfluences[index!] = weight
}

function readMorphWeight(mesh: THREE.Mesh, morphName: string) {
  const index = mesh.morphTargetDictionary?.[morphName]
  if (!Number.isInteger(index) || !mesh.morphTargetInfluences) {
    throw new Error(`test fixture is missing ${morphName}`)
  }
  return mesh.morphTargetInfluences[index!]
}

function setCorrectionInputs(
  meshes: { upper: THREE.Mesh; lower: THREE.Mesh },
  side: 'left' | 'right',
  kind: 'recipe-source' | 'compact-runtime',
  blink: number,
  projection: number
) {
  const correction = surfaceCorrection(side)
  for (const mesh of [meshes.upper, meshes.lower]) {
    setMorphWeight(mesh, correction.blinkMorph, blink)
    if (kind === 'recipe-source') {
      setMorphWeight(mesh, correction.projectionMorph, projection)
    }
  }
}

describe('SocketEyeCompositeMaterialRuntime v2', () => {
  it('builds one renderer-neutral TSL stack over the full static sphere', () => {
    const definition = socketDefinition()
    const runtime = new SocketEyeCompositeMaterialRuntime(
      definition.runtimeBindings.left,
      visualState(),
      metricFrame()
    )

    expect(runtime.material.isMeshPhysicalNodeMaterial).toBe(true)
    expect(runtime.material.isNodeMaterial).toBe(true)
    expect(runtime.material.depthTest).toBe(true)
    expect(runtime.material.depthWrite).toBe(true)
    expect(runtime.material.side).toBe(THREE.FrontSide)
    expect(runtime.material.colorNode).not.toBeNull()
    expect(runtime.material.emissiveNode).not.toBeNull()
    expect(runtime.material.userData).toMatchObject({
      batshitSocketEyeArtworkProjection: 'full-sphere-equirectangular-gaze-linked/v1',
      batshitSocketEyeDeclaredArtworkProjection: 'front-hemisphere-uv/v1',
      batshitSocketEyeHighlightProjection: 'fixed-front-cornea-space-unmirrored/v1',
      batshitSocketEyeHighlightGazeLinked: false,
      batshitSocketEyeHighlightIrisMaskCropped: false,
      batshitSocketEyePhysicalFit: 'transform-only/v1',
      batshitSocketEyeStableNeutralRear: true
    })
    expect(runtime.material.userData.batshitSocketEyeLayers).toEqual([
      'sclera',
      'scleraArtwork',
      'iris',
      'pupil',
      'highlight',
      'cornea'
    ])
    runtime.setGaze(0.2, -0.1)
    expect(runtime.getGaze().toArray()).toEqual([0.2, -0.1])
    expect(() => runtime.setGaze(0.56, 0)).toThrow('safe domain')
    runtime.dispose()
  })

  it('builds the corrected spherical-cap and view-responsive Highlight suite without changing geometry', () => {
    const definition = socketDefinition()
    const runtime = new SocketEyeCompositeMaterialRuntime(
      definition.runtimeBindings.left,
      visualState(),
      metricFrame(),
      'corrected'
    )

    expect(runtime.material.userData).toMatchObject({
      batshitSocketEyeIrisPupilProjection: 'constant-spherical-cap-radial/v1',
      batshitSocketEyeHighlightProjection: 'view-responsive-cornea-reflection-unmirrored/v1',
      batshitSocketEyeHighlightGazeLinked: false,
      batshitSocketEyeHighlightIrisMaskCropped: false
    })
    expect(runtime.getMetricFrame()).toEqual(metricFrame())
    runtime.dispose()
  })

  it('declares the v2 inset Iris/Pupil boundary while retaining the corrected Highlight', () => {
    const definition = socketDefinition()
    const runtime = new SocketEyeCompositeMaterialRuntime(
      definition.runtimeBindings.left,
      visualState(),
      metricFrame(),
      'corrected-inset'
    )

    expect(runtime.material.userData).toMatchObject({
      batshitSocketEyeIrisPupilProjection: 'constant-spherical-cap-radial-inset/v2',
      batshitSocketEyeHighlightProjection: 'view-responsive-cornea-reflection-unmirrored/v1'
    })
    runtime.dispose()
  })

  it('retains exact zero pupil and never disposes caller-owned artwork textures', () => {
    const definition = socketDefinition()
    const artwork = new THREE.Texture()
    const disposeSpy = vi.spyOn(artwork, 'dispose')
    const initial = visualState()
    initial.pupilRadiusRatio = 0
    initial.scleraArtwork.texture = artwork
    const runtime = new SocketEyeCompositeMaterialRuntime(
      definition.runtimeBindings.left,
      initial,
      metricFrame()
    )
    expect(runtime.getState().pupilRadiusRatio).toBe(0)
    runtime.dispose()
    expect(disposeSpy).not.toHaveBeenCalled()
  })
})

describe('Socket-eye Head-space frame resolution', () => {
  it('resolves declared Head axes through the rotated eye bone instead of treating that bone as Head', () => {
    const head = new THREE.Bone()
    head.name = 'mixamorigHead'
    const eyeBone = new THREE.Bone()
    eyeBone.name = 'mixamorigLeftEye'
    eyeBone.rotation.x = Math.PI / 2
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.0125, 16, 8),
      new THREE.MeshBasicMaterial()
    )
    eye.name = 'BS_PhysicalEye_L'
    head.add(eyeBone)
    eyeBone.add(eye)
    head.updateWorldMatrix(true, true)

    const frame = resolveSocketEyeSurfaceMetricFrame(eye, socketDefinition().runtimeBindings.left)
    const toWorld = (axis: THREE.Vector3) =>
      axis
        .clone()
        .transformDirection(eye.matrixWorld)
        .toArray()
        .map((value) => (Math.abs(value) < 1e-12 ? 0 : value))

    expect(toWorld(frame.horizontalAxisLocal)).toEqual([1, 0, 0])
    expect(toWorld(frame.verticalAxisLocal)).toEqual([0, 1, 0])
    expect(toWorld(frame.forwardAxisLocal)).toEqual([0, 0, 1])
  })
})

describe('SocketEyeSurfaceEngineRuntime v2', () => {
  it('binds one zero-morph physical eye plus exact upper/lower animated treatment', () => {
    const root = rootFixture()
    const eye = root.getObjectByName('BS_PhysicalEye_L') as THREE.Mesh
    const originalEyeMaterial = eye.material
    const treatmentRoot = root.getObjectByName('BS_EyeTreatmentCanvas_L') as THREE.Group
    const originalTreatmentOrders = treatmentRoot.children.map((child) => child.renderOrder)
    const bodyMaterial = (root.getObjectByName('Body') as THREE.Mesh).material as THREE.Material
    const runtime = new SocketEyeSurfaceEngineRuntime(root, socketDefinition(), seamDefinition(), {
      left: visualState(),
      right: visualState()
    })

    expect(eye.material).toBe(runtime.getMaterial('left'))
    expect(eye.renderOrder).toBe(SOCKET_EYE_COMPOSITE_RENDER_ORDER)
    const treatment = runtime.getTreatmentArtworkMeshes('left')
    expect((treatment.upper.material as THREE.Material).name).toBe('BS_EyeTreatment_Upper_L')
    expect((treatment.lower.material as THREE.Material).name).toBe('BS_EyeTreatment_Lower_L')
    expect(treatment.upper.renderOrder).toBe(SOCKET_EYE_TREATMENT_RENDER_ORDER)
    expect(treatment.lower.renderOrder).toBe(SOCKET_EYE_TREATMENT_RENDER_ORDER)
    expect(bodyMaterial.depthWrite).toBe(true)

    runtime.dispose()
    expect(eye.material).toBe(originalEyeMaterial)
    expect(eye.renderOrder).toBe(0)
    expect(treatmentRoot.children.map((child) => child.renderOrder)).toEqual(
      originalTreatmentOrders
    )
    expect(bodyMaterial.depthWrite).toBe(false)
  })

  it('derives Recipe Source nonlinear correctives over the full Blink/projection grid', () => {
    const root = rootFixture('recipe-source')
    const runtime = new SocketEyeSurfaceEngineRuntime(root, socketDefinition(), seamDefinition(), {
      left: visualState(),
      right: visualState()
    })
    const meshes = runtime.getTreatmentArtworkMeshes('left')
    const correction = surfaceCorrection('left')

    for (const blink of [0, 0.25, 0.5, 0.75, 1]) {
      for (const projection of [0, 0.5, 1]) {
        setCorrectionInputs(meshes, 'left', 'recipe-source', blink, projection)
        runtime.setTreatmentSurfaceCorrection('left', blink, projection)
        for (const mesh of [meshes.upper, meshes.lower]) {
          expect(readMorphWeight(mesh, correction.blinkLinearMorph)).toBeCloseTo(blink * projection)
          expect(readMorphWeight(mesh, correction.blinkResidualMorph)).toBeCloseTo(
            4 * blink * (1 - blink) * projection
          )
        }
      }
    }

    runtime.dispose()
    for (const mesh of [meshes.upper, meshes.lower]) {
      expect(readMorphWeight(mesh, correction.blinkLinearMorph)).toBe(0)
      expect(readMorphWeight(mesh, correction.blinkResidualMorph)).toBe(0)
    }
  })

  it('uses the supplied projection factor for compact mounted runtime', () => {
    const root = rootFixture('compact-runtime')
    const runtime = new SocketEyeSurfaceEngineRuntime(root, socketDefinition(), seamDefinition(), {
      left: visualState(),
      right: visualState()
    })
    const meshes = runtime.getTreatmentArtworkMeshes('right')
    const correction = surfaceCorrection('right')

    for (const blink of [0, 0.25, 0.5, 0.75, 1]) {
      for (const projection of [0, 0.5, 1]) {
        setCorrectionInputs(meshes, 'right', 'compact-runtime', blink, projection)
        runtime.setTreatmentSurfaceCorrection('right', blink, projection)
        for (const mesh of [meshes.upper, meshes.lower]) {
          expect(readMorphWeight(mesh, correction.blinkLinearMorph)).toBeCloseTo(blink * projection)
          expect(readMorphWeight(mesh, correction.blinkResidualMorph)).toBeCloseTo(
            4 * blink * (1 - blink) * projection
          )
        }
      }
    }
    runtime.dispose()
  })

  it('fails closed when bound Blink or paired Source projection weights drift', () => {
    const root = rootFixture('recipe-source')
    const runtime = new SocketEyeSurfaceEngineRuntime(root, socketDefinition(), seamDefinition(), {
      left: visualState(),
      right: visualState()
    })
    const meshes = runtime.getTreatmentArtworkMeshes('left')
    const correction = surfaceCorrection('left')
    setCorrectionInputs(meshes, 'left', 'recipe-source', 0.25, 0.5)
    setMorphWeight(meshes.lower, correction.blinkMorph, 0.5)
    expect(() => runtime.setTreatmentSurfaceCorrection('left', 0.25, 0.5)).toThrow(
      'Blink influence does not match'
    )

    setCorrectionInputs(meshes, 'left', 'recipe-source', 0.25, 0.5)
    setMorphWeight(meshes.upper, correction.projectionMorph, 1)
    expect(() => runtime.setTreatmentSurfaceCorrection('left', 0.25, 0.5)).toThrow(
      'projection influences do not match the supplied factor'
    )
    expect(() => runtime.setTreatmentSurfaceCorrection('left', 0.25, -0.01)).toThrow(
      'inside [0, 1]'
    )
    expect(() => runtime.setTreatmentSurfaceCorrection('left', 0.25, 1.01)).toThrow('inside [0, 1]')
    runtime.dispose()
  })

  it('recomputes the material frame after transform-only physical fitting', () => {
    const root = rootFixture()
    const runtime = new SocketEyeSurfaceEngineRuntime(root, socketDefinition(), seamDefinition(), {
      left: visualState(),
      right: visualState()
    })
    const eye = root.getObjectByName('BS_PhysicalEye_L') as THREE.Mesh
    expect(eye.geometry.morphAttributes.position ?? []).toHaveLength(0)
    eye.rotation.z = Math.PI / 2
    eye.scale.setScalar(1.1)
    runtime.syncIdentitySurfaceFrames()
    const axis = runtime.getMetricFrame('left').horizontalAxisLocal
    expect(axis.x).toBeCloseTo(0)
    expect(axis.y).toBeCloseTo(-1)
    expect(eye.scale.toArray()).toEqual([1.1, 1.1, 1.1])
    runtime.dispose()
  })

  it('fails closed on physical-eye morphs or treatment inventory drift', () => {
    const morphedRoot = rootFixture()
    const morphedEye = morphedRoot.getObjectByName('BS_PhysicalEye_L') as THREE.Mesh
    morphedEye.geometry.morphAttributes.position = [
      new THREE.Float32BufferAttribute(
        new Float32Array(morphedEye.geometry.getAttribute('position').count * 3),
        3
      )
    ]
    morphedEye.morphTargetDictionary = { retiredSurfaceMorph: 0 }
    morphedEye.morphTargetInfluences = [0]
    expect(
      () =>
        new SocketEyeSurfaceEngineRuntime(morphedRoot, socketDefinition(), seamDefinition(), {
          left: visualState(),
          right: visualState()
        })
    ).toThrow('zero-morph static physical eye')

    const followerRoot = rootFixture()
    const treatment = followerRoot.getObjectByName('BS_EyeTreatmentCanvas_L') as THREE.Group
    const upper = treatment.getObjectByName('BS_EyeTreatment_UpperPrimitive_L') as THREE.Mesh
    upper.geometry.morphAttributes.position.pop()
    upper.morphTargetInfluences?.pop()
    delete upper.morphTargetDictionary?.headProjectionLeft
    expect(
      () =>
        new SocketEyeSurfaceEngineRuntime(followerRoot, socketDefinition(), seamDefinition(), {
          left: visualState(),
          right: visualState()
        })
    ).toThrow('morph inventory must exactly match')

    const mixedRoot = rootFixture('recipe-source')
    const mixedTreatment = mixedRoot.getObjectByName('BS_EyeTreatmentCanvas_L') as THREE.Group
    const sourceLower = mixedTreatment.getObjectByName(
      'BS_EyeTreatment_LowerPrimitive_L'
    ) as THREE.Mesh
    const compactLower = treatmentPrimitive('BS_EyeTreatment_Lower_L', 'left', 'compact-runtime')
    compactLower.name = sourceLower.name
    mixedTreatment.remove(sourceLower)
    mixedTreatment.add(compactLower)
    expect(
      () =>
        new SocketEyeSurfaceEngineRuntime(mixedRoot, socketDefinition(), seamDefinition(), {
          left: visualState(),
          right: visualState()
        })
    ).toThrow('must share raw Source or compact runtime inventory kind')

    const bilateralRoot = rootFixture('recipe-source')
    const rightTreatment = bilateralRoot.getObjectByName('BS_EyeTreatmentCanvas_R') as THREE.Group
    rightTreatment.clear()
    const compactUpperRight = treatmentPrimitive(
      'BS_EyeTreatment_Upper_R',
      'right',
      'compact-runtime'
    )
    compactUpperRight.name = 'BS_EyeTreatment_UpperPrimitive_R'
    const compactLowerRight = treatmentPrimitive(
      'BS_EyeTreatment_Lower_R',
      'right',
      'compact-runtime'
    )
    compactLowerRight.name = 'BS_EyeTreatment_LowerPrimitive_R'
    rightTreatment.add(compactUpperRight, compactLowerRight)
    expect(
      () =>
        new SocketEyeSurfaceEngineRuntime(bilateralRoot, socketDefinition(), seamDefinition(), {
          left: visualState(),
          right: visualState()
        })
    ).toThrow('bilateral treatment primitives must share')
  })
})
