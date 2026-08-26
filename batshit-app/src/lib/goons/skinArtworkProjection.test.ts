import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalRecipeSha256,
  sha256Hex
} from './recipe/recipeCanonical'
import {
  SkinArtworkProjectionRuntime,
  bakeSkinArtworkProjectionDefinition,
  parseSkinArtworkProjectionDefinition,
  verifySkinArtworkProjectionDefinition,
  type SkinArtworkProjectionDefinitionV8,
  type SkinArtworkSurfacePointV1
} from './skinArtworkProjection'

const CENTERS = {
  left: [0.25, 0.5] as [number, number],
  right: [0.75, 0.5] as [number, number]
}

function viewBytes(value: ArrayBufferView) {
  return Uint8Array.from(
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  )
}

function barycentric2d(
  point: [number, number],
  a: [number, number],
  b: [number, number],
  c: [number, number]
) {
  const v0 = [b[0] - a[0], b[1] - a[1]]
  const v1 = [c[0] - a[0], c[1] - a[1]]
  const v2 = [point[0] - a[0], point[1] - a[1]]
  const denominator = v0[0] * v1[1] - v1[0] * v0[1]
  const second = (v2[0] * v1[1] - v1[0] * v2[1]) / denominator
  const third = (v0[0] * v2[1] - v2[0] * v0[1]) / denominator
  return [1 - second - third, second, third] as [number, number, number]
}

function locate(
  point: [number, number],
  uv: THREE.BufferAttribute,
  index: THREE.BufferAttribute
): SkinArtworkSurfacePointV1 {
  for (let triangle = 0; triangle < index.count / 3; triangle += 1) {
    const vertices = [0, 1, 2].map((corner) => index.getX(triangle * 3 + corner))
    const triangleUv = vertices.map(
      (vertex) => [uv.getX(vertex), uv.getY(vertex)] as [number, number]
    )
    const barycentric = barycentric2d(
      point,
      triangleUv[0],
      triangleUv[1],
      triangleUv[2]
    )
    if (barycentric.every((weight) => weight >= -1e-6 && weight <= 1 + 1e-6)) {
      return { triangle, barycentric }
    }
  }
  throw new Error(`Synthetic point ${point.join(',')} is outside the fixture`)
}

