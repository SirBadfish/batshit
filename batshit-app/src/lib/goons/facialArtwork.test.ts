import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FACIAL_ARTWORK_ROLE_IDS,
  collectFacialArtworkUploadUrls,
  createDefaultFacialArtworkState,
  createFacialArtworkArtworkLayer,
  parseFacialArtworkDefinition,
  parseFacialArtworkState,
  reconcileFacialArtworkState,
  resolveFacialArtworkAssetUrl,
  resolveFacialArtworkTemplateVariant,
  type FacialArtworkOrientation,
  type FacialArtworkRoleId
} from './facialArtwork'
import {
  setFacialArtworkRoleMode,
  updateFacialArtworkEyeState
} from './facialArtwork.editor'

function loadDefinition(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'static/goons/facial-artwork/v3/facial-artwork-v3.json'),
      'utf8'
    )
  )
}

function upload(
  role: FacialArtworkRoleId,
  definition: ReturnType<typeof parseFacialArtworkDefinition>,
  orientation?: FacialArtworkOrientation
) {
  const roleDefinition = definition.roles.find((entry) => entry.id === role)!
  const template = definition.templates.find((entry) => entry.id === roleDefinition.template)!
  const resolvedOrientation = orientation ?? template.canonicalOrientation
  const variant = resolveFacialArtworkTemplateVariant(template, resolvedOrientation)
  return {
    role,
    url: `/uploads/goon_facial_artwork/${role}.png`,
    filename: `${role}.png`,
    size: 1234,
    mimeType: 'image/png' as const,
    sha256: 'a'.repeat(64),
    template: {
      id: template.id,
      version: template.version,
      orientation: resolvedOrientation,
      guideSha256: variant.guide.sha256,
      maskSha256: variant.safePaintMask.sha256
    },
    provenance: {
      sourceKind: 'user-authored' as const,
      author: 'Fixture Artist',
      license: 'LicenseRef-User-Owned',
      rightsConfirmed: true as const
    }
  }
}

