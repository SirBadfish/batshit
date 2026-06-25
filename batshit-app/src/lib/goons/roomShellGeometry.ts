import * as THREE from 'three'

import { ROOM_DEFAULT_HEIGHT, ROOM_DEFAULT_SIZE } from '$lib/goons/roomBuilder'
import type {
  GoonFileRef,
  GoonRoomShellBuilder,
  GoonRoomSurface,
  GoonRoomSurfaceSide
} from '$lib/types/goons'

const ROOM_DEFAULT_DEPTH = ROOM_DEFAULT_SIZE
const ROOM_DEFAULT_WIDTH = ROOM_DEFAULT_SIZE
const CUTOUT_WALL_THICKNESS = 0.15
const CUTOUT_MASK_RESOLUTION = 4096
const CUTOUT_ALPHA_THRESHOLD = 0.1
const CUTOUT_MIN_AREA_RATIO = 0.0005

export type NormalizedRoomSurfaceSide = {
  texture?: GoonFileRef
  trimTexture?: GoonFileRef
  fit: 'tile' | 'stretch'
  tileScale: [number, number]
  transparency: 'opaque' | 'cutout' | 'glass'
  opacity: number
}

export type NormalizedRoomSurface = {
  enabled: boolean
  interior: NormalizedRoomSurfaceSide
  exterior: NormalizedRoomSurfaceSide
}

export type NormalizedRoomShellBuilder = {
  width: number
  depth: number
  height: number
  floorOffsetY: number
  surfaces: {
    floor: NormalizedRoomSurface
    ceiling: NormalizedRoomSurface
    walls: {
      north: NormalizedRoomSurface
      south: NormalizedRoomSurface
      east: NormalizedRoomSurface
      west: NormalizedRoomSurface
    }
  }
  exteriorTexture?: GoonFileRef
}

export type RoomShellTextureSet = {
  textures: THREE.Texture[]
  floorTexture: THREE.Texture | null
  ceilingTexture: THREE.Texture | null
  northTexture: THREE.Texture | null
  southTexture: THREE.Texture | null
  eastTexture: THREE.Texture | null
  westTexture: THREE.Texture | null
  northTrimTexture: THREE.Texture | null
  southTrimTexture: THREE.Texture | null
  eastTrimTexture: THREE.Texture | null
  westTrimTexture: THREE.Texture | null
  floorExteriorTexture: THREE.Texture | null
  ceilingExteriorTexture: THREE.Texture | null
  northExteriorTexture: THREE.Texture | null
  southExteriorTexture: THREE.Texture | null
  eastExteriorTexture: THREE.Texture | null
  westExteriorTexture: THREE.Texture | null
}

type CutoutGeometryCacheEntry = {
  extrude: THREE.ExtrudeGeometry
  cap: THREE.ShapeGeometry
}

function normalizeRoomSurfaceSide(
  side?: GoonRoomSurfaceSide | null,
  defaults: Partial<NormalizedRoomSurfaceSide> = {}
): NormalizedRoomSurfaceSide {
  const fit = side?.fit === 'stretch' ? 'stretch' : defaults.fit ?? 'tile'
  const tileScale = Array.isArray(side?.tileScale) ? side?.tileScale : defaults.tileScale
  const safeTileScale: [number, number] = [
    Number.isFinite(tileScale?.[0]) && (tileScale?.[0] ?? 0) > 0 ? tileScale![0] : 1,
    Number.isFinite(tileScale?.[1]) && (tileScale?.[1] ?? 0) > 0 ? tileScale![1] : 1
  ]
  const transparency =
    side?.transparency === 'cutout' || side?.transparency === 'glass'
      ? side.transparency
      : defaults.transparency ?? 'opaque'
  const opacity =
    typeof side?.opacity === 'number'
      ? side.opacity
      : defaults.opacity ?? (transparency === 'glass' ? 0.4 : 1)
  return {
    texture: side?.texture ?? defaults.texture,
    trimTexture: side?.trimTexture ?? defaults.trimTexture,
    fit,
    tileScale: safeTileScale,
    transparency,
    opacity
  }
}

