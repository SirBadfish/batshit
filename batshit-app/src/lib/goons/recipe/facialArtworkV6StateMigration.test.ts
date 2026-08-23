import { describe, expect, it } from 'vitest'

import {
  FACIAL_ARTWORK_V6_ROLE_IDS,
  LEGACY_FACIAL_ARTWORK_DEFINITION_V5,
  LEGACY_FACIAL_ARTWORK_STATE_V5,
  TARGET_FACIAL_ARTWORK_DEFINITION_V6,
  TARGET_FACIAL_ARTWORK_STATE_V6,
  migrateFacialArtworkStateV5ToV6,
  type FacialArtworkV6MigrationDefinitionBinding,
  type FacialArtworkV6RoleId,
  type FacialArtworkV6RoleTemplateBinding,
  type FacialArtworkV6StateMigrationInput,
  type FacialArtworkV6UploadTemplateBinding
} from './facialArtworkV6StateMigration'

const SOURCE_HASH = 'a'.repeat(64)
const TARGET_HASH = 'b'.repeat(64)

function template(
  role: FacialArtworkV6RoleId,
  generation: 'source' | 'target',
  orientation?: FacialArtworkV6UploadTemplateBinding['orientation']
) {
  const seed = generation === 'source' ? 'c' : 'd'
  return {
    id: `${role}-${generation}`,
    version: generation === 'source' ? '5.0.0' : '6.0.0',
    orientation:
      orientation ??
      (role === 'brows' || role === 'lashes_eye_outline'
        ? ('anatomical-left' as const)
        : ('orientation-neutral' as const)),
    guideSha256: seed.repeat(64),
    maskSha256: (generation === 'source' ? 'e' : 'f').repeat(64)
  }
}

function templates(generation: 'source' | 'target') {
  return Object.fromEntries(
    FACIAL_ARTWORK_V6_ROLE_IDS.map((role) => {
      const canonical = template(role, generation)
      return [
        role,
        {
          id: canonical.id,
          version: canonical.version,
          variants:
            role === 'brows' || role === 'lashes_eye_outline'
              ? [canonical, template(role, generation, 'anatomical-right')]
              : [canonical]
        }
      ]
    })
  ) as Record<FacialArtworkV6RoleId, FacialArtworkV6RoleTemplateBinding>
}

function definition(generation: 'source' | 'target'): FacialArtworkV6MigrationDefinitionBinding {
  return {
    schemaVersion:
      generation === 'source'
        ? LEGACY_FACIAL_ARTWORK_DEFINITION_V5
        : TARGET_FACIAL_ARTWORK_DEFINITION_V6,
    stateSchemaVersion:
      generation === 'source'
        ? LEGACY_FACIAL_ARTWORK_STATE_V5
        : TARGET_FACIAL_ARTWORK_STATE_V6,
    definitionSha256: generation === 'source' ? SOURCE_HASH : TARGET_HASH,
    templateSet: {
      id: generation === 'source' ? 'facial-artwork-v5' : 'facial-artwork-v6',
      version: generation === 'source' ? '5.0.0' : '6.0.0'
    },
    templates: templates(generation)
  }
}

function upload(
  role: FacialArtworkV6RoleId,
  orientation?: FacialArtworkV6UploadTemplateBinding['orientation']
) {
  return {
    role,
    url: `/uploads/goon_facial_artwork/${role}.png`,
    filename: `${role}.png`,
    size: 4096,
    mimeType: 'image/png',
    sha256: '1'.repeat(64),
    template: template(role, 'source', orientation),
    provenance: {
      sourceKind: 'user-authored',
      author: 'Josh',
      license: 'Batshit first-party',
      rightsConfirmed: true
    }
  }
}

function planarArtwork(
  role: Exclude<FacialArtworkV6RoleId, 'sclera'>,
  transform: { translateU: number; translateV: number; scale: number; rotationDegrees: number },
  orientation?: FacialArtworkV6UploadTemplateBinding['orientation']
) {
  return {
    upload: upload(role, orientation),
    tint: [0.1, 0.2, 0.3, 0.4],
    opacity: 0.72,
    mapping: role === 'brows' || role === 'lashes_eye_outline' ? 'planar' : 'radial',
    transform
  }
}

function eye(
  role: FacialArtworkV6RoleId,
  artwork: unknown,
  visible = true
) {
  return {
    visible,
    baseColor:
      role === 'iris' || role === 'pupil' || role === 'sclera'
        ? [0.25, 0.5, 0.75]
        : null,
    artwork
  }
}

