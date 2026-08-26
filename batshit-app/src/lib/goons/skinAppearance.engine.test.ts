import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { SkinAppearanceEngineRuntime } from './skinAppearance.engine'
import {
  SkinArtworkProjectionRuntime,
  type SkinArtworkProjectionDefinitionV8
} from './skinArtworkProjection'
import {
  createDefaultSkinAppearanceState,
  parseSkinAppearanceDefinition,
  setCustomSkinSurfaceUpload,
  updateSkinAppearanceRegion,
  updateSkinAppearanceSurface,
  type SkinAppearanceDefinitionV1
} from './skinAppearance'
import type { SkinSurfaceMapRole, SkinSurfaceUploadV1 } from './skinSurface'

function definition() {
  return parseSkinAppearanceDefinition(
    JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          'static/goons/skin-appearance/v1/skin-appearance-v1.json'
        ),
        'utf8'
      )
    )
  )
}

function fixtureRoot(contract: SkinAppearanceDefinitionV1) {
  const texture = new THREE.Texture()
  texture.image = {
    width: contract.canvas.width,
    height: contract.canvas.height
  }
  texture.flipY = false
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: contract.materialDefaults.roughness,
    metalness: contract.materialDefaults.metalness,
    map: texture
  })
  material.name = contract.runtimeBinding.material
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)
  )
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2))
  geometry.setIndex([0, 1, 2])
  geometry.computeVertexNormals()
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = contract.runtimeBinding.node
  const root = new THREE.Group()
  root.add(mesh)
  return { root, mesh, material, texture }
}

function mockCanvases() {
  const calls: Array<{
    canvas: number
    operation: string
    kind: 'draw' | 'fill' | 'clear'
  }> = []
  let canvasIndex = 0
  const originalCreateElement = document.createElement.bind(document)
  const spy = vi.spyOn(document, 'createElement').mockImplementation(((
    tagName: string
  ) => {
    if (tagName !== 'canvas') return originalCreateElement(tagName)
    const index = canvasIndex++
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn()
    }
    const context = {
      canvas,
      fillStyle: '',
      globalCompositeOperation: 'source-over',
      clearRect: vi.fn(() =>
        calls.push({ canvas: index, operation: context.globalCompositeOperation, kind: 'clear' })
      ),
      fillRect: vi.fn(() =>
        calls.push({ canvas: index, operation: context.globalCompositeOperation, kind: 'fill' })
      ),
      drawImage: vi.fn(() =>
        calls.push({ canvas: index, operation: context.globalCompositeOperation, kind: 'draw' })
      )
    }
    canvas.getContext.mockReturnValue(context)
    return canvas
  }) as typeof document.createElement)
  return { calls, spy }
}

const HASH_BY_ROLE: Record<SkinSurfaceMapRole, string> = {
  baseColor: 'a'.repeat(64),
  normal: 'b'.repeat(64),
  roughness: 'c'.repeat(64),
  metallic: 'd'.repeat(64)
}

function upload(
  role: SkinSurfaceMapRole,
  contract: SkinAppearanceDefinitionV1
): SkinSurfaceUploadV1 {
  const baseColor = role === 'baseColor'
  return {
    schemaVersion: 'skin-surface-artwork/v1',
    map: role,
    url: `/uploads/goon_skin_artwork/${role}.png`,
    filename: `${role}.png`,
    size: 100,
    mimeType: 'image/png',
    sha256: HASH_BY_ROLE[role],
    definitionSha256: contract.definitionSha256,
    canvas: {
      width: baseColor ? 4096 : 2048,
      height: baseColor ? 4096 : 2048,
      colorSpace: baseColor ? 'srgb' : 'linear',
      flipY: false,
      encoding:
        role === 'baseColor'
          ? 'rgba8'
          : role === 'normal'
            ? 'rgb8-normal-opengl'
            : role === 'roughness'
              ? 'rgb8-roughness-g'
              : 'rgb8-metallic-b'
    },
    provenance: {
      sourceKind: 'user-authored',
      author: 'Josh',
      license: 'LicenseRef-User-Owned',
      rightsConfirmed: true
    }
  }
}

function texture(width: number, height = width) {
  const value = new THREE.Texture()
  value.image = { width, height }
  return value
}