function fixtureGeometry() {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const grid = [-0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06]
  for (const center of Object.values(CENTERS)) {
    const offset = positions.length / 3
    for (const dv of grid) {
      for (const du of grid) {
        uvs.push(center[0] + du, center[1] + dv)
        positions.push(du * 2, dv, center === CENTERS.left ? 0 : 0.2)
      }
    }
    for (let row = 0; row < grid.length - 1; row += 1) {
      for (let column = 0; column < grid.length - 1; column += 1) {
        const a = offset + row * grid.length + column
        const b = a + 1
        const c = a + grid.length
        const d = c + 1
        indices.push(a, b, d, a, d, c)
      }
    }
    const duplicate = positions.length / 3
    uvs.push(
      center[0] + 0.025,
      center[1] + 0.025,
      center[0] + 0.035,
      center[1] + 0.025,
      center[0] + 0.03,
      center[1] + 0.035
    )
    const z = center === CENTERS.left ? 0 : 0.2
    positions.push(-0.004, -0.004, z, 0.004, -0.004, z, 0, 0.004, z)
    indices.push(duplicate, duplicate + 1, duplicate + 2)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

async function definitionFor(
  geometry: THREE.BufferGeometry
): Promise<SkinArtworkProjectionDefinitionV8> {
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute
  const index = geometry.getIndex()!
  const circles = (
    Object.entries(CENTERS) as Array<['left' | 'right', [number, number]]>
  ).map(([side, center]) => {
    const ring: Array<[number, number]> = [
      [-0.02, 0],
      [-0.02, -0.02],
      [0, -0.02],
      [0.02, -0.02],
      [0.02, 0],
      [0.02, 0.02],
      [0, 0.02],
      [-0.02, 0.02]
    ].map(([du, dv]) => [center[0] + du, center[1] + dv])
    return {
      side,
      sourceArtworkCenterUv: center,
      surfaceCenterUv: center,
      deformationCenterUv: center,
      sourceOuterRadiusUv: 0.01,
      deformationFrameRadiusUv: 0.02,
      supportRadiusUv: 0.05,
      neutralOuterRadiusMeters: 0.01,
      neutralSizeFrameMeters: [0.08, 0.04] as [number, number],
      neutralCenterFrameRatios: [0, 0, 0] as [number, number, number],
      anchors: {
        ownershipSeed: locate(center, uv, index),
        outerBoundary: ring.map((point) => locate(point, uv, index)),
        deformationFrame: {
          uMinus: locate([center[0] - 0.02, center[1]], uv, index),
          uPlus: locate([center[0] + 0.02, center[1]], uv, index),
          vMinus: locate([center[0], center[1] - 0.02], uv, index),
          vPlus: locate([center[0], center[1] + 0.02], uv, index)
        }
      }
    }
  }) as SkinArtworkProjectionDefinitionV8['circles']
  const definition: SkinArtworkProjectionDefinitionV8 = {
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
      node: 'body',
      material: 'body-material',
      vertexCount: uv.count,
      indexCount: index.count,
      indexSha256: await sha256Hex(viewBytes(index.array)),
      uvSha256: await sha256Hex(viewBytes(uv.array)),
      surfaceOffsetMeters: 0,
      overlayTextureSize: 64,
      overlayTextureRadiusUv: 0.4
    },
    circles
  }
  definition.definitionSha256 = await canonicalRecipeSha256(definition)
  return definition
}

async function fixture() {
  const geometry = fixtureGeometry()
  const material = new THREE.MeshStandardMaterial()
  material.name = 'body-material'
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'body'
  const root = new THREE.Group()
  root.add(mesh)
  return { root, mesh, geometry, definition: await definitionFor(geometry) }
}

function artworkCanvas(
  width: number,
  height: number,
  pixel: [number, number, number, number] = [0, 0, 0, 0]
) {
  const canvas = {
    width,
    height,
    getContext: vi.fn()
  } as unknown as HTMLCanvasElement
  const context = {
    canvas,
    drawImage: vi.fn(),
    getImageData: vi.fn(
      (_x: number, _y: number, imageWidth: number, imageHeight: number) => {
        const data = new Uint8ClampedArray(imageWidth * imageHeight * 4)
        for (let offset = 0; offset < data.length; offset += 4) {
          data.set(pixel, offset)
        }
        return { data, width: imageWidth, height: imageHeight, colorSpace: 'srgb' }
      }
    ),
    putImageData: vi.fn()
  } as unknown as CanvasRenderingContext2D
  vi.mocked(canvas.getContext).mockReturnValue(context)
  return canvas
}

describe('skin-artwork-projection/v8', () => {
  it('parses one exact bilateral surface-circle law and rejects hidden keys', async () => {
    const value = await fixture()
    expect(parseSkinArtworkProjectionDefinition(value.definition)).toEqual(
      value.definition
    )
    expect(await verifySkinArtworkProjectionDefinition(value.definition)).toEqual(
      value.definition
    )
    const baked = await bakeSkinArtworkProjectionDefinition(value.definition, 1)
    expect(baked.radiusResponse.bakedDriverValue).toBe(1)
    await expect(verifySkinArtworkProjectionDefinition(baked)).resolves.toEqual(
      baked
    )
    const hidden = structuredClone(value.definition) as any
    hidden.circles[0].dial = 'nipple-size-incr'
    expect(() => parseSkinArtworkProjectionDefinition(hidden)).toThrow(/exactly/)
    const mismatched = structuredClone(value.definition)
    mismatched.circles[1].neutralOuterRadiusMeters = 0.02
    expect(() => parseSkinArtworkProjectionDefinition(mismatched)).toThrow(
      /one bilateral artwork law/
    )
    const stale = structuredClone(value.definition)
    stale.status = 'changed-without-rehash'
    await expect(verifySkinArtworkProjectionDefinition(stale)).rejects.toThrow(
      /does not match canonical content/
    )
  })

  it('keeps body UV untouched and maps resolved anatomy to a centered overlay circle', async () => {
    const value = await fixture()
    const runtime = new SkinArtworkProjectionRuntime(
      value.root,
      parseSkinArtworkProjectionDefinition(value.definition)
    )
    await runtime.initialize()
    const bodyUv = value.geometry.getAttribute('uv') as THREE.BufferAttribute
    expect(value.geometry.getAttribute('uv1')).toBeUndefined()
    const overlay = value.root.getObjectByName(
      'skin-artwork-left-nipple-overlay-v8'
    ) as THREE.Mesh<THREE.BufferGeometry>
    const uv0 = overlay.geometry.getAttribute('uv') as THREE.BufferAttribute
    const uv1 = overlay.geometry.getAttribute('uv1') as THREE.BufferAttribute
    const overlayPosition = overlay.geometry.getAttribute(
      'position'
    ) as THREE.BufferAttribute
    const position = value.geometry.getAttribute('position') as THREE.BufferAttribute

    const centerVertex = Array.from({ length: uv0.count }, (_, vertex) => vertex).find(
      (vertex) =>
        Math.abs(uv0.getX(vertex) - CENTERS.left[0]) < 1e-6 &&
        Math.abs(uv0.getY(vertex) - CENTERS.left[1]) < 1e-6
    )!
    const eastVertex = Array.from({ length: uv0.count }, (_, vertex) => vertex).find(
      (vertex) =>
        Math.abs(uv0.getX(vertex) - (CENTERS.left[0] + 0.02)) < 1e-6 &&
        Math.abs(uv0.getY(vertex) - CENTERS.left[1]) < 1e-6
    )!
    const northVertex = Array.from({ length: uv0.count }, (_, vertex) => vertex).find(
      (vertex) =>
        Math.abs(uv0.getX(vertex) - CENTERS.left[0]) < 1e-6 &&
        Math.abs(uv0.getY(vertex) - (CENTERS.left[1] + 0.02)) < 1e-6
    )!
    expect(overlayPosition.getX(centerVertex)).toBeCloseTo(0, 7)
    expect(overlayPosition.getY(centerVertex)).toBeCloseTo(0, 7)
    expect(overlayPosition.getZ(centerVertex)).toBeCloseTo(0, 7)
    expect(overlayPosition.getX(eastVertex)).toBeCloseTo(0.04, 7)
    expect(overlayPosition.getY(northVertex)).toBeCloseTo(0.02, 7)
    const eastPhysical = Math.hypot(
      overlayPosition.getX(eastVertex) - overlayPosition.getX(centerVertex),
      overlayPosition.getY(eastVertex) - overlayPosition.getY(centerVertex)
    )
    const northPhysical = Math.hypot(
      overlayPosition.getX(northVertex) - overlayPosition.getX(centerVertex),
      overlayPosition.getY(northVertex) - overlayPosition.getY(centerVertex)
    )
    expect(Math.abs(uv1.getX(eastVertex) - 0.5)).toBeCloseTo(
      (eastPhysical / 0.01) * 0.4,
      5
    )
    expect(Math.abs(uv1.getY(northVertex) - 0.5)).toBeCloseTo(
      (northPhysical / 0.01) * 0.4,
      5
    )

    const neutralEastUvDistance = Math.abs(uv1.getX(eastVertex) - 0.5)
    runtime.syncSurfaceGeometry(-1)
    expect(Math.abs(uv1.getX(eastVertex) - 0.5)).toBeCloseTo(
      neutralEastUvDistance,
      6
    )
    runtime.syncSurfaceGeometry(1)
    expect(Math.abs(uv1.getX(eastVertex) - 0.5)).toBeCloseTo(
      neutralEastUvDistance / 2,
      6
    )
    runtime.syncSurfaceGeometry(0)

    // A second final geometry state represents another chest/body shape while
    // Nipple Size remains neutral. Geometry scaling and the explicit positive
    // Nipple Size response stay independent.
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      position.setXYZ(
        vertex,
        position.getX(vertex) * 0.5,
        position.getY(vertex) * 1.75,
        position.getZ(vertex)
      )
    }
    runtime.syncSurfaceGeometry()
    expect(Math.abs(uv1.getX(eastVertex) - 0.5)).toBeCloseTo(
      ((eastPhysical * 0.5) / (0.01 * Math.sqrt(0.5 * 1.75))) * 0.4,
      5
    )
    expect(Math.abs(uv1.getY(northVertex) - 0.5)).toBeCloseTo(
      ((northPhysical * 1.75) / (0.01 * Math.sqrt(0.5 * 1.75))) * 0.4,
      5
    )
    expect(value.geometry.getAttribute('uv')).toBe(bodyUv)
    expect(value.geometry.getAttribute('uv1')).toBeUndefined()
    runtime.dispose()
    expect(
      value.root.getObjectByName('skin-artwork-left-nipple-overlay-v8')
    ).toBeUndefined()
  })

  it('transports the exact boundary center through a stable frame while the nipple tip moves', async () => {
    const value = await fixture()
    const uv = value.geometry.getAttribute('uv') as THREE.BufferAttribute
    const index = value.geometry.getIndex()!
    const position = value.geometry.getAttribute('position') as THREE.BufferAttribute
    const circle = value.definition.circles[0]
    const selectedCenter: [number, number] = [
      CENTERS.left[0] + 0.02,
      CENTERS.left[1] + 0.02
    ]
    const boundaryOffsets: Array<[number, number]> = [
      [-0.02, 0],
      [-0.02, -0.02],
      [0, -0.02],
      [0.02, -0.02],
      [0.02, 0],
      [0.02, 0.02],
      [0, 0.02],
      [-0.02, 0.02]
    ]
    circle.surfaceCenterUv = selectedCenter
    circle.neutralCenterFrameRatios = [0.5, 0.5, 0]
    circle.anchors.ownershipSeed = locate(selectedCenter, uv, index)
    circle.anchors.outerBoundary = boundaryOffsets.map(([du, dv]) =>
      locate([selectedCenter[0] + du, selectedCenter[1] + dv], uv, index)
    )
    value.definition.definitionSha256 = '0'.repeat(64)
    value.definition.definitionSha256 = await canonicalRecipeSha256(value.definition)

    const runtime = new SkinArtworkProjectionRuntime(value.root, value.definition)
    await runtime.initialize()
    const overlay = value.root.getObjectByName(
      'skin-artwork-left-nipple-overlay-v8'
    ) as THREE.Mesh<THREE.BufferGeometry>
    const overlayUv0 = overlay.geometry.getAttribute('uv') as THREE.BufferAttribute
    const overlayUv1 = overlay.geometry.getAttribute('uv1') as THREE.BufferAttribute
    const selectedVertex = Array.from(
      { length: overlayUv0.count },
      (_, vertex) => vertex
    ).find(
      (vertex) =>
        Math.abs(overlayUv0.getX(vertex) - selectedCenter[0]) < 1e-6 &&
        Math.abs(overlayUv0.getY(vertex) - selectedCenter[1]) < 1e-6
    )!
    expect(overlayUv1.getX(selectedVertex)).toBeCloseTo(0.5, 5)
    expect(overlayUv1.getY(selectedVertex)).toBeCloseTo(0.5, 5)

    for (let vertex = 0; vertex < uv.count; vertex += 1) {
      if (
        Math.hypot(
          uv.getX(vertex) - selectedCenter[0],
          uv.getY(vertex) - selectedCenter[1]
        ) > 0.01
      ) {
        continue
      }
      position.setXYZ(
        vertex,
        position.getX(vertex),
        position.getY(vertex),
        position.getZ(vertex) + 0.05
      )
    }
    runtime.syncSurfaceGeometry()
    expect(overlayUv1.getX(selectedVertex)).toBeCloseTo(0.5, 5)
    expect(overlayUv1.getY(selectedVertex)).toBeCloseTo(0.5, 5)
    runtime.dispose()
  })

  it('caps the positive artwork response before extreme body geometry can exceed the surface', async () => {
    const value = await fixture()
    value.definition.radiusResponse.maximumOuterRadiusMeters = 0.015
    value.definition.definitionSha256 = '0'.repeat(64)
    value.definition.definitionSha256 = await canonicalRecipeSha256(
      value.definition
    )
    const runtime = new SkinArtworkProjectionRuntime(value.root, value.definition)
    await runtime.initialize()
    const overlay = value.root.getObjectByName(
      'skin-artwork-left-nipple-overlay-v8'
    ) as THREE.Mesh<THREE.BufferGeometry>
    const uv0 = overlay.geometry.getAttribute('uv') as THREE.BufferAttribute
    const uv1 = overlay.geometry.getAttribute('uv1') as THREE.BufferAttribute
    const eastVertex = Array.from({ length: uv0.count }, (_, vertex) => vertex).find(
      (vertex) =>
        Math.abs(uv0.getX(vertex) - (CENTERS.left[0] + 0.02)) < 1e-6 &&
        Math.abs(uv0.getY(vertex) - CENTERS.left[1]) < 1e-6
    )!
    const neutralDistance = Math.abs(uv1.getX(eastVertex) - 0.5)
    runtime.syncSurfaceGeometry(1)
    expect(Math.abs(uv1.getX(eastVertex) - 0.5)).toBeCloseTo(
      neutralDistance * (0.01 / 0.015),
      6
    )
    runtime.dispose()
  })

  it('anchors the areola to the stable frame while the central nipple tip moves', async () => {
    const value = await fixture()
    const runtime = new SkinArtworkProjectionRuntime(value.root, value.definition)
    await runtime.initialize()
    const bodyUv = value.geometry.getAttribute('uv') as THREE.BufferAttribute
    const position = value.geometry.getAttribute('position') as THREE.BufferAttribute
    const overlay = value.root.getObjectByName(
      'skin-artwork-left-nipple-overlay-v8'
    ) as THREE.Mesh<THREE.BufferGeometry>
    const overlayUv0 = overlay.geometry.getAttribute('uv') as THREE.BufferAttribute
    const overlayUv1 = overlay.geometry.getAttribute('uv1') as THREE.BufferAttribute
    const baseSamples = Array.from(
      { length: overlayUv0.count },
      (_, vertex) => vertex
    ).filter((vertex) => {
      const du = overlayUv0.getX(vertex) - CENTERS.left[0]
      const dv = overlayUv0.getY(vertex) - CENTERS.left[1]
      const radius = Math.hypot(du, dv)
      const gridAligned = [du, dv].every(
        (value) => Math.abs(value / 0.02 - Math.round(value / 0.02)) < 1e-5
      )
      return gridAligned && radius >= 0.02 && radius <= 0.045
    })
    const before = baseSamples.map((vertex) => [
      overlayUv1.getX(vertex),
      overlayUv1.getY(vertex)
    ])

    for (let vertex = 0; vertex < bodyUv.count; vertex += 1) {
      if (
        Math.hypot(
          bodyUv.getX(vertex) - CENTERS.left[0],
          bodyUv.getY(vertex) - CENTERS.left[1]
        ) > 0.01
      ) {
        continue
      }
      position.setXYZ(
        vertex,
        position.getX(vertex) + 0.03,
        position.getY(vertex),
        position.getZ(vertex) + 0.05
      )
    }
    runtime.syncSurfaceGeometry()

    expect(baseSamples).not.toHaveLength(0)
    baseSamples.forEach((vertex, index) => {
      expect(overlayUv1.getX(vertex)).toBeCloseTo(before[index]![0], 6)
      expect(overlayUv1.getY(vertex)).toBeCloseTo(before[index]![1], 6)
    })
    runtime.dispose()
  })

  it('clamps the one-circle overlay even when the body atlas repeats', async () => {
    const value = await fixture()
    const runtime = new SkinArtworkProjectionRuntime(value.root, value.definition)
    await runtime.initialize()
    const bodyMap = new THREE.Texture()
    bodyMap.wrapS = THREE.RepeatWrapping
    bodyMap.wrapT = THREE.RepeatWrapping
    const bodyMaterial = new THREE.MeshStandardMaterial({ map: bodyMap })
    const bodyCanvas = artworkCanvas(64, 64)
    const originalCreateElement = document.createElement.bind(document)
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockImplementation(((tagName: string) =>
        tagName === 'canvas'
          ? artworkCanvas(0, 0)
          : originalCreateElement(tagName)) as typeof document.createElement)

    try {
      const prepared = runtime.prepareArtwork(
        bodyCanvas,
        bodyMaterial,
        artworkCanvas(64, 64)
      )
      for (const overlay of prepared.overlays) {
        expect(overlay.texture.wrapS).toBe(THREE.ClampToEdgeWrapping)
        expect(overlay.texture.wrapT).toBe(THREE.ClampToEdgeWrapping)
        expect(overlay.texture.channel).toBe(1)
        expect(overlay.material.depthWrite).toBe(false)
      }
      expect(bodyMap.wrapS).toBe(THREE.RepeatWrapping)
      expect(bodyMap.wrapT).toBe(THREE.RepeatWrapping)
      runtime.disposePrepared(prepared)
    } finally {
      createElement.mockRestore()
      runtime.dispose()
      bodyMaterial.dispose()
      bodyMap.dispose()
    }
  })

  it('emits no overlay for an empty isolated pigment layer even when the mask is opaque', async () => {
    const value = await fixture()
    const runtime = new SkinArtworkProjectionRuntime(value.root, value.definition)
    await runtime.initialize()
    const bodyMap = new THREE.Texture()
    const bodyMaterial = new THREE.MeshStandardMaterial({ map: bodyMap })
    const pigmentCanvas = artworkCanvas(64, 64)
    const opaqueMask = artworkCanvas(64, 64, [255, 255, 255, 255])
    const originalCreateElement = document.createElement.bind(document)
    let createdCanvas = 0
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockImplementation(((tagName: string) => {
        if (tagName !== 'canvas') return originalCreateElement(tagName)
        const isPigmentOverlay = createdCanvas % 2 === 0
        createdCanvas += 1
        return artworkCanvas(
          0,
          0,
          isPigmentOverlay ? [0, 0, 0, 0] : [255, 255, 255, 255]
        )
      }) as typeof document.createElement)

    try {
      const prepared = runtime.prepareArtwork(
        pigmentCanvas,
        bodyMaterial,
        opaqueMask
      )
      for (const overlay of prepared.overlays) {
        const overlayContext = (overlay.texture.image as HTMLCanvasElement).getContext(
          '2d'
        )!
        const written = vi.mocked(overlayContext.putImageData).mock.calls[0]![0]
        for (let offset = 3; offset < written.data.length; offset += 4) {
          expect(written.data[offset]).toBe(0)
        }
      }
      expect(pigmentCanvas.getContext('2d')!.putImageData).not.toHaveBeenCalled()
      runtime.disposePrepared(prepared)
    } finally {
      createElement.mockRestore()
      runtime.dispose()
      bodyMaterial.dispose()
      bodyMap.dispose()
    }
  })

  it('keeps only the nipple-center-connected surface hit when projection overlaps disconnected triangles', async () => {
    const value = await fixture()
    const runtime = new SkinArtworkProjectionRuntime(value.root, value.definition)
    await runtime.initialize()

    const overlay = value.root.getObjectByName(
      'skin-artwork-left-nipple-overlay-v8'
    ) as THREE.Mesh<THREE.BufferGeometry>
    const uv0 = overlay.geometry.getAttribute('uv') as THREE.BufferAttribute
    const uv1 = overlay.geometry.getAttribute('uv1') as THREE.BufferAttribute
    const disconnectedVertices = Array.from(
      { length: uv0.count },
      (_, vertex) => vertex
    ).filter((vertex) => {
      const du = uv0.getX(vertex) - CENTERS.left[0]
      const dv = uv0.getY(vertex) - CENTERS.left[1]
      return [
        [0.025, 0.025],
        [0.035, 0.025],
        [0.03, 0.035]
      ].some(
        ([expectedU, expectedV]) =>
          Math.abs(du - expectedU) < 1e-6 && Math.abs(dv - expectedV) < 1e-6
      )
    })
    expect(disconnectedVertices).toHaveLength(3)
    for (const vertex of disconnectedVertices) {
      expect([uv1.getX(vertex), uv1.getY(vertex)]).toEqual([0, 0])
    }
    expect(runtime.projectionDiagnostics()).toEqual([
      expect.objectContaining({
        side: 'left',
        candidateComponentCount: 2,
        visibleComponentCount: 1,
        rejectedTriangleCount: 1
      }),
      expect.objectContaining({
        side: 'right',
        candidateComponentCount: 2,
        visibleComponentCount: 1,
        rejectedTriangleCount: 1
      })
    ])
    runtime.dispose()
  })

  it('fails closed on topology drift and never replaces a pre-existing body uv1', async () => {
    const value = await fixture()
    const prior = new THREE.Float32BufferAttribute(
      new Float32Array(value.definition.runtimeBinding.vertexCount * 2).fill(0.25),
      2
    )
    value.geometry.setAttribute('uv1', prior)
    const runtime = new SkinArtworkProjectionRuntime(value.root, value.definition)
    await runtime.initialize()
    expect(value.geometry.getAttribute('uv1')).toBe(prior)
    runtime.dispose()
    expect(value.geometry.getAttribute('uv1')).toBe(prior)

    const drifted = structuredClone(value.definition)
    drifted.runtimeBinding.uvSha256 = 'b'.repeat(64)
    drifted.definitionSha256 = '0'.repeat(64)
    drifted.definitionSha256 = await canonicalRecipeSha256(drifted)
    const rejected = new SkinArtworkProjectionRuntime(value.root, drifted)
    await expect(rejected.initialize()).rejects.toThrow(/topology or UV identity/)
  })
})
