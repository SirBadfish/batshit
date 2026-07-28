import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDefaultEyeAppearanceState,
  parseEyeAppearanceDefinition
} from '$lib/goons/eyeAppearance'
import { APPEARANCE_DIAL_VALUES_CONTRACT } from '$lib/goons/appearanceDials.contracts'
import {
  loadGoonEyeAppearanceDefinition,
  validateGoonEyeAppearanceState
} from '../eyeAppearance.server'

const HASH = {
  eye: 'a'.repeat(64),
  socket: 'b'.repeat(64),
  seam: 'c'.repeat(64),
  artwork: 'd'.repeat(64)
}

function linerPerformanceMorphs(suffix: 'Left' | 'Right'): string[] {
  return [
    `eyeBlink${suffix}`,
    `eyeSquint${suffix}`,
    `eyeWide${suffix}`,
    ...Array.from({ length: 41 }, (_, index) => `performance${suffix}${index}`)
  ].sort()
}

function seamFixture(): any {
  const side = (name: 'left' | 'right', code: 'l' | 'r', offset: number) => ({
    side: name,
    sourceBodyNode: 'Body',
    compositeCapNode: `BS_Eye_${code.toUpperCase()}_CompositeCap`,
    lashesEyeOutlineNode: `bs_f1_eye_treatment_canvas_${code}`,
    upperBoundary: { sampleCount: 48, bindingSha256: `${offset}`.repeat(64) },
    lowerBoundary: { sampleCount: 48, bindingSha256: `${offset + 1}`.repeat(64) },
    innerCanthusVertexIndex: offset * 100 + 1,
    outerCanthusVertexIndex: offset * 100 + 2,
    capUnderlapMeters: 0.002,
    liner: {
      innerOverlapMeters: 0.00045,
      surfaceClearanceMeters: 0.00008,
      baseForwardPitchDegrees: 0,
      faceConformal: true,
      visibleLidRimAllowed: false,
      ordinaryDepthTest: true,
      renderOrder: 'after-composite-cap',
      retainedPerformanceMorphs: linerPerformanceMorphs(name === 'left' ? 'Left' : 'Right'),
      freeLashFlare: {
        profile: 'geometry-derived-attachment-hinge/v1',
        direction: 'model-forward',
        attachmentBandNormalizedWidth: 0.2,
        canthusTaperNormalizedWidth: 0.08,
        upperMaximumForwardOffsetMeters: 0.0016,
        lowerMaximumForwardOffsetMeters: 0.0028
      }
    }
  })
  return {
    schemaVersion: 'eye-aperture-seam/v1',
    definitionSha256: HASH.seam,
    status: 'product-export-approved',
    productExportApproved: true,
    sharedCanthusRoots: true,
    blinkClosure: {
      composition: 'same-side-squint-floor/v1',
      fullBlinkSquintFloor: 0.5
    },
    runtimeBindings: { left: side('left', 'l', 1), right: side('right', 'r', 3) }
  }
}

function socketFixture(): any {
  const side = (name: 'left' | 'right', code: 'L' | 'R', x: number) => {
    const suffix = name === 'left' ? 'Left' : 'Right'
    const followers = [`eyeBlink${suffix}`, `eyeSquint${suffix}`, `eyeWide${suffix}`]
    return {
      side: name,
      nodes: { compositeCap: `BS_Eye_${code}_CompositeCap` },
      apertureSeamDefinitionSha256: HASH.seam,
      gazeAnchorHeadLocal: [x, 0, 0],
      surfaceCenterHeadLocal: [x, 0, 0],
      horizontalAxisHeadLocal: [1, 0, 0],
      verticalAxisHeadLocal: [0, 1, 0],
      forwardAxisHeadLocal: [0, 0, 1],
      cap: {
        frontGeometryLaw: 'aperture-normalized-shallow-patch/v1',
        frontDepthRatio: 0.24,
        maximumFrontDepthMeters: 0.0024,
        artworkProjection: 'deformed-surface-meters/v1',
        carrierHalfWidthMeters: 0.016,
        carrierHalfHeightMeters: 0.012,
        carrierDepthRadiusMeters: 0.014,
        rearClosureDepthMeters: 0.004,
        minimumHiddenUnderlapMeters: 0.002,
        visibleFrontFaceGroup: `${name}-visible-front`,
        hiddenClosureFaceGroup: `${name}-hidden-closure`,
        primitiveFollowerMorphs: { visibleFront: followers, hiddenClosure: [...followers] },
        apertureFollowing: true,
        closedManifold: true
      },
      gaze: { maximumHorizontal: 0.58, maximumVertical: 0.45, headFollowStart: 0.72 }
    }
  }
  return {
    schemaVersion: 'socket-eye-surface/v1',
    definitionSha256: HASH.socket,
    status: 'product-export-approved',
    productExportApproved: true,
    coordinateSpace: 'head-local',
    surfaceKind: 'aperture-following-composite-cap',
    compositeLayers: ['sclera', 'scleraArtwork', 'iris', 'pupil', 'highlight', 'cornea'],
    rendering: {
      meshOwnsApertureMask: true,
      visibleFrontDepthTest: true,
      visibleFrontDepthWrite: true,
      visibleFrontSide: 'front',
      renderOrder: 'after-face-before-liner',
      requiredMaxTextureArrayLayers: 501
    },
    artwork: {
      scleraOverlay: {
        gazeLinked: true,
        transparentRgba: true,
        minimumOverscanHorizontal: 0.8,
        minimumOverscanVertical: 0.75
      }
    },
    runtimeBindings: { left: side('left', 'L', 0.03), right: side('right', 'R', -0.03) }
  }
}

