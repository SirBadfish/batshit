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
  type FacialArtworkRoleId
} from './facialArtwork'
import {
  setFacialArtworkRoleMode,
  updateFacialArtworkEyeState
} from './facialArtwork.editor'

function loadDefinition(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'static/goons/facial-artwork/v2/facial-artwork-v2.json'),
      'utf8'
    )
  )
}

function upload(role: FacialArtworkRoleId, definition: ReturnType<typeof parseFacialArtworkDefinition>) {
  const roleDefinition = definition.roles.find((entry) => entry.id === role)!
  const template = definition.templates.find((entry) => entry.id === roleDefinition.template)!
  return {
    role,
    url: `/uploads/goon_facial_artwork/${role}.png`,
    filename: `${role}.png`,
    size: 1234,
    mimeType: 'image/png' as const,
    sha256: 'a'.repeat(64),
    template: { id: template.id, version: template.version, guideSha256: template.guide.sha256 },
    provenance: {
      sourceKind: 'user-authored' as const,
      author: 'Fixture Artist',
      license: 'LicenseRef-User-Owned',
      rightsConfirmed: true as const
    }
  }
}

describe('facial-artwork/v2', () => {
  it('parses the actual rich canonical definition and exact executable bindings', () => {
    const definition = parseFacialArtworkDefinition(loadDefinition())
    expect(definition.definitionSha256).toBe(
      'f4c8dedfacb29d2bbc1b2d2ed8c7b0c5385f694ffe588a865d880c54b84d589b'
    )
    expect(definition.roles.map((entry) => entry.id)).toEqual(FACIAL_ARTWORK_ROLE_IDS)
    expect(definition.roles.find((entry) => entry.id === 'brows')?.target.right).toEqual({
      runtimeNodes: ['bs_f1_brow_canvas_r'],
      mirrorU: true,
      mirrorV: false
    })
    expect(definition.roles.find((entry) => entry.id === 'eye_highlight')?.target.left.runtimeNodes).toEqual([
      'bs_f1_eye_l_iris',
      'bs_f1_eye_l_pupil'
    ])
    expect(definition.roles.find((entry) => entry.id === 'sclera')?.mapping).toBe('longitude')
  })

  it('rejects definition drift, private paths, and stale v1 state', () => {
    const extra = loadDefinition()
    extra.unreviewedField = true
    expect(() => parseFacialArtworkDefinition(extra)).toThrow(/unsupported fields/)

    const privatePath = loadDefinition()
    ;(privatePath.templates as Array<Record<string, any>>)[0].guide.path = '_private/guide.png'
    expect(() => parseFacialArtworkDefinition(privatePath)).toThrow(/canonical public v2 asset root/)

    const definition = parseFacialArtworkDefinition(loadDefinition())
    expect(() => parseFacialArtworkState(definition, { schemaVersion: 'facial-artwork-state/v1' })).toThrow(
      /must equal facial-artwork-state\/v2/
    )
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

  it('resolves only canonical public v2 asset paths', () => {
    expect(
      resolveFacialArtworkAssetUrl('goons/facial-artwork/v2/batshit-base-f-v2/guides/brow-canvas.png')
    ).toBe('/goons/facial-artwork/v2/batshit-base-f-v2/guides/brow-canvas.png')
    expect(() => resolveFacialArtworkAssetUrl('goons/facial-artwork/v1/old.png')).toThrow(/canonical public/)
  })
})
