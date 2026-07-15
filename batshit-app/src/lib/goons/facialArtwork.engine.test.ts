import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import {
  FacialArtworkEngineRuntime,
  buildFacialArtworkPupilHighlightTextureMatrix,
  buildFacialArtworkTextureMatrix,
  configureArtworkTexture,
  resolveFacialArtworkEffectiveScale,
  resolveFacialArtworkHorizontalReflection
} from './facialArtwork.engine'
import {
  createDefaultFacialArtworkState,
  createFacialArtworkArtworkLayer,
  parseFacialArtworkDefinition,
  resolveFacialArtworkTemplateVariant,
  type FacialArtworkDefinitionV3,
  type FacialArtworkOrientation,
  type FacialArtworkRoleId
} from './facialArtwork'

function definition(): FacialArtworkDefinitionV3 {
  return parseFacialArtworkDefinition(
    JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'static/goons/facial-artwork/v3/facial-artwork-v3.json'),
        'utf8'
      )
    )
  )
}

function radialGeometry(radius: number) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([radius, 0, 0, -radius, 0, 0, 0, radius, 0, 0, -radius, 0]),
      3
    )
  )
  return geometry
}

function mesh(
  name: string,
  material: THREE.Material,
  geometry: THREE.BufferGeometry = new THREE.BufferGeometry()
) {
  const value = new THREE.Mesh(geometry, material)
  value.name = name
  return value
}

function scene(sharedEyeMaterial = new THREE.MeshStandardMaterial({ color: 0x456789 })) {
  const root = new THREE.Group()
  root.add(
    mesh('bs_f1_brow_canvas_l', new THREE.MeshBasicMaterial()),
    mesh('bs_f1_brow_canvas_r', new THREE.MeshBasicMaterial()),
    mesh('bs_f1_eye_treatment_canvas_l', new THREE.MeshBasicMaterial()),
    mesh('bs_f1_eye_treatment_canvas_r', new THREE.MeshBasicMaterial()),
    mesh('bs_f1_eye_l_iris', sharedEyeMaterial, radialGeometry(0.005)),
    mesh('bs_f1_eye_r_iris', sharedEyeMaterial, radialGeometry(0.005)),
    mesh('bs_f1_eye_l_pupil', sharedEyeMaterial, radialGeometry(0.002)),
    mesh('bs_f1_eye_r_pupil', sharedEyeMaterial, radialGeometry(0.002)),
    mesh('bs_f1_eye_l_sclera', sharedEyeMaterial),
    mesh('bs_f1_eye_r_sclera', sharedEyeMaterial)
  )
  return root
}