function eyeFixture(): any {
  const side = (code: 'L' | 'R') => ({
    compositeCapNode: `BS_Eye_${code}_CompositeCap`,
    irisNeutralRadiusMeters: 0.006,
    pupilNeutralRadiusRatio: 0.35,
    irisVerticalTravelMeters: 0.003,
    edgeSoftnessMeters: 0.0002,
    artworkMappings: {
      sclera: 'gaze-linked-carrier',
      iris: 'radial-carrier',
      pupil: 'radial-carrier',
      highlight: 'iris-space'
    },
    cornea: { roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.08 }
  })
  const control = (id: 'iris_size' | 'pupil_size' | 'iris_vertical_position') => ({
    id,
    label:
      id === 'iris_size'
        ? 'Iris Size'
        : id === 'pupil_size'
          ? 'Pupil Size'
          : 'Iris Vertical Position',
    description: `${id} on the fixed cap`,
    minimum: id === 'iris_size' ? 0.75 : id === 'pupil_size' ? 0 : -1,
    maximum: id === 'iris_size' ? 1.35 : id === 'pupil_size' ? 2 : 1,
    step: 0.01,
    default: id === 'iris_vertical_position' ? 0 : 1,
    unit:
      id === 'iris_size'
        ? 'neutral-multiplier'
        : id === 'pupil_size'
          ? 'iris-relative-multiplier'
          : 'neutral-travel-fraction',
    linkedBilateral: true,
    perEyeOverridesAllowed: false,
    runtimeClampingAllowed: false,
    geometrySemantics: 'Moves artwork coordinates without rotating the cap.'
  })
  return {
    schemaVersion: 'eye-appearance/v3',
    stateSchemaVersion: 'eye-appearance-state/v3',
    status: 'product-export-approved',
    productExportApproved: true,
    definitionSha256: HASH.eye,
    dependencies: {
      socketEyeSurface: {
        schemaVersion: 'socket-eye-surface/v1',
        definitionSha256: HASH.socket
      },
      eyeApertureSeam: {
        schemaVersion: 'eye-aperture-seam/v1',
        definitionSha256: HASH.seam
      }
    },
    ownership: 'Package-owned calibration.',
    zeroLaw: 'Defaults reproduce authored eyes.',
    symmetryLaw: 'Linked bilateral controls.',
    compositionOrder: ['sclera', 'scleraArtwork', 'iris', 'pupil', 'highlight', 'cornea'],
    solidColorDefaults: {
      iris: [0.035, 0.42, 0.34, 1],
      pupil: [0.008, 0.009, 0.012, 1],
      sclera: [0.92, 0.94, 0.96, 1]
    },
    runtimeBindings: {
      coordinateSpace: 'socket-eye-surface',
      left: side('L'),
      right: side('R'),
      geometryEvidence: {
        acceptedGlbSha256: 'e'.repeat(64),
        socketSurfaceSha256: 'f'.repeat(64),
        apertureSeamSha256: '1'.repeat(64)
      }
    },
    controls: [control('iris_size'), control('pupil_size'), control('iris_vertical_position')],
    rangeEvidence: {
      schemaVersion: 'eye-appearance-range-evidence/v3',
      sha256: '2'.repeat(64),
      canonicalSha256: '3'.repeat(64)
    }
  }
}

function facialArtworkFixture(): any {
  const value = JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'static/goons/facial-artwork/v4/facial-artwork-v4.json'),
      'utf8'
    )
  )
  value.definitionSha256 = HASH.artwork
  value.dependencies = {
    eyeAppearance: { schemaVersion: 'eye-appearance/v3', definitionSha256: HASH.eye },
    socketEyeSurface: {
      schemaVersion: 'socket-eye-surface/v1',
      definitionSha256: HASH.socket
    },
    eyeApertureSeam: {
      schemaVersion: 'eye-aperture-seam/v1',
      definitionSha256: HASH.seam
    }
  }
  for (const role of value.roles) {
    const kind =
      role.id === 'brows'
        ? 'face-conformal-canvas'
        : role.id === 'lashes_eye_outline'
          ? 'eye-aperture-liner'
          : 'socket-eye-composite-layer'
    const layer =
      role.id === 'sclera'
        ? 'scleraArtwork'
        : role.id === 'eye_highlight'
          ? 'highlight'
          : role.id === 'iris' || role.id === 'pupil'
            ? role.id
            : null
    for (const side of ['left', 'right']) {
      role.target[side].bindingKind = kind
      role.target[side].compositeLayer = layer
      if (kind === 'socket-eye-composite-layer') {
        role.target[side].runtimeNodes = [
          side === 'left' ? 'BS_Eye_L_CompositeCap' : 'BS_Eye_R_CompositeCap'
        ]
      }
    }
  }
  return value
}