describe('facial-artwork/v3', () => {
  it('parses the actual rich canonical definition and exact executable bindings', () => {
    const definition = parseFacialArtworkDefinition(loadDefinition())
    expect(definition.definitionSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(definition.roles.map((entry) => entry.id)).toEqual(FACIAL_ARTWORK_ROLE_IDS)
    expect(definition.roles.find((entry) => entry.id === 'brows')?.target.right).toEqual({
      runtimeNodes: ['bs_f1_brow_canvas_r'],
      mirrorU: false,
      mirrorV: false
    })
    expect(definition.roles.find((entry) => entry.id === 'eye_highlight')?.target.left.runtimeNodes).toEqual([
      'bs_f1_eye_l_iris',
      'bs_f1_eye_l_pupil'
    ])
    expect(definition.roles.find((entry) => entry.id === 'sclera')?.mapping).toBe('longitude')
    expect(
      Object.fromEntries(
        definition.roles.map((entry) => [entry.id, entry.artworkScaleCalibration])
      )
    ).toEqual({
      brows: 0.8,
      lashes_eye_outline: 1,
      iris: 1.15,
      pupil: 1.2,
      eye_highlight: 1,
      sclera: 1
    })
  })

  it('rejects definition drift, private paths, and stale v2 state', () => {
    const extra = loadDefinition()
    extra.unreviewedField = true
    expect(() => parseFacialArtworkDefinition(extra)).toThrow(/unsupported fields/)

    const privatePath = loadDefinition()
    ;(privatePath.templates as Array<Record<string, any>>)[0].guide.path = '_private/guide.png'
    expect(() => parseFacialArtworkDefinition(privatePath)).toThrow(/canonical public v3 asset root/)

    const invalidCalibration = loadDefinition()
    ;(invalidCalibration.roles as Array<Record<string, any>>)[0].artworkScaleCalibration = 0
    expect(() => parseFacialArtworkDefinition(invalidCalibration)).toThrow(/greater than zero/)

    const definition = parseFacialArtworkDefinition(loadDefinition())
    expect(() => parseFacialArtworkState(definition, { schemaVersion: 'facial-artwork-state/v2' })).toThrow(
      /must equal facial-artwork-state\/v3/
    )
  })

  it('rejects malformed orientation variants and transform origins', () => {
    const missingRight = loadDefinition()
    const missingRightTemplates = missingRight.templates as Array<Record<string, any>>
    const lashes = missingRightTemplates.find((template) => template.id === 'lashes-eye-outline-canvas')!
    delete lashes.mirroredHorizontalVariant
    expect(() => parseFacialArtworkDefinition(missingRight)).toThrow(/anatomical-right variant/)

    const invalidOrientation = loadDefinition()
    ;(invalidOrientation.templates as Array<Record<string, any>>)[0].canonicalOrientation = 'viewer-left'
    expect(() => parseFacialArtworkDefinition(invalidOrientation)).toThrow(/canonicalOrientation/)

    const invalidOrigin = loadDefinition()
    ;(invalidOrigin.templates as Array<Record<string, any>>)[0].transformOriginUv = [1.1, 0.5]
    expect(() => parseFacialArtworkDefinition(invalidOrigin)).toThrow(/normalized UV space/)

    const neutralWithRight = loadDefinition()
    const neutralTemplate = (neutralWithRight.templates as Array<Record<string, any>>).find(
      (template) => template.canonicalOrientation === 'orientation-neutral'
    )!
    neutralTemplate.mirroredHorizontalVariant = {
      orientation: 'anatomical-right',
      label: 'Invalid right variant',
      guide: neutralTemplate.guide,
      safePaintMask: neutralTemplate.safePaintMask
    }
    expect(() => parseFacialArtworkDefinition(neutralWithRight)).toThrow(/orientation-neutral template/)
  })

  it('creates six complete bilateral defaults with independent iris and pupil colors', () => {
    const definition = parseFacialArtworkDefinition(loadDefinition())
    const state = createDefaultFacialArtworkState(definition)
    expect(Object.keys(state.roles)).toEqual(FACIAL_ARTWORK_ROLE_IDS)
    expect(state.roles.brows).toEqual({
      mode: 'shared',
      shared: { visible: false, baseColor: null, artwork: null }
    })
    expect(state.roles.iris).toMatchObject({ mode: 'shared', shared: { visible: true, baseColor: [0.035, 0.42, 0.34] } })
    expect(state.roles.pupil).toMatchObject({ mode: 'shared', shared: { visible: true, baseColor: [0.008, 0.009, 0.012] } })
  })

  it('validates logical-role upload ownership and collects shared uploads once', () => {
    const definition = parseFacialArtworkDefinition(loadDefinition())
    let state = createDefaultFacialArtworkState(definition)
    const artwork = createFacialArtworkArtworkLayer(definition, 'brows', upload('brows', definition))
    state = updateFacialArtworkEyeState(state, { roleId: 'brows', side: 'left' }, (eye) => ({
      ...eye,
      visible: true,
      artwork
    }))
    const parsed = parseFacialArtworkState(definition, state)
    expect([...collectFacialArtworkUploadUrls(parsed)]).toEqual(['/uploads/goon_facial_artwork/brows.png'])
  })

  it('binds upload proof to orientation-specific Guide and Mask hashes', () => {
    const definition = parseFacialArtworkDefinition(loadDefinition())
    const right = upload('lashes_eye_outline', definition, 'anatomical-right')
    expect(() => createFacialArtworkArtworkLayer(definition, 'lashes_eye_outline', right)).not.toThrow()

    const wrongOrientation = structuredClone(right)
    wrongOrientation.template.orientation = 'anatomical-left'
    expect(() =>
      createFacialArtworkArtworkLayer(definition, 'lashes_eye_outline', wrongOrientation)
    ).toThrow(/orientation, guide, and mask identity/)

    const wrongMask = structuredClone(right)
    wrongMask.template.maskSha256 = 'f'.repeat(64)
    expect(() => createFacialArtworkArtworkLayer(definition, 'lashes_eye_outline', wrongMask)).toThrow(
      /orientation, guide, and mask identity/
    )
  })

  it('keeps shared/per-eye transitions explicit when sides differ', () => {
    const definition = parseFacialArtworkDefinition(loadDefinition())
    let state = setFacialArtworkRoleMode(createDefaultFacialArtworkState(definition), 'iris', 'per-eye')
    state = updateFacialArtworkEyeState(state, { roleId: 'iris', side: 'right' }, (eye) => ({
      ...eye,
      baseColor: [1, 0, 0]
    }))
    expect(() => setFacialArtworkRoleMode(state, 'iris', 'shared')).toThrow(/Choose the left or right eye/)
    expect(setFacialArtworkRoleMode(state, 'iris', 'shared', 'right').roles.iris).toMatchObject({
      mode: 'shared',
      shared: { baseColor: [1, 0, 0] }
    })
  })

  it('rejects values outside bounds rather than clamping and reports incompatible package state', () => {
    const definition = parseFacialArtworkDefinition(loadDefinition())
    let state = createDefaultFacialArtworkState(definition)
    const artwork = createFacialArtworkArtworkLayer(definition, 'sclera', upload('sclera', definition))
    artwork.transform.longitudeDegrees = 181
    state = updateFacialArtworkEyeState(state, { roleId: 'sclera', side: 'left' }, (eye) => ({
      ...eye,
      artwork
    }))
    expect(() => parseFacialArtworkState(definition, state)).toThrow(/inside \[-180, 180\]/)
    state.definitionSha256 = 'b'.repeat(64)
    expect(reconcileFacialArtworkState(definition, state)).toMatchObject({ state: null, incompatible: true })
  })

  it('resolves only canonical public v3 asset paths', () => {
    expect(
      resolveFacialArtworkAssetUrl('goons/facial-artwork/v3/batshit-base-f-v3/guides/brow-canvas.png')
    ).toBe('/goons/facial-artwork/v3/batshit-base-f-v3/guides/brow-canvas.png')
    expect(() => resolveFacialArtworkAssetUrl('goons/facial-artwork/v2/old.png')).toThrow(/canonical public/)
  })
})