function normalizeRoomSurface(
  surface?: GoonRoomSurface | null,
  defaults: {
    enabled?: boolean
    interior?: Partial<NormalizedRoomSurfaceSide>
    exterior?: Partial<NormalizedRoomSurfaceSide>
  } = {}
): NormalizedRoomSurface {
  const enabled = surface?.enabled ?? defaults.enabled ?? true
  const legacySide: Partial<GoonRoomSurfaceSide> = surface
    ? {
        texture: (surface as GoonRoomSurfaceSide).texture,
        trimTexture: (surface as GoonRoomSurfaceSide).trimTexture,
        fit: (surface as GoonRoomSurfaceSide).fit,
        tileScale: (surface as GoonRoomSurfaceSide).tileScale,
        transparency: (surface as GoonRoomSurfaceSide).transparency,
        opacity: (surface as GoonRoomSurfaceSide).opacity
      }
    : {}
  const interiorInput = { ...legacySide, ...(surface?.interior ?? {}) }
  const exteriorInput = { ...(surface?.exterior ?? {}) }
  return {
    enabled,
    interior: normalizeRoomSurfaceSide(interiorInput, defaults.interior),
    exterior: normalizeRoomSurfaceSide(exteriorInput, defaults.exterior)
  }
}

export function normalizeGoonRoomShellBuilder(
  builder: GoonRoomShellBuilder
): NormalizedRoomShellBuilder {
  const width =
    Number.isFinite(builder.width) && (builder.width ?? 0) > 0
      ? builder.width!
      : ROOM_DEFAULT_WIDTH
  const depth =
    Number.isFinite(builder.depth) && (builder.depth ?? 0) > 0
      ? builder.depth!
      : ROOM_DEFAULT_DEPTH
  const height =
    Number.isFinite(builder.height) && (builder.height ?? 0) > 0
      ? builder.height!
      : ROOM_DEFAULT_HEIGHT
  const floorOffsetY = Number.isFinite(builder.floorOffsetY) ? builder.floorOffsetY! : 0

  const legacy = builder as GoonRoomShellBuilder & {
    layout?: string
    floorTexture?: GoonFileRef
    wallTexture?: GoonFileRef
    ceilingTexture?: GoonFileRef
    exteriorTexture?: GoonFileRef
  }

  const layout = legacy.layout
  const usingLegacyLayout = Boolean(layout)
  const wallDefaults: Record<'north' | 'south' | 'east' | 'west', boolean> = {
    north: true,
    south: true,
    east: true,
    west: true
  }
  let ceilingEnabled = true

  if (usingLegacyLayout) {
    wallDefaults.north = false
    wallDefaults.south = false
    wallDefaults.east = false
    wallDefaults.west = false
    ceilingEnabled = false

    if (layout === 'floor_2_walls' || layout === 'floor_2_walls_ceiling') {
      wallDefaults.north = true
      wallDefaults.east = true
    } else if (layout === 'floor_3_walls' || layout === 'floor_3_walls_ceiling') {
      wallDefaults.north = true
      wallDefaults.east = true
      wallDefaults.west = true
    }
    if (layout === 'floor_2_walls_ceiling' || layout === 'floor_3_walls_ceiling') {
      ceilingEnabled = true
    }
  }

  const surfaces = builder.surfaces ?? {}
  const wallSurfaces = surfaces.walls ?? {}
  const fallbackExterior = legacy.exteriorTexture

  const floor = normalizeRoomSurface(surfaces.floor ?? null, {
    enabled: true,
    interior: { texture: legacy.floorTexture },
    exterior: { texture: fallbackExterior }
  })
  const ceiling = normalizeRoomSurface(surfaces.ceiling ?? null, {
    enabled: ceilingEnabled,
    interior: { texture: legacy.ceilingTexture },
    exterior: { texture: fallbackExterior }
  })
  const north = normalizeRoomSurface(wallSurfaces.north ?? null, {
    enabled: wallDefaults.north,
    interior: { texture: legacy.wallTexture },
    exterior: { texture: fallbackExterior }
  })
  const south = normalizeRoomSurface(wallSurfaces.south ?? null, {
    enabled: wallDefaults.south,
    interior: { texture: legacy.wallTexture },
    exterior: { texture: fallbackExterior }
  })
  const east = normalizeRoomSurface(wallSurfaces.east ?? null, {
    enabled: wallDefaults.east,
    interior: { texture: legacy.wallTexture },
    exterior: { texture: fallbackExterior }
  })
  const west = normalizeRoomSurface(wallSurfaces.west ?? null, {
    enabled: wallDefaults.west,
    interior: { texture: legacy.wallTexture },
    exterior: { texture: fallbackExterior }
  })

  return {
    width,
    depth,
    height,
    floorOffsetY,
    surfaces: {
      floor,
      ceiling,
      walls: { north, south, east, west }
    }
  }
}