function upload(
  role: FacialArtworkRoleId,
  definitionValue: FacialArtworkDefinitionV3,
  url: string,
  orientation?: FacialArtworkOrientation
) {
  const roleDefinition = definitionValue.roles.find((item) => item.id === role)!
  const template = definitionValue.templates.find((item) => item.id === roleDefinition.template)!
  const resolvedOrientation = orientation ?? template.canonicalOrientation
  const variant = resolveFacialArtworkTemplateVariant(template, resolvedOrientation)
  return {
    role,
    url,
    filename: url.split('/').at(-1)!,
    size: 123,
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

function browState(definitionValue: FacialArtworkDefinitionV3, url: string) {
  const state = createDefaultFacialArtworkState(definitionValue)
  const artwork = createFacialArtworkArtworkLayer(
    definitionValue,
    'brows',
    upload('brows', definitionValue, url)
  )
  if (state.roles.brows.mode !== 'shared') throw new Error('fixture requires shared brows')
  state.roles.brows.shared = { ...state.roles.brows.shared, visible: true, artwork }
  return state
}

function highlightState(definitionValue: FacialArtworkDefinitionV3, url: string) {
  const state = createDefaultFacialArtworkState(definitionValue)
  const artwork = createFacialArtworkArtworkLayer(
    definitionValue,
    'eye_highlight',
    upload('eye_highlight', definitionValue, url)
  )
  if (state.roles.eye_highlight.mode !== 'shared') throw new Error('fixture requires shared highlights')
  state.roles.eye_highlight.shared = {
    ...state.roles.eye_highlight.shared,
    visible: true,
    artwork
  }
  return state
}

function trackedTexture() {
  const value = new THREE.Texture()
  vi.spyOn(value, 'dispose')
  return value
}

describe('FacialArtworkEngineRuntime v3', () => {
  it('maps logical scale one to the calibrated physical neutral for each artwork role', () => {
    const roles = new Map(definition().roles.map((role) => [role.id, role]))
    expect(resolveFacialArtworkEffectiveScale(roles.get('brows')!, 1)).toBeCloseTo(0.8)
    expect(resolveFacialArtworkEffectiveScale(roles.get('iris')!, 1)).toBeCloseTo(1.15)
    expect(resolveFacialArtworkEffectiveScale(roles.get('pupil')!, 1)).toBeCloseTo(1.2)
    expect(resolveFacialArtworkEffectiveScale(roles.get('eye_highlight')!, 1)).toBeCloseTo(1)
    expect(resolveFacialArtworkEffectiveScale(roles.get('iris')!, 0.5)).toBeCloseTo(0.575)
  })

  it('fails closed on missing or duplicate exact runtime nodes', () => {
    const root = scene()
    root.remove(root.getObjectByName('bs_f1_brow_canvas_l')!)
    expect(() => new FacialArtworkEngineRuntime(root, definition())).toThrow(/exactly one mesh/)

    const duplicate = scene()
    duplicate.add(mesh('bs_f1_brow_canvas_l', new THREE.MeshBasicMaterial()))
    expect(() => new FacialArtworkEngineRuntime(duplicate, definition())).toThrow(/found 2/)
  })

  it('applies six-role defaults with independent opaque iris and pupil surfaces', async () => {
    const root = scene()
    const runtime = new FacialArtworkEngineRuntime(root, definition())
    await runtime.apply(null)
    expect(root.getObjectByName('bs_f1_brow_canvas_l')?.visible).toBe(false)
    expect(root.getObjectByName('bs_f1_eye_treatment_canvas_r')?.visible).toBe(false)
    expect(root.getObjectByName('bs_f1_eye_l_iris')?.visible).toBe(true)
    expect(root.getObjectByName('bs_f1_eye_l_pupil')?.visible).toBe(true)
    expect((root.getObjectByName('bs_f1_eye_l_iris') as THREE.Mesh).material).not.toBe(
      (root.getObjectByName('bs_f1_eye_l_pupil') as THREE.Mesh).material
    )
  })

  it('keeps animated canvas ribbons double-sided and builds per-side texture clones for shared artwork', async () => {
    const definitionValue = definition()
    const root = scene()
    const source = trackedTexture()
    const loader = { loadAsync: vi.fn(async () => source) }
    const runtime = new FacialArtworkEngineRuntime(root, definitionValue, loader)
    await runtime.apply(browState(definitionValue, '/uploads/goon_facial_artwork/good.png'))

    const left = root.getObjectByName('bs_f1_brow_canvas_l') as THREE.Mesh
    const right = root.getObjectByName('bs_f1_brow_canvas_r') as THREE.Mesh
    expect(left.visible).toBe(true)
    expect(right.visible).toBe(true)
    expect((left.material as THREE.Material).side).toBe(THREE.DoubleSide)
    expect((right.material as THREE.Material).side).toBe(THREE.DoubleSide)
    expect(loader.loadAsync).toHaveBeenCalledOnce()
  })

  it('lets anatomical brow UVs provide the shared right-side mirror without reflecting its texture twice', () => {
    const definitionValue = definition()
    const role = definitionValue.roles.find((item) => item.id === 'brows')!
    const template = definitionValue.templates.find((item) => item.id === role.template)!
    const artwork = createFacialArtworkArtworkLayer(
      definitionValue,
      role.id,
      upload(role.id, definitionValue, '/brows.png')
    )

    expect(role.target.left.mirrorU).toBe(false)
    expect(role.target.right.mirrorU).toBe(false)
    expect(resolveFacialArtworkHorizontalReflection(role.target.left.mirrorU, artwork)).toBe(false)
    expect(resolveFacialArtworkHorizontalReflection(role.target.right.mirrorU, artwork)).toBe(false)

    const sample = new THREE.Vector2(0.2, 0.4)
    const left = sample
      .clone()
      .applyMatrix3(buildFacialArtworkTextureMatrix(template, role, 'left', artwork))
    const right = sample
      .clone()
      .applyMatrix3(buildFacialArtworkTextureMatrix(template, role, 'right', artwork))
    expect(left.x).toBeCloseTo(0.125)
    expect(right.x).toBeCloseTo(left.x)
  })

  it('projects pupil highlight UVs into shared iris space before applying the authored transform', () => {
    const identity = new THREE.Matrix3().identity()
    const ratio = 0.43
    const projected = buildFacialArtworkPupilHighlightTextureMatrix(identity, ratio)
    expect(new THREE.Vector2(0.5, 0.5).applyMatrix3(projected)).toEqual(
      new THREE.Vector2(0.5, 0.5)
    )
    expect(new THREE.Vector2(0, 0.5).applyMatrix3(projected).x).toBeCloseTo(0.285)
    expect(new THREE.Vector2(1, 0.5).applyMatrix3(projected).x).toBeCloseTo(0.715)

    const authored = new THREE.Matrix3().setUvTransform(0.1, -0.05, 1.2, 0.8, 0.1, 0.5, 0.5)
    const pupilPoint = new THREE.Vector2(0.8, 0.25)
    const pupilToIris = new THREE.Matrix3().set(
      ratio,
      0,
      (1 - ratio) / 2,
      0,
      ratio,
      (1 - ratio) / 2,
      0,
      0,
      1
    )
    const expected = pupilPoint.clone().applyMatrix3(pupilToIris).applyMatrix3(authored)
    const actual = pupilPoint
      .clone()
      .applyMatrix3(buildFacialArtworkPupilHighlightTextureMatrix(authored, ratio))
    expect(actual.x).toBeCloseTo(expected.x)
    expect(actual.y).toBeCloseTo(expected.y)
    expect(() => buildFacialArtworkPupilHighlightTextureMatrix(identity, -0.01)).toThrow(
      /finite non-negative/
    )
    expect(() => buildFacialArtworkPupilHighlightTextureMatrix(identity, Number.NaN)).toThrow(
      /finite non-negative/
    )
  })

  it('keeps one highlight continuous when pupil geometry is resized after artwork loads', async () => {
    const definitionValue = definition()
    const root = scene()
    const runtime = new FacialArtworkEngineRuntime(root, definitionValue, {
      loadAsync: vi.fn(async () => trackedTexture())
    })
    await runtime.apply(
      highlightState(definitionValue, '/uploads/goon_facial_artwork/highlight.png')
    )

    const projections = (
      runtime as unknown as {
        highlightProjections: Map<
          'left' | 'right',
          { pupil: THREE.Mesh; irisTexture: THREE.Texture; pupilTexture: THREE.Texture }
        >
      }
    ).highlightProjections
    const left = projections.get('left')!
    expect(left.pupilTexture).not.toBe(left.irisTexture)
    expect(new THREE.Vector2(0, 0.5).applyMatrix3(left.pupilTexture.matrix).x).toBeCloseTo(0.3)
    expect(new THREE.Vector2(1, 0.5).applyMatrix3(left.pupilTexture.matrix).x).toBeCloseTo(0.7)

    const position = left.pupil.geometry.getAttribute('position') as THREE.BufferAttribute
    for (let index = 0; index < position.count; index += 1) {
      position.setXY(index, position.getX(index) * 0.5, position.getY(index) * 0.5)
    }
    runtime.reprojectEyeHighlights()
    expect(new THREE.Vector2(0, 0.5).applyMatrix3(left.pupilTexture.matrix).x).toBeCloseTo(0.4)
    expect(new THREE.Vector2(1, 0.5).applyMatrix3(left.pupilTexture.matrix).x).toBeCloseTo(0.6)
  })

  it('uses the four-case authored-orientation mirror truth table', () => {
    const definitionValue = definition()
    const role = definitionValue.roles.find((item) => item.id === 'lashes_eye_outline')!
    const template = definitionValue.templates.find((item) => item.id === role.template)!
    const leftArtwork = createFacialArtworkArtworkLayer(
      definitionValue,
      role.id,
      upload(role.id, definitionValue, '/left.png', 'anatomical-left')
    )
    const rightArtwork = createFacialArtworkArtworkLayer(
      definitionValue,
      role.id,
      upload(role.id, definitionValue, '/right.png', 'anatomical-right')
    )

    expect(resolveFacialArtworkHorizontalReflection(role.target.left.mirrorU, leftArtwork)).toBe(false)
    expect(resolveFacialArtworkHorizontalReflection(role.target.right.mirrorU, leftArtwork)).toBe(true)
    expect(resolveFacialArtworkHorizontalReflection(role.target.left.mirrorU, rightArtwork)).toBe(true)
    expect(resolveFacialArtworkHorizontalReflection(role.target.right.mirrorU, rightArtwork)).toBe(false)

    const sample = new THREE.Vector2(0.1, 0.2)
    expect(sample.clone().applyMatrix3(buildFacialArtworkTextureMatrix(template, role, 'left', leftArtwork)).x).toBeCloseTo(0.1)
    expect(sample.clone().applyMatrix3(buildFacialArtworkTextureMatrix(template, role, 'right', leftArtwork)).x).toBeCloseTo(0.9)
    expect(sample.clone().applyMatrix3(buildFacialArtworkTextureMatrix(template, role, 'left', rightArtwork)).x).toBeCloseTo(0.9)
    expect(sample.clone().applyMatrix3(buildFacialArtworkTextureMatrix(template, role, 'right', rightArtwork)).x).toBeCloseTo(0.1)

    const rightTargetTexture = new THREE.Texture()
    configureArtworkTexture(rightTargetTexture, template, role, 'right', leftArtwork)
    expect(rightTargetTexture.matrixAutoUpdate).toBe(false)
    expect(rightTargetTexture.matrix.elements).toEqual(
      buildFacialArtworkTextureMatrix(template, role, 'right', leftArtwork).elements
    )
    for (const [sourceU, mirroredU] of [
      [0, 1],
      [0.25, 0.75],
      [0.5, 0.5],
      [1, 0]
    ]) {
      const result = new THREE.Vector2(sourceU, 0.37).applyMatrix3(rightTargetTexture.matrix)
      expect(result.x).toBeCloseTo(mirroredU)
      expect(result.y).toBeCloseTo(0.37)
    }
  })

  it('rotates and scales around the definition origin mirrored for right-authored files', () => {
    const definitionValue = definition()
    const role = definitionValue.roles.find((item) => item.id === 'lashes_eye_outline')!
    const template = definitionValue.templates.find((item) => item.id === role.template)!
    const leftArtwork = createFacialArtworkArtworkLayer(
      definitionValue,
      role.id,
      upload(role.id, definitionValue, '/left.png', 'anatomical-left')
    )
    const rightArtwork = createFacialArtworkArtworkLayer(
      definitionValue,
      role.id,
      upload(role.id, definitionValue, '/right.png', 'anatomical-right')
    )
    if (leftArtwork.mapping === 'longitude' || rightArtwork.mapping === 'longitude') {
      throw new Error('fixture requires planar eye artwork')
    }
    leftArtwork.transform.scale = 1.1
    leftArtwork.transform.rotationDegrees = 8
    rightArtwork.transform.scale = 1.1
    rightArtwork.transform.rotationDegrees = 8

    const leftOrigin = new THREE.Vector2(...template.transformOriginUv)
    const rightOrigin = new THREE.Vector2(1 - template.transformOriginUv[0], template.transformOriginUv[1])
    const leftAtLeft = leftOrigin
      .clone()
      .applyMatrix3(buildFacialArtworkTextureMatrix(template, role, 'left', leftArtwork))
    const rightAtRight = rightOrigin
      .clone()
      .applyMatrix3(buildFacialArtworkTextureMatrix(template, role, 'right', rightArtwork))
    expect(leftAtLeft.x).toBeCloseTo(leftOrigin.x)
    expect(leftAtLeft.y).toBeCloseTo(leftOrigin.y)
    expect(rightAtRight.x).toBeCloseTo(rightOrigin.x)
    expect(rightAtRight.y).toBeCloseTo(rightOrigin.y)

    const rightAuthoredAtLeft = leftOrigin
      .clone()
      .applyMatrix3(buildFacialArtworkTextureMatrix(template, role, 'left', rightArtwork))
    const leftAuthoredAtRight = rightOrigin
      .clone()
      .applyMatrix3(buildFacialArtworkTextureMatrix(template, role, 'right', leftArtwork))
    expect(rightAuthoredAtLeft.x).toBeCloseTo(rightOrigin.x)
    expect(rightAuthoredAtLeft.y).toBeCloseTo(rightOrigin.y)
    expect(leftAuthoredAtRight.x).toBeCloseTo(leftOrigin.x)
    expect(leftAuthoredAtRight.y).toBeCloseTo(leftOrigin.y)

    rightArtwork.transform.translateU = 0.02
    rightArtwork.transform.translateV = -0.03
    const reflection = new THREE.Matrix3().set(-1, 0, 1, 0, 1, 0, 0, 0, 1)
    const user = new THREE.Matrix3().setUvTransform(
      -rightArtwork.transform.translateU,
      rightArtwork.transform.translateV,
      1 / resolveFacialArtworkEffectiveScale(role, rightArtwork.transform.scale),
      1 / resolveFacialArtworkEffectiveScale(role, rightArtwork.transform.scale),
      THREE.MathUtils.degToRad(rightArtwork.transform.rotationDegrees),
      rightOrigin.x,
      rightOrigin.y
    )
    const point = new THREE.Vector2(0.2, 0.3)
    const expectedMirrorThenUser = point.clone().applyMatrix3(reflection).applyMatrix3(user)
    const forbiddenUserThenMirror = point.clone().applyMatrix3(user).applyMatrix3(reflection)
    const actual = point
      .clone()
      .applyMatrix3(buildFacialArtworkTextureMatrix(template, role, 'left', rightArtwork))
    expect(actual.x).toBeCloseTo(expectedMirrorThenUser.x)
    expect(actual.y).toBeCloseTo(expectedMirrorThenUser.y)
    expect(actual.x).not.toBeCloseTo(forbiddenUserThenMirror.x)
    expect(actual.y).not.toBeCloseTo(forbiddenUserThenMirror.y)
  })

  it('keeps horizontal movement unchanged and makes positive vertical movement travel upward', () => {
    const definitionValue = definition()
    for (const roleId of ['brows', 'lashes_eye_outline', 'iris', 'pupil', 'eye_highlight'] as const) {
      const role = definitionValue.roles.find((item) => item.id === roleId)!
      const template = definitionValue.templates.find((item) => item.id === role.template)!
      const artwork = createFacialArtworkArtworkLayer(
        definitionValue,
        role.id,
        upload(role.id, definitionValue, `/${role.id}.png`)
      )
      if (artwork.mapping === 'longitude') throw new Error('fixture requires movable artwork')
      artwork.transform.translateU = 0.02
      artwork.transform.translateV = 0.03
      const origin = new THREE.Vector2(...template.transformOriginUv)
      const transformed = origin
        .clone()
        .applyMatrix3(buildFacialArtworkTextureMatrix(template, role, 'left', artwork))
      expect(transformed.x).toBeCloseTo(origin.x - 0.02)
      expect(transformed.y).toBeCloseTo(origin.y + 0.03)
    }
  })

  it('retains the last successful visuals when a complete replacement cannot load', async () => {
    const definitionValue = definition()
    const root = scene()
    const loader = {
      loadAsync: vi.fn(async (url: string) => {
        if (url.includes('bad')) throw new Error('fixture load failure')
        return trackedTexture()
      })
    }
    const runtime = new FacialArtworkEngineRuntime(root, definitionValue, loader)
    await runtime.apply(browState(definitionValue, '/uploads/goon_facial_artwork/good.png'))
    const brow = root.getObjectByName('bs_f1_brow_canvas_l') as THREE.Mesh
    const successfulMaterial = brow.material

    await expect(
      runtime.apply(browState(definitionValue, '/uploads/goon_facial_artwork/bad.png'))
    ).rejects.toThrow(/Failed to load validated artwork/)
    expect(brow.material).toBe(successfulMaterial)
    expect(brow.visible).toBe(true)
  })

  it('disposes source and clone resources loaded only for an abandoned stale candidate', async () => {
    const definitionValue = definition()
    const root = scene()
    const good = trackedTexture()
    const abandoned = trackedTexture()
    let releaseAbandoned!: () => void
    const abandonedReady = new Promise<void>((resolvePromise) => {
      releaseAbandoned = resolvePromise
    })
    const loader = {
      loadAsync: vi.fn(async (url: string) => {
        if (url.includes('abandoned')) {
          await abandonedReady
          return abandoned
        }
        return good
      })
    }
    const runtime = new FacialArtworkEngineRuntime(root, definitionValue, loader)
    const goodState = browState(definitionValue, '/uploads/goon_facial_artwork/good.png')
    await runtime.apply(goodState)
    const stale = runtime.apply(
      browState(definitionValue, '/uploads/goon_facial_artwork/abandoned.png')
    )
    await Promise.resolve()
    await runtime.apply(goodState)
    releaseAbandoned()
    await expect(stale).resolves.toBe(false)
    expect(abandoned.dispose).toHaveBeenCalledOnce()
  })

  it('restores original material and visibility on disposal', async () => {
    const definitionValue = definition()
    const root = scene()
    const brow = root.getObjectByName('bs_f1_brow_canvas_l') as THREE.Mesh
    const original = brow.material
    const runtime = new FacialArtworkEngineRuntime(root, definitionValue, {
      loadAsync: vi.fn(async () => trackedTexture())
    })
    await runtime.apply(browState(definitionValue, '/uploads/goon_facial_artwork/good.png'))
    runtime.dispose()
    expect(brow.material).toBe(original)
    expect(brow.visible).toBe(true)
  })
})
