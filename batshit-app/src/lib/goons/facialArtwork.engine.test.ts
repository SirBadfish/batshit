import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { FacialArtworkEngineRuntime } from './facialArtwork.engine'
import {
  createDefaultFacialArtworkState,
  createFacialArtworkArtworkLayer,
  parseFacialArtworkDefinition,
  type FacialArtworkDefinitionV2,
  type FacialArtworkRoleId
} from './facialArtwork'

function definition(): FacialArtworkDefinitionV2 {
  return parseFacialArtworkDefinition(
    JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'static/goons/facial-artwork/v2/facial-artwork-v2.json'),
        'utf8'
      )
    )
  )
}

function mesh(name: string, material: THREE.Material) {
  const value = new THREE.Mesh(new THREE.BufferGeometry(), material)
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
    mesh('bs_f1_eye_l_iris', sharedEyeMaterial),
    mesh('bs_f1_eye_r_iris', sharedEyeMaterial),
    mesh('bs_f1_eye_l_pupil', sharedEyeMaterial),
    mesh('bs_f1_eye_r_pupil', sharedEyeMaterial),
    mesh('bs_f1_eye_l_sclera', sharedEyeMaterial),
    mesh('bs_f1_eye_r_sclera', sharedEyeMaterial)
  )
  return root
}

function upload(role: FacialArtworkRoleId, definitionValue: FacialArtworkDefinitionV2, url: string) {
  const roleDefinition = definitionValue.roles.find((item) => item.id === role)!
  const template = definitionValue.templates.find((item) => item.id === roleDefinition.template)!
  return {
    role,
    url,
    filename: url.split('/').at(-1)!,
    size: 123,
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

function browState(definitionValue: FacialArtworkDefinitionV2, url: string) {
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

function trackedTexture() {
  const value = new THREE.Texture()
  vi.spyOn(value, 'dispose')
  return value
}

describe('FacialArtworkEngineRuntime v2', () => {
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

  it('keeps FrontSide canvas rendering and mirrors a shared upload through per-side texture clones', async () => {
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
    expect((left.material as THREE.Material).side).toBe(THREE.FrontSide)
    expect((right.material as THREE.Material).side).toBe(THREE.FrontSide)
    expect(loader.loadAsync).toHaveBeenCalledOnce()
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