export class RoomShellGeometryBuilder {
  private cutoutGeometryCache = new Map<string, CutoutGeometryCacheEntry>()

  clearCutoutGeometryCache() {
    for (const entry of this.cutoutGeometryCache.values()) {
      entry.extrude.dispose()
      entry.cap.dispose()
    }
    this.cutoutGeometryCache.clear()
  }

  buildRoomShellGeometry(
    builder: NormalizedRoomShellBuilder,
    textureSet: RoomShellTextureSet
  ) {
    const width = builder.width
    const depth = builder.depth
    const height = builder.height
    const { floor, ceiling, walls } = builder.surfaces

    const {
      floorTexture,
      ceilingTexture,
      northTexture,
      southTexture,
      eastTexture,
      westTexture,
      northTrimTexture,
      southTrimTexture,
      eastTrimTexture,
      westTrimTexture,
      floorExteriorTexture,
      ceilingExteriorTexture,
      northExteriorTexture,
      southExteriorTexture,
      eastExteriorTexture,
      westExteriorTexture
    } = textureSet

    const group = new THREE.Group()

    const buildMaterial = (
      side: NormalizedRoomSurfaceSide,
      texture: THREE.Texture | null,
      fallbackColor: number
    ) => {
      const useWhite = Boolean(texture)
      const material = new THREE.MeshStandardMaterial({
        color: useWhite ? 0xffffff : fallbackColor,
        map: texture ?? null,
        side: THREE.DoubleSide,
        transparent: side.transparency !== 'opaque',
        opacity: side.transparency === 'glass' ? side.opacity : 1,
        alphaTest: side.transparency === 'cutout' ? 0.1 : 0,
        depthWrite: side.transparency === 'glass' ? false : true,
        roughness: side.transparency === 'glass' ? 0.1 : 0.7,
        metalness: 0
      })
      return material
    }

    const buildPlane = (
      surface: NormalizedRoomSurface,
      side: NormalizedRoomSurfaceSide,
      texture: THREE.Texture | null,
      width: number,
      height: number,
      position: THREE.Vector3,
      rotation: THREE.Euler,
      fallbackColor: number
    ) => {
      if (!surface.enabled) return
      if (texture) {
        this.configureRoomTexture(texture, side)
      }
      const material = buildMaterial(side, texture, fallbackColor)
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material)
      plane.position.copy(position)
      plane.rotation.copy(rotation)
      group.add(plane)
      return plane
    }