function sourceState() {
  return {
    schemaVersion: LEGACY_FACIAL_ARTWORK_STATE_V5,
    definitionSha256: SOURCE_HASH,
    templateSet: { id: 'facial-artwork-v5', version: '5.0.0' },
    roles: {
      brows: {
        mode: 'shared',
        shared: eye(
          'brows',
          planarArtwork('brows', {
            translateU: 0.11,
            translateV: -0.12,
            scale: 1.2,
            rotationDegrees: 13
          })
        )
      },
      lashes_eye_outline: {
        mode: 'per-eye',
        left: eye(
          'lashes_eye_outline',
          planarArtwork('lashes_eye_outline', {
            translateU: -0.21,
            translateV: 0.22,
            scale: 0.95,
            rotationDegrees: -14
          })
        ),
        right: eye(
          'lashes_eye_outline',
          planarArtwork('lashes_eye_outline', {
            translateU: 0.23,
            translateV: -0.24,
            scale: 1.05,
            rotationDegrees: 15
          }, 'anatomical-right')
        )
      },
      iris: {
        mode: 'shared',
        shared: eye(
          'iris',
          planarArtwork('iris', {
            translateU: 0.31,
            translateV: -0.32,
            scale: 1.15,
            rotationDegrees: 16
          })
        )
      },
      pupil: {
        mode: 'per-eye',
        left: eye(
          'pupil',
          planarArtwork('pupil', {
            translateU: -0.41,
            translateV: 0.42,
            scale: 1.3,
            rotationDegrees: -17
          })
        ),
        right: eye(
          'pupil',
          planarArtwork('pupil', {
            translateU: 0.43,
            translateV: -0.44,
            scale: 0.8,
            rotationDegrees: 18
          })
        )
      },
      eye_highlight: {
        mode: 'shared',
        shared: eye(
          'eye_highlight',
          planarArtwork('eye_highlight', {
            translateU: 0.51,
            translateV: -0.52,
            scale: 1.45,
            rotationDegrees: 19
          })
        )
      },
      sclera: {
        mode: 'shared',
        shared: eye('sclera', {
          upload: upload('sclera'),
          tint: [0.6, 0.7, 0.8, 0.9],
          opacity: 0.83,
          mapping: 'longitude',
          transform: { longitudeDegrees: -27 }
        })
      }
    }
  }
}

function input(state: unknown = sourceState()): FacialArtworkV6StateMigrationInput {
  return { source: definition('source'), target: definition('target'), state }
}

function sharedArtwork(result: ReturnType<typeof migrateFacialArtworkStateV5ToV6>, role: FacialArtworkV6RoleId) {
  const state = result.roles[role]
  expect(state.mode).toBe('shared')
  return state.mode === 'shared' ? state.shared.artwork! : state.left.artwork!
}