function packageManifest() {
  return {
    appearanceDials: {},
    facialArtwork: facialArtworkFixture(),
    eyeAppearance: eyeFixture(),
    socketEyeSurface: socketFixture(),
    eyeApertureSeam: seamFixture()
  }
}

const goon = {
  customAvatar: {
    manifest: { url: '/uploads/goon_custom_manifests/avatar.json', filename: 'avatar.json' }
  }
}

const preparedRecipeGoon = {
  ...goon,
  recipe: {
    authoringRevision: {
      state: {
        appearanceDials: { contract: APPEARANCE_DIAL_VALUES_CONTRACT }
      }
    }
  }
} as any

function reader(manifest: unknown, manifestUpload: Record<string, unknown> | null = null) {
  return {
    json: {
      async get(key: string) {
        return key === 'upload:goon_custom_manifests:avatar.json'
          ? (manifestUpload ?? { textContent: JSON.stringify(manifest) })
          : null
      }
    }
  }
}

describe('eyeAppearance.server', () => {
  it('loads the exact v3/v4/socket/seam package tuple and validates three-control state', async () => {
    const manifest = packageManifest()
    const definition = parseEyeAppearanceDefinition(manifest.eyeAppearance)
    const state = createDefaultEyeAppearanceState(definition)
    await expect(loadGoonEyeAppearanceDefinition(reader(manifest), goon)).resolves.toMatchObject({
      schemaVersion: 'eye-appearance/v3',
      definitionSha256: HASH.eye
    })
    await expect(validateGoonEyeAppearanceState(reader(manifest), goon, state)).resolves.toEqual(state)
  })

  it('accepts the lean prepared Live manifest when the Recipe owns authoring Appearance Dials', async () => {
    const liveManifest = packageManifest()
    delete (liveManifest as any).appearanceDials
    await expect(
      loadGoonEyeAppearanceDefinition(reader(liveManifest), preparedRecipeGoon)
    ).resolves.toMatchObject({
      schemaVersion: 'eye-appearance/v3',
      definitionSha256: HASH.eye
    })
    await expect(loadGoonEyeAppearanceDefinition(reader(liveManifest), goon)).rejects.toThrow(
      /requires the package Recipe appearance-dials\/v2 definition/
    )
  })

  it('loads the tuple from the current filesystem-backed manifest upload', async () => {
    const manifest = packageManifest()
    const textContent = JSON.stringify(manifest)
    const uploadRoot = mkdtempSync(join(tmpdir(), 'batshit-eye-appearance-upload-'))
    const manifestDir = join(uploadRoot, 'goon_custom_manifests')
    const previousUploadsDir = process.env.UPLOADS_DIR
    mkdirSync(manifestDir, { recursive: true })
    writeFileSync(join(manifestDir, 'avatar.json'), textContent)
    process.env.UPLOADS_DIR = uploadRoot
    try {
      await expect(
        loadGoonEyeAppearanceDefinition(
          reader({}, {
            uploadType: 'goon_custom_manifests',
            storage: 'filesystem',
            relativePath: 'goon_custom_manifests/avatar.json',
            size: Buffer.byteLength(textContent)
          }),
          goon
        )
      ).resolves.toMatchObject({ schemaVersion: 'eye-appearance/v3' })
    } finally {
      if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR
      else process.env.UPLOADS_DIR = previousUploadsDir
      rmSync(uploadRoot, { recursive: true, force: true })
    }
  })

  it('accepts null and rejects missing or hash-drifted tuple dependencies', async () => {
    await expect(validateGoonEyeAppearanceState(reader({}), goon, null)).resolves.toBeNull()
    const manifest = packageManifest()
    const state = createDefaultEyeAppearanceState(parseEyeAppearanceDefinition(manifest.eyeAppearance))
    const partial = packageManifest()
    delete (partial as any).socketEyeSurface
    await expect(validateGoonEyeAppearanceState(reader(partial), goon, state)).rejects.toThrow(
      /requires socket-eye-surface\/v1/
    )
    const mismatched = packageManifest()
    mismatched.eyeAppearance.dependencies.socketEyeSurface.definitionSha256 = 'f'.repeat(64)
    await expect(validateGoonEyeAppearanceState(reader(mismatched), goon, state)).rejects.toThrow(
      /dependencies do not match/
    )
  })

  it('rejects facial-artwork targets that do not own the exact seam and cap nodes', async () => {
    const manifest = packageManifest()
    const state = createDefaultEyeAppearanceState(parseEyeAppearanceDefinition(manifest.eyeAppearance))
    const lashes = manifest.facialArtwork.roles.find(
      (role: { id: string }) => role.id === 'lashes_eye_outline'
    )
    lashes.target.left.runtimeNodes = ['floating-lash-card']
    await expect(validateGoonEyeAppearanceState(reader(manifest), goon, state)).rejects.toThrow(
      /liner target does not match/
    )
  })
})
