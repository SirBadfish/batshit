import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import type { EyeAppearanceEngineRuntime } from './eyeAppearance.engine'
import {
  FacialArtworkEngineRuntime,
  buildFacialArtworkTextureMatrix,
  configureArtworkTexture,
  resolveFacialArtworkHorizontalReflection
} from './facialArtwork.engine'
import {
  createDefaultFacialArtworkState,
  createFacialArtworkArtworkLayer,
  parseFacialArtworkDefinition,
  resolveFacialArtworkTemplateVariant,
  type FacialArtworkDefinitionV4,
  type FacialArtworkOrientation,
  type FacialArtworkRoleId
} from './facialArtwork'
import type { SocketEyeSurfaceEngineRuntime } from './socketEyeSurface.engine'

function definition(): FacialArtworkDefinitionV4 {
  const value = JSON.parse(
    readFileSync(resolve(process.cwd(), 'static/goons/facial-artwork/v4/facial-artwork-v4.json'), 'utf8')
  ) as Record<string, any>
  for (const role of value.roles) {
    const bindingKind =
      role.id === 'brows'
        ? 'face-conformal-canvas'
        : role.id === 'lashes_eye_outline'
          ? 'eye-aperture-liner'
          : 'socket-eye-composite-layer'
    const compositeLayer =
      role.id === 'sclera'
        ? 'scleraArtwork'
        : role.id === 'eye_highlight'
          ? 'highlight'
          : role.id === 'iris' || role.id === 'pupil'
            ? role.id
            : null
    for (const side of ['left', 'right'] as const) {
      role.target[side].bindingKind = bindingKind
      role.target[side].compositeLayer = compositeLayer
      if (bindingKind === 'socket-eye-composite-layer') {
        role.target[side].runtimeNodes = [`${side}-cap`]
      } else if (role.id === 'lashes_eye_outline') {
        role.target[side].runtimeNodes = [`${side}-liner`]
      }
    }
  }
  return parseFacialArtworkDefinition(value)
}