function artworkProjection(
  contract: SkinAppearanceDefinitionV1
): SkinArtworkProjectionDefinitionV8 {
  const point = { triangle: 0, barycentric: [1, 0, 0] as [number, number, number] }
  const circle = (side: 'left' | 'right', center: [number, number]) => ({
    side,
    sourceArtworkCenterUv: center,
    surfaceCenterUv: center,
    deformationCenterUv: center,
    sourceOuterRadiusUv: 0.006,
    deformationFrameRadiusUv: 0.01,
    supportRadiusUv: 0.014,
    neutralOuterRadiusMeters: 0.013,
    neutralSizeFrameMeters: [0.02, 0.02] as [number, number],
    neutralCenterFrameRatios: [0, 0, 0] as [number, number, number],
    anchors: {
      ownershipSeed: point,
      outerBoundary: Array.from({ length: 8 }, () => point),
      deformationFrame: {
        uMinus: point,
        uPlus: point,
        vMinus: point,
        vPlus: point
      }
    }
  })
  return {
    schemaVersion: 'skin-artwork-projection/v8',
    status: 'synthetic-test',
    productExportApproved: true,
    definitionSha256: '0'.repeat(64),
    metric: 'nipple-base-ring-single-surface-circle/v3',
    projectionOrigin: 'selected-outer-boundary-stable-frame/v1',
    pigmentExtraction: 'isolated-skin-appearance-region-layer/v1',
    surfaceOwnership: 'center-connected-projection-island/v1',
    radiusResponse: {
      driver: 'appearance-dial/nipple_size-positive/v1',
      positiveMaximumMultiplier: 2,
      maximumOuterRadiusMeters: 0.04,
      bakedDriverValue: null
    },
    runtimeBinding: {
      node: contract.runtimeBinding.node,
      material: contract.runtimeBinding.material,
      vertexCount: 3,
      indexCount: 3,
      indexSha256: 'b'.repeat(64),
      uvSha256: 'c'.repeat(64),
      surfaceOffsetMeters: 0,
      overlayTextureSize: 64,
      overlayTextureRadiusUv: 0.4
    },
    circles: [circle('left', [0.3, 0.3]), circle('right', [0.7, 0.3])]
  }
}