    const buildCutoutThickness = (
      surface: NormalizedRoomSurface,
      side: NormalizedRoomSurfaceSide,
      texture: THREE.Texture | null,
      trimTexture: THREE.Texture | null,
      width: number,
      height: number,
      position: THREE.Vector3,
      rotation: THREE.Euler,
      inward: THREE.Vector3,
      fallbackColor: number
    ) => {
      if (!surface.enabled || side.transparency !== 'cutout' || !texture) return
      const geometry = this.getCutoutGeometry(texture, side, width, height)
      if (!geometry) return
      const trimSide: NormalizedRoomSurfaceSide = {
        ...side,
        transparency: 'opaque',
        opacity: 1
      }
      const capSide: NormalizedRoomSurfaceSide = {
        ...side,
        transparency: 'opaque',
        opacity: 1
      }
      const appliedTexture = trimTexture ?? texture
      if (appliedTexture) {
        this.configureRoomTexture(appliedTexture, trimSide)
      }
      const edgeMaterial = buildMaterial(trimSide, appliedTexture, fallbackColor)
      if (texture) {
        this.configureRoomTexture(texture, capSide)
      }
      const capMaterial = buildMaterial(capSide, texture, fallbackColor)
      capMaterial.side = THREE.FrontSide
      const hiddenMaterial = new THREE.MeshStandardMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0,
        depthWrite: false
      })
      const mesh = new THREE.Mesh(geometry.extrude, [hiddenMaterial, edgeMaterial])
      mesh.position.copy(position)
      mesh.rotation.copy(rotation)
      group.add(mesh)
      const capPosition = position.clone().add(inward.clone().multiplyScalar(CUTOUT_WALL_THICKNESS))
      const capFrontMesh = new THREE.Mesh(geometry.cap, capMaterial)
      capFrontMesh.position.copy(capPosition)
      capFrontMesh.rotation.copy(rotation)
      group.add(capFrontMesh)
    }

    const shouldRenderExterior = (side: NormalizedRoomSurfaceSide) =>
      Boolean(side.texture) || side.transparency !== 'opaque'

    const buildExteriorPlane = (
      surface: NormalizedRoomSurface,
      side: NormalizedRoomSurfaceSide,
      texture: THREE.Texture | null,
      width: number,
      height: number,
      position: THREE.Vector3,
      rotation: THREE.Euler,
      fallbackColor: number
    ) => {
      if (!surface.enabled || !shouldRenderExterior(side)) return
      if (texture) {
        this.configureRoomTexture(texture, side)
      }
      const material = buildMaterial(side, texture, fallbackColor)
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material)
      plane.position.copy(position)
      plane.rotation.copy(rotation)
      group.add(plane)
      return plane
    }

    buildPlane(
      floor,
      floor.interior,
      floorTexture,
      width,
      depth,
      new THREE.Vector3(0, 0, 0),
      new THREE.Euler(-Math.PI / 2, 0, 0),
      0x222222
    )

    if (ceiling.enabled) {
      buildPlane(
        ceiling,
        ceiling.interior,
        ceilingTexture,
        width,
        depth,
        new THREE.Vector3(0, height, 0),
        new THREE.Euler(Math.PI / 2, 0, 0),
        0x1f1f1f
      )
    }

    buildPlane(
      walls.north,
      walls.north.interior,
      northTexture,
      width,
      height,
      new THREE.Vector3(0, height / 2, -depth / 2),
      new THREE.Euler(0, 0, 0),
      0x2b2b2b
    )
    buildCutoutThickness(
      walls.north,
      walls.north.interior,
      northTexture,
      northTrimTexture,
      width,
      height,
      new THREE.Vector3(0, height / 2, -depth / 2),
      new THREE.Euler(0, 0, 0),
      new THREE.Vector3(0, 0, 1),
      0x2b2b2b
    )
    buildPlane(
      walls.south,
      walls.south.interior,
      southTexture,
      width,
      height,
      new THREE.Vector3(0, height / 2, depth / 2),
      new THREE.Euler(0, Math.PI, 0),
      0x2b2b2b
    )
    buildCutoutThickness(
      walls.south,
      walls.south.interior,
      southTexture,
      southTrimTexture,
      width,
      height,
      new THREE.Vector3(0, height / 2, depth / 2),
      new THREE.Euler(0, Math.PI, 0),
      new THREE.Vector3(0, 0, -1),
      0x2b2b2b
    )
    buildPlane(
      walls.east,
      walls.east.interior,
      eastTexture,
      depth,
      height,
      new THREE.Vector3(width / 2, height / 2, 0),
      new THREE.Euler(0, -Math.PI / 2, 0),
      0x2b2b2b
    )
    buildCutoutThickness(
      walls.east,
      walls.east.interior,
      eastTexture,
      eastTrimTexture,
      depth,
      height,
      new THREE.Vector3(width / 2, height / 2, 0),
      new THREE.Euler(0, -Math.PI / 2, 0),
      new THREE.Vector3(-1, 0, 0),
      0x2b2b2b
    )
    buildPlane(
      walls.west,
      walls.west.interior,
      westTexture,
      depth,
      height,
      new THREE.Vector3(-width / 2, height / 2, 0),
      new THREE.Euler(0, Math.PI / 2, 0),
      0x2b2b2b
    )
    buildCutoutThickness(
      walls.west,
      walls.west.interior,
      westTexture,
      westTrimTexture,
      depth,
      height,
      new THREE.Vector3(-width / 2, height / 2, 0),
      new THREE.Euler(0, Math.PI / 2, 0),
      new THREE.Vector3(1, 0, 0),
      0x2b2b2b
    )

    buildExteriorPlane(
      floor,
      floor.exterior,
      floorExteriorTexture,
      width,
      depth,
      new THREE.Vector3(0, -0.01, 0),
      new THREE.Euler(Math.PI / 2, 0, 0),
      0x141414
    )
    buildExteriorPlane(
      ceiling,
      ceiling.exterior,
      ceilingExteriorTexture,
      width,
      depth,
      new THREE.Vector3(0, height + 0.01, 0),
      new THREE.Euler(-Math.PI / 2, 0, 0),
      0x141414
    )
    buildExteriorPlane(
      walls.north,
      walls.north.exterior,
      northExteriorTexture,
      width,
      height,
      new THREE.Vector3(0, height / 2, -depth / 2 - 0.01),
      new THREE.Euler(0, Math.PI, 0),
      0x141414
    )
    buildExteriorPlane(
      walls.south,
      walls.south.exterior,
      southExteriorTexture,
      width,
      height,
      new THREE.Vector3(0, height / 2, depth / 2 + 0.01),
      new THREE.Euler(0, 0, 0),
      0x141414
    )
    buildExteriorPlane(
      walls.east,
      walls.east.exterior,
      eastExteriorTexture,
      depth,
      height,
      new THREE.Vector3(width / 2 + 0.01, height / 2, 0),
      new THREE.Euler(0, Math.PI / 2, 0),
      0x141414
    )
    buildExteriorPlane(
      walls.west,
      walls.west.exterior,
      westExteriorTexture,
      depth,
      height,
      new THREE.Vector3(-width / 2 - 0.01, height / 2, 0),
      new THREE.Euler(0, -Math.PI / 2, 0),
      0x141414
    )

    return group
  }

  private configureRoomTexture(texture: THREE.Texture, surface: NormalizedRoomSurfaceSide) {
    if (surface.fit === 'tile') {
      texture.wrapS = THREE.RepeatWrapping
      texture.wrapT = THREE.RepeatWrapping
      const scaleX = surface.tileScale?.[0] ?? 1
      const scaleY = surface.tileScale?.[1] ?? 1
      texture.repeat.set(scaleX, scaleY)
      texture.offset.set(0, 0)
    } else {
      texture.wrapS = THREE.ClampToEdgeWrapping
      texture.wrapT = THREE.ClampToEdgeWrapping
      texture.repeat.set(1, 1)
      texture.offset.set(0, 0)
    }
    texture.needsUpdate = true
  }

  private normalizeShapeUVs(geometry: THREE.BufferGeometry) {
    const position = geometry.getAttribute('position') as THREE.BufferAttribute | null
    if (!position) return
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i)
      const y = position.getY(i)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    const width = maxX - minX
    const height = maxY - minY
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    let uv = geometry.getAttribute('uv') as THREE.BufferAttribute | null
    if (!uv) {
      uv = new THREE.BufferAttribute(new Float32Array(position.count * 2), 2)
      geometry.setAttribute('uv', uv)
    }
    for (let i = 0; i < position.count; i += 1) {
      const u = (position.getX(i) - minX) / width
      const v = (position.getY(i) - minY) / height
      uv.setXY(i, u, v)
    }
    uv.needsUpdate = true
  }

  private getCutoutGeometry(
    texture: THREE.Texture,
    side: NormalizedRoomSurfaceSide,
    width: number,
    height: number
  ) {
    const tileScale = side.tileScale ?? [1, 1]
    if (typeof document === 'undefined') return null

    const image = texture.image as (CanvasImageSource & { width?: number; height?: number }) | undefined
    const imageWidth = Number(image?.width ?? 0)
    const imageHeight = Number(image?.height ?? 0)
    if (!image || !Number.isFinite(imageWidth) || !Number.isFinite(imageHeight)) {
      return null
    }
    if (imageWidth <= 1 || imageHeight <= 1) return null
    const maskResolution = Math.max(2, Math.round(Math.min(CUTOUT_MASK_RESOLUTION, Math.max(imageWidth, imageHeight))))
    const cacheKey = [
      texture.uuid,
      width.toFixed(3),
      height.toFixed(3),
      side.fit,
      tileScale[0].toFixed(2),
      tileScale[1].toFixed(2),
      texture.flipY ? '1' : '0',
      maskResolution
    ].join('|')
    const cached = this.cutoutGeometryCache.get(cacheKey)
    if (cached) return cached

    const canvas = document.createElement('canvas')
    canvas.width = imageWidth
    canvas.height = imageHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    try {
      ctx.drawImage(image as CanvasImageSource, 0, 0, imageWidth, imageHeight)
    } catch (error) {
      console.warn('[GoonEngine] Failed to sample cutout texture:', error)
      return null
    }
    const data = ctx.getImageData(0, 0, imageWidth, imageHeight).data
    const gridW = maskResolution
    const gridH = Math.max(2, Math.round(maskResolution * (height / width)))
    const mask = new Uint8Array(gridW * gridH)
    let hasHole = false

    for (let y = 0; y < gridH; y += 1) {
      const vBase = y / (gridH - 1)
      for (let x = 0; x < gridW; x += 1) {
        const uBase = x / (gridW - 1)
        let u = uBase
        let v = vBase
        if (side.fit === 'tile') {
          u = u * tileScale[0]
          v = v * tileScale[1]
          u = u - Math.floor(u)
          v = v - Math.floor(v)
        }
        if (texture.flipY) {
          v = 1 - v
        }
        const px = Math.min(imageWidth - 1, Math.max(0, Math.floor(u * (imageWidth - 1))))
        const py = Math.min(imageHeight - 1, Math.max(0, Math.floor(v * (imageHeight - 1))))
        const alpha = data[(py * imageWidth + px) * 4 + 3] / 255
        const isHole = alpha < CUTOUT_ALPHA_THRESHOLD
        if (isHole) hasHole = true
        mask[y * gridW + x] = isHole ? 1 : 0
      }
    }

    if (!hasHole) return null

    const segmentTable: Array<Array<[number, number]>> = [
      [],
      [[3, 0]],
      [[0, 1]],
      [[3, 1]],
      [[1, 2]],
      [
        [0, 1],
        [3, 2]
      ],
      [[0, 2]],
      [[3, 2]],
      [[2, 3]],
      [[0, 2]],
      [
        [0, 3],
        [1, 2]
      ],
      [[1, 2]],
      [[1, 3]],
      [[0, 1]],
      [[0, 3]],
      []
    ]

    type SegmentPoint = { x: number; y: number }
    type Segment = { a: SegmentPoint; b: SegmentPoint; aKey: string; bKey: string }
    const segments: Segment[] = []
    const pointToSegments = new Map<string, number[]>()
    const addSegment = (a: SegmentPoint, b: SegmentPoint) => {
      const aKey = `${a.x},${a.y}`
      const bKey = `${b.x},${b.y}`
      const index = segments.length
      segments.push({ a, b, aKey, bKey })
      const listA = pointToSegments.get(aKey) ?? []
      listA.push(index)
      pointToSegments.set(aKey, listA)
      const listB = pointToSegments.get(bKey) ?? []
      listB.push(index)
      pointToSegments.set(bKey, listB)
    }

    for (let y = 0; y < gridH - 1; y += 1) {
      for (let x = 0; x < gridW - 1; x += 1) {
        const tl = mask[y * gridW + x]
        const tr = mask[y * gridW + x + 1]
        const br = mask[(y + 1) * gridW + x + 1]
        const bl = mask[(y + 1) * gridW + x]
        const idx = (tl ? 1 : 0) + (tr ? 2 : 0) + (br ? 4 : 0) + (bl ? 8 : 0)
        const segmentsForCase = segmentTable[idx]
        if (!segmentsForCase.length) continue
        const midpoints: SegmentPoint[] = [
          { x: x + 0.5, y },
          { x: x + 1, y: y + 0.5 },
          { x: x + 0.5, y: y + 1 },
          { x, y: y + 0.5 }
        ]
        for (const [edgeA, edgeB] of segmentsForCase) {
          addSegment(midpoints[edgeA], midpoints[edgeB])
        }
      }
    }

    if (!segments.length) return null

    const used = new Set<number>()
    const loops: SegmentPoint[][] = []
    for (let i = 0; i < segments.length; i += 1) {
      if (used.has(i)) continue
      const loop: SegmentPoint[] = []
      let currentIndex = i
      let currentSegment = segments[currentIndex]
      used.add(currentIndex)
      loop.push(currentSegment.a, currentSegment.b)
      let currentKey = currentSegment.bKey
      const startKey = currentSegment.aKey
      let safety = segments.length * 4
      while (currentKey !== startKey && safety > 0) {
        safety -= 1
        const candidates = pointToSegments.get(currentKey) ?? []
        const nextIndex = candidates.find((index) => !used.has(index))
        if (nextIndex === undefined) break
        const nextSegment = segments[nextIndex]
        used.add(nextIndex)
        const nextKey = nextSegment.aKey === currentKey ? nextSegment.bKey : nextSegment.aKey
        const nextPoint = nextSegment.aKey === currentKey ? nextSegment.b : nextSegment.a
        loop.push(nextPoint)
        currentKey = nextKey
      }
      if (currentKey === startKey && loop.length >= 3) {
        loops.push(loop)
      }
    }

    if (!loops.length) return null

    const outerOutline = [
      new THREE.Vector2(-width / 2, -height / 2),
      new THREE.Vector2(width / 2, -height / 2),
      new THREE.Vector2(width / 2, height / 2),
      new THREE.Vector2(-width / 2, height / 2)
    ]
    if (!THREE.ShapeUtils.isClockWise(outerOutline)) {
      outerOutline.reverse()
    }
    const shape = new THREE.Shape(outerOutline)
    const edgeEps = 1 / Math.max(gridW, gridH)

    const simplifyLoop = (points: SegmentPoint[]) => {
      if (points.length <= 4) return points
      const simplified: SegmentPoint[] = []
      const count = points.length
      for (let idx = 0; idx < count; idx += 1) {
        const prev = points[(idx - 1 + count) % count]
        const curr = points[idx]
        const next = points[(idx + 1) % count]
        const dx1 = curr.x - prev.x
        const dy1 = curr.y - prev.y
        const dx2 = next.x - curr.x
        const dy2 = next.y - curr.y
        const cross = dx1 * dy2 - dy1 * dx2
        if (Math.abs(cross) > 1e-5) {
          simplified.push(curr)
        }
      }
      return simplified.length >= 3 ? simplified : points
    }

    for (const loop of loops) {
      const simplified = simplifyLoop(loop)
      let touchesEdge = false
      const holePoints: THREE.Vector2[] = simplified.map((point) => {
        const u = point.x / (gridW - 1)
        const v = point.y / (gridH - 1)
        if (u <= edgeEps || u >= 1 - edgeEps || v <= edgeEps || v >= 1 - edgeEps) {
          touchesEdge = true
        }
        const worldX = (u - 0.5) * width
        const worldY = (v - 0.5) * height
        return new THREE.Vector2(worldX, worldY)
      })
      if (touchesEdge) continue
      const area = Math.abs(THREE.ShapeUtils.area(holePoints))
      if (area / (width * height) < CUTOUT_MIN_AREA_RATIO) continue
      if (THREE.ShapeUtils.isClockWise(holePoints)) {
        holePoints.reverse()
      }
      shape.holes.push(new THREE.Path(holePoints))
    }

    if (shape.holes.length === 0) return null

    const extrude = new THREE.ExtrudeGeometry(shape, {
      depth: CUTOUT_WALL_THICKNESS,
      bevelEnabled: false,
      steps: 1
    })
    extrude.computeVertexNormals()
    const cap = new THREE.ShapeGeometry(shape)
    this.normalizeShapeUVs(cap)
    cap.computeVertexNormals()
    const entry = { extrude, cap }
    this.cutoutGeometryCache.set(cacheKey, entry)
    return entry
  }
}