function upload(
  role: FacialArtworkRoleId,
  definitionValue: FacialArtworkDefinitionV4,
  url: string,
  orientation?: FacialArtworkOrientation
) {
  const roleDefinition = definitionValue.roles.find((entry) => entry.id === role)!
  const template = definitionValue.templates.find((entry) => entry.id === roleDefinition.template)!
  const resolvedOrientation = orientation ?? template.canonicalOrientation
  const variant = resolveFacialArtworkTemplateVariant(template, resolvedOrientation)
  return {
    role,
    url,
    filename: `${role}.png`,
    size: 10,
    mimeType: 'image/png' as const,
    sha256: 'd'.repeat(64),
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

function runtimeFixture() {
  const definitionValue = definition()
  const root = new THREE.Group()
  for (const role of definitionValue.roles) {
    for (const side of ['left', 'right'] as const) {
      if (role.target[side].bindingKind === 'socket-eye-composite-layer') continue
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
      mesh.name = role.target[side].runtimeNodes[0]
      root.add(mesh)
    }
  }
  const socketEyes = {
    setVisualState: vi.fn(),
    getLinerArtworkMesh: vi.fn((side: 'left' | 'right') => {
      const liner = root.getObjectByName(`${side}-liner`)
      if (!(liner instanceof THREE.Mesh)) throw new Error(`fixture lacks ${side} liner`)
      return liner
    })
  } as unknown as SocketEyeSurfaceEngineRuntime
  const eyeAppearance = {
    resolveSide: vi.fn((side: 'left' | 'right') => ({
      irisRadiusMeters: side === 'left' ? 0.006 : 0.0062,
      pupilRadiusRatio: 0.4,
      irisVerticalOffsetMeters: side === 'left' ? 0.001 : 0.0012,
      edgeSoftnessMeters: 0.0001,
      cornea: { roughness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.1 }
    }))
  } as unknown as EyeAppearanceEngineRuntime
  return { definitionValue, root, socketEyes, eyeAppearance }
}

function trackedTexture() {
  const value = new THREE.Texture()
  vi.spyOn(value, 'dispose')
  return value
}

describe('FacialArtworkEngineRuntime v4', () => {
  it('routes opaque eye roles into one composite material instead of assigning globe meshes', async () => {
    const value = runtimeFixture()
    const runtime = new FacialArtworkEngineRuntime(
      value.root,
      value.definitionValue,
      value.socketEyes,
      value.eyeAppearance
    )
    await runtime.apply(null)
    expect(value.socketEyes.setVisualState).toHaveBeenCalledTimes(2)
    expect(value.socketEyes.setVisualState).toHaveBeenCalledWith(
      'left',
      expect.objectContaining({
        irisRadiusMeters: 0.006,
        pupilRadiusRatio: 0.4,
        irisVerticalOffsetMeters: 0.001,
        cornea: { roughness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.1 }
      })
    )
    expect(value.root.getObjectByName('bs_f1_brow_canvas_l')?.visible).toBe(false)
    expect(value.root.getObjectByName('left-liner')?.visible).toBe(false)
  })

  it('hands every socket-eye artwork role to its ordered composite layer', async () => {
    const value = runtimeFixture()
    const state = createDefaultFacialArtworkState(value.definitionValue)
    for (const roleId of ['sclera', 'iris', 'pupil', 'eye_highlight'] as const) {
      const role = state.roles[roleId]
      if (role.mode !== 'shared') throw new Error('fixture requires shared state')
      role.shared.visible = true
      role.shared.artwork = createFacialArtworkArtworkLayer(
        value.definitionValue,
        roleId,
        upload(roleId, value.definitionValue, `/${roleId}.png`)
      )
    }
    const runtime = new FacialArtworkEngineRuntime(
      value.root,
      value.definitionValue,
      value.socketEyes,
      value.eyeAppearance,
      { loadAsync: vi.fn(async () => trackedTexture()) }
    )
    await runtime.apply(state)
    const leftCall = vi.mocked(value.socketEyes.setVisualState).mock.calls.find(([side]) => side === 'left')!
    expect(leftCall[1].scleraArtwork.texture).toBeInstanceOf(THREE.Texture)
    expect(leftCall[1].irisArtwork.texture).toBeInstanceOf(THREE.Texture)
    expect(leftCall[1].pupilArtwork.texture).toBeInstanceOf(THREE.Texture)
    expect(leftCall[1].highlight.texture).toBeInstanceOf(THREE.Texture)
    expect(
      new Set(
        [
          leftCall[1].scleraArtwork.texture,
          leftCall[1].irisArtwork.texture,
          leftCall[1].pupilArtwork.texture,
          leftCall[1].highlight.texture
        ].map((textureValue) => textureValue?.uuid)
      ).size
    ).toBe(4)
  })

  it('keeps the shared-seam liner FrontSide with ordinary depth testing', async () => {
    const value = runtimeFixture()
    const state = createDefaultFacialArtworkState(value.definitionValue)
    const role = state.roles.lashes_eye_outline
    if (role.mode !== 'shared') throw new Error('fixture requires shared liner')
    role.shared.visible = true
    role.shared.artwork = createFacialArtworkArtworkLayer(
      value.definitionValue,
      'lashes_eye_outline',
      upload('lashes_eye_outline', value.definitionValue, '/liner.png')
    )
    const runtime = new FacialArtworkEngineRuntime(
      value.root,
      value.definitionValue,
      value.socketEyes,
      value.eyeAppearance,
      { loadAsync: vi.fn(async () => trackedTexture()) }
    )
    await runtime.apply(state)
    const liner = value.root.getObjectByName('left-liner') as THREE.Mesh
    expect((liner.material as THREE.Material).side).toBe(THREE.FrontSide)
    expect((liner.material as THREE.Material).depthTest).toBe(true)
    expect((liner.material as THREE.Material).depthWrite).toBe(false)
  })

  it('keeps the hidden liner seal transparent under artwork transforms', async () => {
    const value = runtimeFixture()
    const liner = value.root.getObjectByName('left-liner') as THREE.Mesh
    const visible = liner.material as THREE.Material
    const hidden = new THREE.MeshBasicMaterial({
      opacity: 0,
      transparent: true,
      depthWrite: false
    })
    hidden.name = 'bs_f1_eye_treatment_canvas_l_hidden_seal_mat'
    hidden.visible = false
    hidden.colorWrite = false
    const hiddenMesh = new THREE.Mesh(new THREE.BufferGeometry(), hidden)
    hiddenMesh.name = 'left-liner-hidden-seal'
    value.root.add(hiddenMesh)

    const state = createDefaultFacialArtworkState(value.definitionValue)
    const role = state.roles.lashes_eye_outline
    if (role.mode !== 'shared') throw new Error('fixture requires shared liner')
    role.shared.visible = true
    role.shared.artwork = createFacialArtworkArtworkLayer(
      value.definitionValue,
      'lashes_eye_outline',
      upload('lashes_eye_outline', value.definitionValue, '/liner.png')
    )
    role.shared.artwork.transform = {
      translateU: 0.04,
      translateV: -0.08,
      scale: 1.15,
      rotationDegrees: 8
    }
    const runtime = new FacialArtworkEngineRuntime(
      value.root,
      value.definitionValue,
      value.socketEyes,
      value.eyeAppearance,
      { loadAsync: vi.fn(async () => trackedTexture()) }
    )

    await runtime.apply(state)

    expect(liner.material).not.toBe(visible)
    expect(hiddenMesh.material).toBe(hidden)
    expect(hidden.visible).toBe(false)
    expect(hidden.colorWrite).toBe(false)
    expect(hidden.transparent).toBe(true)
    expect(hidden.opacity).toBe(0)
    expect(hidden.depthWrite).toBe(false)
  })

  it('refreshes material calibration without reloading artwork and disposes only owned textures', async () => {
    const value = runtimeFixture()
    const source = trackedTexture()
    const loadAsync = vi.fn(async () => source)
    const runtime = new FacialArtworkEngineRuntime(
      value.root,
      value.definitionValue,
      value.socketEyes,
      value.eyeAppearance,
      { loadAsync }
    )
    await runtime.apply(null)
    runtime.refreshSocketVisualState()
    expect(loadAsync).not.toHaveBeenCalled()
    runtime.dispose()
    expect(source.dispose).not.toHaveBeenCalled()
  })
})

describe('Facial Artwork v4 texture transforms', () => {
  it('uses the authored-orientation mirror truth table', () => {
    const definitionValue = definition()
    const role = definitionValue.roles.find((entry) => entry.id === 'lashes_eye_outline')!
    const template = definitionValue.templates.find((entry) => entry.id === role.template)!
    const left = createFacialArtworkArtworkLayer(
      definitionValue,
      role.id,
      upload(role.id, definitionValue, '/left.png', 'anatomical-left')
    )
    const right = createFacialArtworkArtworkLayer(
      definitionValue,
      role.id,
      upload(role.id, definitionValue, '/right.png', 'anatomical-right')
    )
    expect(resolveFacialArtworkHorizontalReflection(role.target.left.mirrorU, left)).toBe(false)
    expect(resolveFacialArtworkHorizontalReflection(role.target.right.mirrorU, left)).toBe(true)
    expect(resolveFacialArtworkHorizontalReflection(role.target.left.mirrorU, right)).toBe(true)
    expect(resolveFacialArtworkHorizontalReflection(role.target.right.mirrorU, right)).toBe(false)

    const textureValue = new THREE.Texture()
    configureArtworkTexture(textureValue, template, role, 'right', left)
    expect(textureValue.matrix.elements).toEqual(
      buildFacialArtworkTextureMatrix(template, role, 'right', left).elements
    )
  })
})