describe('Facial Artwork v5 to v6 saved-state migration', () => {
  it('canonicalizes only removed Iris/Pupil artwork transforms while preserving rotation', () => {
    const result = migrateFacialArtworkStateV5ToV6(input())

    expect(sharedArtwork(result, 'iris').transform).toEqual({
      translateU: 0,
      translateV: 0,
      scale: 1,
      rotationDegrees: 16
    })
    const pupil = result.roles.pupil
    expect(pupil.mode).toBe('per-eye')
    if (pupil.mode === 'per-eye') {
      expect(pupil.left.artwork!.transform).toEqual({
        translateU: 0,
        translateV: 0,
        scale: 1,
        rotationDegrees: -17
      })
      expect(pupil.right.artwork!.transform).toEqual({
        translateU: 0,
        translateV: 0,
        scale: 1,
        rotationDegrees: 18
      })
    }
  })

  it('preserves Brow, Lashes, Highlight, and Sclera transforms exactly', () => {
    const source = sourceState()
    const result = migrateFacialArtworkStateV5ToV6(input(source))

    expect(sharedArtwork(result, 'brows').transform).toEqual(
      source.roles.brows.shared.artwork.transform
    )
    const lashes = result.roles.lashes_eye_outline
    expect(lashes.mode).toBe('per-eye')
    if (lashes.mode === 'per-eye') {
      expect(lashes.left.artwork!.transform).toEqual(
        source.roles.lashes_eye_outline.left.artwork.transform
      )
      expect(lashes.right.artwork!.transform).toEqual(
        source.roles.lashes_eye_outline.right.artwork.transform
      )
    }
    expect(sharedArtwork(result, 'eye_highlight').transform).toEqual(
      source.roles.eye_highlight.shared.artwork.transform
    )
    expect(sharedArtwork(result, 'sclera').transform).toEqual({ longitudeDegrees: -27 })
  })

  it('preserves artwork identity, colors, visibility, opacity, tint, and bilateral modes while rebinding templates', () => {
    const source = sourceState()
    const result = migrateFacialArtworkStateV5ToV6(input(source))

    expect(result).toMatchObject({
      schemaVersion: TARGET_FACIAL_ARTWORK_STATE_V6,
      definitionSha256: TARGET_HASH,
      templateSet: { id: 'facial-artwork-v6', version: '6.0.0' }
    })
    expect(result.roles.lashes_eye_outline.mode).toBe('per-eye')
    expect(result.roles.pupil.mode).toBe('per-eye')
    for (const role of FACIAL_ARTWORK_V6_ROLE_IDS) {
      const sourceRole = source.roles[role]
      const targetRole = result.roles[role]
      expect(targetRole.mode).toBe(sourceRole.mode)
      const sourceEyes =
        sourceRole.mode === 'shared' ? [sourceRole.shared] : [sourceRole.left, sourceRole.right]
      const targetEyes =
        targetRole.mode === 'shared' ? [targetRole.shared] : [targetRole.left, targetRole.right]
      for (const [index, targetEye] of targetEyes.entries()) {
        const sourceEye = sourceEyes[index]!
        expect(targetEye.visible).toBe(sourceEye.visible)
        expect(targetEye.baseColor).toEqual(sourceEye.baseColor)
        expect(targetEye.artwork!.tint).toEqual(sourceEye.artwork.tint)
        expect(targetEye.artwork!.opacity).toBe(sourceEye.artwork.opacity)
        expect(targetEye.artwork!.upload).toMatchObject({
          role,
          url: sourceEye.artwork.upload.url,
          filename: sourceEye.artwork.upload.filename,
          size: sourceEye.artwork.upload.size,
          mimeType: sourceEye.artwork.upload.mimeType,
          sha256: sourceEye.artwork.upload.sha256,
          provenance: sourceEye.artwork.upload.provenance,
          template: template(
            role,
            'target',
            sourceEye.artwork.upload.template.orientation
          )
        })
      }
    }
  })

  it('preserves an explicit empty artwork slot without inventing upload state', () => {
    const state = sourceState()
    state.roles.brows.shared.artwork = null as unknown as ReturnType<typeof planarArtwork>
    state.roles.brows.shared.visible = false
    const result = migrateFacialArtworkStateV5ToV6(input(state))

    expect(result.roles.brows).toEqual({
      mode: 'shared',
      shared: { visible: false, baseColor: null, artwork: null }
    })
  })

  it('rejects incompatible schema/hash/template/mapping and unknown state fields', () => {
    const wrongSchema = sourceState()
    wrongSchema.schemaVersion = 'facial-artwork-state/v4' as typeof LEGACY_FACIAL_ARTWORK_STATE_V5
    expect(() => migrateFacialArtworkStateV5ToV6(input(wrongSchema))).toThrowError(
      expect.objectContaining({ code: 'INCOMPATIBLE_SOURCE' })
    )

    const wrongHash = sourceState()
    wrongHash.definitionSha256 = '9'.repeat(64)
    expect(() => migrateFacialArtworkStateV5ToV6(input(wrongHash))).toThrowError(
      expect.objectContaining({ code: 'INCOMPATIBLE_SOURCE' })
    )

    const wrongSet = sourceState()
    wrongSet.templateSet.version = '4.0.0'
    expect(() => migrateFacialArtworkStateV5ToV6(input(wrongSet))).toThrowError(
      expect.objectContaining({ code: 'INCOMPATIBLE_SOURCE' })
    )

    const wrongTemplate = sourceState()
    wrongTemplate.roles.iris.shared.artwork.upload.template.guideSha256 = '8'.repeat(64)
    expect(() => migrateFacialArtworkStateV5ToV6(input(wrongTemplate))).toThrowError(
      expect.objectContaining({ code: 'INCOMPATIBLE_SOURCE' })
    )

    const wrongMapping = sourceState()
    wrongMapping.roles.eye_highlight.shared.artwork.mapping = 'planar'
    expect(() => migrateFacialArtworkStateV5ToV6(input(wrongMapping))).toThrowError(
      expect.objectContaining({ code: 'INCOMPATIBLE_SOURCE' })
    )

    const unknownField = sourceState() as ReturnType<typeof sourceState> & { legacy?: true }
    unknownField.legacy = true
    expect(() => migrateFacialArtworkStateV5ToV6(input(unknownField))).toThrowError(
      expect.objectContaining({ code: 'INCOMPATIBLE_SOURCE' })
    )
  })

  it('rejects malformed target bindings instead of partially rebinding saved uploads', () => {
    const sameHash = input()
    sameHash.target = { ...sameHash.target, definitionSha256: SOURCE_HASH }
    expect(() => migrateFacialArtworkStateV5ToV6(sameHash)).toThrowError(
      expect.objectContaining({ code: 'INVALID_BINDING' })
    )

    const missingTemplate = input()
    const target = structuredClone(missingTemplate.target) as FacialArtworkV6MigrationDefinitionBinding
    delete (target.templates as Partial<typeof target.templates>).iris
    missingTemplate.target = target
    expect(() => migrateFacialArtworkStateV5ToV6(missingTemplate)).toThrowError(
      expect.objectContaining({ code: 'INVALID_BINDING' })
    )
  })
})