describe('SkinAppearanceEngineRuntime', () => {
  it('composes tinted Base Color and regions, then binds all custom PBR roles correctly', async () => {
    const contract = definition()
    const fixture = fixtureRoot(contract)
    const canvases = mockCanvases()
    const custom = {
      baseColor: texture(4096),
      normal: texture(2048),
      roughness: texture(2048),
      metallic: texture(2048)
    }
    const masks = {
      [contract.masks.nipplesAreolae.path]: texture(2048),
      [contract.masks.palmsSoles.path]: texture(2048),
      [contract.masks.cheekBlush.path]: texture(2048)
    }
    const loadAsync = vi.fn(async (url: string) => {
      const uploadRole = (Object.keys(custom) as SkinSurfaceMapRole[]).find((role) =>
        url.endsWith(`/${role}.png`)
      )
      if (uploadRole) return custom[uploadRole]
      const path = url.replace(/^\//, '')
      const mask = masks[path]
      if (!mask) throw new Error(`Unexpected texture URL ${url}`)
      return mask
    })
    const runtime = new SkinAppearanceEngineRuntime(fixture.root, contract, { loadAsync })
    let state = createDefaultSkinAppearanceState(contract)
    for (const role of ['baseColor', 'normal', 'roughness', 'metallic'] as const) {
      state = setCustomSkinSurfaceUpload(contract, state, role, upload(role, contract))
    }
    state = updateSkinAppearanceRegion(contract, state, 'palmsSoles', {
      mode: 'custom',
      color: [0.8, 0.6, 0.4]
    })
    state = updateSkinAppearanceRegion(contract, state, 'cheekBlush', {
      mode: 'off'
    })

    try {
      expect(await runtime.apply(state)).toBe(true)
      expect(fixture.mesh.material).not.toBe(fixture.material)
      expect(fixture.mesh.material.map).toBeInstanceOf(THREE.CanvasTexture)
      expect(fixture.mesh.material.normalMap).toBe(custom.normal)
      expect(fixture.mesh.material.normalMap?.colorSpace).toBe(THREE.NoColorSpace)
      expect(fixture.mesh.material.normalMap?.flipY).toBe(false)
      expect(fixture.mesh.material.normalScale.toArray()).toEqual([1, -1])
      expect(fixture.mesh.material.roughnessMap).toBe(custom.roughness)
      expect(fixture.mesh.material.roughness).toBe(1)
      expect(fixture.mesh.material.metalnessMap).toBe(custom.metallic)
      expect(fixture.mesh.material.metalness).toBe(1)
      expect(canvases.calls.slice(0, 3)).toEqual([
        { canvas: 0, operation: 'source-over', kind: 'draw' },
        { canvas: 0, operation: 'multiply', kind: 'fill' },
        { canvas: 0, operation: 'destination-in', kind: 'draw' }
      ])
    } finally {
      runtime.dispose()
      canvases.spy.mockRestore()
    }
  })

  it('uses explicit None scalars and restores the exact package material on null', async () => {
    const contract = definition()
    const fixture = fixtureRoot(contract)
    const runtime = new SkinAppearanceEngineRuntime(fixture.root, contract, {
      loadAsync: vi.fn()
    })
    let state = createDefaultSkinAppearanceState(contract)
    state = updateSkinAppearanceSurface(contract, state, 'normal', {
      mode: 'none',
      custom: null
    })
    state = updateSkinAppearanceSurface(contract, state, 'roughness', {
      mode: 'none',
      custom: null
    })
    state = updateSkinAppearanceSurface(contract, state, 'metallic', {
      mode: 'none',
      custom: null
    })

    expect(await runtime.apply(state)).toBe(true)
    expect(fixture.mesh.material.map).toBe(fixture.texture)
    expect(fixture.mesh.material.normalMap).toBeNull()
    expect(fixture.mesh.material.roughnessMap).toBeNull()
    expect(fixture.mesh.material.roughness).toBe(contract.materialDefaults.roughness)
    expect(fixture.mesh.material.metalnessMap).toBeNull()
    expect(fixture.mesh.material.metalness).toBe(0)

    expect(await runtime.apply(null)).toBe(true)
    expect(fixture.mesh.material).toBe(fixture.material)
    runtime.dispose()
  })

  it('keeps body maps on UV0 and commits the isolated surface artwork', async () => {
    const contract = definition()
    const fixture = fixtureRoot(contract)
    const canvases = mockCanvases()
    const normal = texture(2048)
    const roughness = texture(2048)
    const metallic = texture(2048)
    fixture.material.normalMap = normal
    fixture.material.roughnessMap = roughness
    fixture.material.metalnessMap = metallic
    const initialize = vi
      .spyOn(SkinArtworkProjectionRuntime.prototype, 'initialize')
      .mockResolvedValue()
    const synchronize = vi
      .spyOn(SkinArtworkProjectionRuntime.prototype, 'syncSurfaceGeometry')
      .mockImplementation(() => {})
    const prepareArtwork = vi
      .spyOn(SkinArtworkProjectionRuntime.prototype, 'prepareArtwork')
      .mockReturnValue({ overlays: [] } as any)
    const commitPrepared = vi
      .spyOn(SkinArtworkProjectionRuntime.prototype, 'commitPrepared')
      .mockImplementation(() => {})
    const disposePrepared = vi
      .spyOn(SkinArtworkProjectionRuntime.prototype, 'disposePrepared')
      .mockImplementation(() => {})
    const runtime = new SkinAppearanceEngineRuntime(
      fixture.root,
      contract,
      { loadAsync: vi.fn(async () => texture(2048)) },
      artworkProjection(contract)
    )

    try {
      expect(await runtime.apply(null)).toBe(true)
      expect(initialize).toHaveBeenCalledOnce()
      expect(fixture.mesh.material.map).not.toBe(fixture.texture)
      expect(fixture.mesh.material.map?.channel).toBe(0)
      expect(fixture.texture.channel).toBe(0)
      expect(prepareArtwork).toHaveBeenCalledOnce()
      const isolatedPigmentCanvas = prepareArtwork.mock.calls[0]![0]
      expect(isolatedPigmentCanvas.getContext('2d')!.drawImage).not.toHaveBeenCalled()
      expect(commitPrepared).toHaveBeenCalledOnce()
      expect(fixture.mesh.material.normalMap).toBe(normal)
      expect(fixture.mesh.material.normalMap?.channel).toBe(0)
      expect(fixture.mesh.material.roughnessMap).toBe(roughness)
      expect(fixture.mesh.material.roughnessMap?.channel).toBe(0)
      expect(fixture.mesh.material.metalnessMap).toBe(metallic)
      expect(fixture.mesh.material.metalnessMap?.channel).toBe(0)
      runtime.syncSurfaceGeometry()
      expect(synchronize).toHaveBeenCalledOnce()

      prepareArtwork.mockClear()
      let colored = createDefaultSkinAppearanceState(contract)
      colored = updateSkinAppearanceRegion(contract, colored, 'nipplesAreolae', {
        mode: 'custom',
        color: [0.7, 0.2, 0.25]
      })
      expect(await runtime.apply(colored)).toBe(true)
      const coloredPigmentCanvas = prepareArtwork.mock.calls[0]![0]
      expect(coloredPigmentCanvas.getContext('2d')!.drawImage).toHaveBeenCalledOnce()
    } finally {
      runtime.dispose()
      initialize.mockRestore()
      synchronize.mockRestore()
      prepareArtwork.mockRestore()
      commitPrepared.mockRestore()
      disposePrepared.mockRestore()
      canvases.spy.mockRestore()
    }
  })

  it('fails closed and leaves the last-good material mounted when a custom map is wrong', async () => {
    const contract = definition()
    const fixture = fixtureRoot(contract)
    const wrong = texture(64)
    const runtime = new SkinAppearanceEngineRuntime(fixture.root, contract, {
      loadAsync: vi.fn(async () => wrong)
    })
    let state = createDefaultSkinAppearanceState(contract)
    state = updateSkinAppearanceSurface(contract, state, 'normal', {
      mode: 'none',
      custom: null
    })
    await runtime.apply(state)
    const lastGood = fixture.mesh.material
    state = setCustomSkinSurfaceUpload(
      contract,
      state,
      'normal',
      upload('normal', contract)
    )
    await expect(runtime.apply(state)).rejects.toThrow(/dimensions do not match/)
    expect(fixture.mesh.material).toBe(lastGood)
    runtime.dispose()
  })

  it('fails closed on missing mesh and renamed body material', () => {
    const contract = definition()
    expect(() => new SkinAppearanceEngineRuntime(new THREE.Group(), contract)).toThrow(
      /found 0/
    )
    const renamed = fixtureRoot(contract)
    renamed.material.name = 'wrong'
    expect(
      () => new SkinAppearanceEngineRuntime(renamed.root, contract)
    ).toThrow(/must use/)
  })
})
