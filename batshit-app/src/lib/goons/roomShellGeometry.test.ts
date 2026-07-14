import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import {
  RoomShellGeometryBuilder,
  normalizeGoonRoomShellBuilder,
  type RoomShellTextureSet
} from '$lib/goons/roomShellGeometry'

function emptyTextureSet(): RoomShellTextureSet {
  return {
    textures: [],
    floorTexture: null,
    ceilingTexture: null,
    northTexture: null,
    southTexture: null,
    eastTexture: null,
    westTexture: null,
    northTrimTexture: null,
    southTrimTexture: null,
    eastTrimTexture: null,
    westTrimTexture: null,
    floorExteriorTexture: null,
    ceilingExteriorTexture: null,
    northExteriorTexture: null,
    southExteriorTexture: null,
    eastExteriorTexture: null,
    westExteriorTexture: null,
    northApronTexture: null,
    southApronTexture: null,
    eastApronTexture: null,
    westApronTexture: null,
    terrainSkirtTexture: null
  }
}

function createTexture() {
  const data = new Uint8Array([255, 255, 255, 255])
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat)
  texture.needsUpdate = true
  return texture
}

describe('roomShellGeometry', () => {
  it('normalizes legacy room-builder layouts with the engine runtime rules', () => {
    const builder = normalizeGoonRoomShellBuilder({
      width: 4,
      depth: 5,
      height: 3,
      floorOffsetY: 1.25,
      layout: 'floor_2_walls_ceiling',
      wallTexture: { url: '/wall.png', filename: 'wall.png' },
      surfaces: {
        walls: {
          west: {
            interior: {
              tileScale: [-1, 2],
              transparency: 'glass'
            }
          }
        }
      }
    } as any)

    expect(builder.width).toBe(4)
    expect(builder.depth).toBe(5)
    expect(builder.height).toBe(3)
    expect(builder.floorOffsetY).toBe(1.25)
    expect(builder.surfaces.ceiling.enabled).toBe(true)
    expect(builder.surfaces.walls.north.enabled).toBe(true)
    expect(builder.surfaces.walls.east.enabled).toBe(true)
    expect(builder.surfaces.walls.south.enabled).toBe(false)
    expect(builder.surfaces.walls.west.enabled).toBe(false)
    expect(builder.surfaces.walls.north.interior.texture?.url).toBe('/wall.png')
    expect(builder.surfaces.walls.west.interior.tileScale).toEqual([1, 2])
    expect(builder.surfaces.walls.west.interior.opacity).toBe(0.4)
  })

  it('builds enabled interior room planes without rendering opaque exterior shells', () => {
    const builder = normalizeGoonRoomShellBuilder({
      width: 4,
      depth: 6,
      height: 3,
      surfaces: {
        ceiling: { enabled: false },
        walls: {
          south: { enabled: false }
        }
      }
    })
    const group = new RoomShellGeometryBuilder().buildRoomShellGeometry(
      builder,
      emptyTextureSet()
    )

    expect(group.children).toHaveLength(4)
    expect(group.children.every((child) => child instanceof THREE.Mesh)).toBe(true)
  })

  it('applies tile texture settings while building geometry', () => {
    const floorTexture = createTexture()
    const builder = normalizeGoonRoomShellBuilder({
      surfaces: {
        floor: {
          interior: {
            texture: { url: '/floor.png', filename: 'floor.png' },
            fit: 'tile',
            tileScale: [2, 3]
          }
        }
      }
    })
    const group = new RoomShellGeometryBuilder().buildRoomShellGeometry(builder, {
      ...emptyTextureSet(),
      floorTexture
    })

    expect(group.children.length).toBeGreaterThan(0)
    expect(floorTexture.wrapS).toBe(THREE.RepeatWrapping)
    expect(floorTexture.wrapT).toBe(THREE.RepeatWrapping)
    expect(floorTexture.repeat.x).toBe(2)
    expect(floorTexture.repeat.y).toBe(3)
  })

  it('builds real exterior apron planes only for enabled directions', () => {
    const apronTexture = createTexture()
    const builder = normalizeGoonRoomShellBuilder({
      width: 4,
      depth: 6,
      surfaces: {
        ceiling: { enabled: false },
        walls: {
          north: { enabled: false },
          south: { enabled: false },
          east: { enabled: false },
          west: { enabled: false }
        }
      },
      exteriorAprons: {
        south: {
          enabled: true,
          depth: 3,
          surface: {
            texture: { url: '/patio.png', filename: 'patio.png' },
            tileScale: [2, 1]
          }
        }
      }
    })
    const group = new RoomShellGeometryBuilder().buildRoomShellGeometry(builder, {
      ...emptyTextureSet(),
      southApronTexture: apronTexture
    })

    expect(group.children).toHaveLength(2)
    const apron = group.children[1] as THREE.Mesh
    expect(apron.position.z).toBeCloseTo(4.5)
    expect(apronTexture.repeat.x).toBe(2)
    expect(apronTexture.repeat.y).toBe(1)
  })

  it('builds a faded sloped circular terrain skirt when enabled', () => {
    const terrainTexture = createTexture()
    const builder = normalizeGoonRoomShellBuilder({
      width: 4,
      depth: 6,
      surfaces: {
        ceiling: { enabled: false },
        walls: {
          north: { enabled: false },
          south: { enabled: false },
          east: { enabled: false },
          west: { enabled: false }
        }
      },
      terrainSkirt: {
        enabled: true,
        radius: 42,
        edgeFade: 0.5,
        slopeAngleDeg: 45,
        segments: 64,
        surface: {
          texture: { url: '/grass.png', filename: 'grass.png' },
          tileScale: [12, 12]
        }
      }
    })
    const group = new RoomShellGeometryBuilder().buildRoomShellGeometry(builder, {
      ...emptyTextureSet(),
      terrainSkirtTexture: terrainTexture
    })

    expect(group.children).toHaveLength(2)
    const skirt = group.children[0] as THREE.Mesh
    expect(skirt.geometry).toBeInstanceOf(THREE.BufferGeometry)
    expect(skirt.position.y).toBeLessThan(0)
    const position = skirt.geometry.getAttribute('position') as THREE.BufferAttribute
    let minY = Infinity
    for (let index = 0; index < position.count; index += 1) {
      minY = Math.min(minY, position.getY(index))
    }
    expect(minY).toBeLessThan(-20)
    expect(terrainTexture.repeat.x).toBe(12)
    expect(terrainTexture.repeat.y).toBe(12)
    const material = skirt.material as THREE.MeshStandardMaterial
    expect(material.transparent).toBe(true)
    expect(material.alphaMap).toBeTruthy()
  })

  it('leaves skybox-ground terrain projection to the engine grounded-skybox path', () => {
    const skyboxTexture = createTexture()
    const builder = normalizeGoonRoomShellBuilder({
      width: 4,
      depth: 6,
      surfaces: {
        ceiling: { enabled: false },
        walls: {
          north: { enabled: false },
          south: { enabled: false },
          east: { enabled: false },
          west: { enabled: false }
        }
      },
      terrainSkirt: {
        enabled: true,
        radius: 42,
        edgeFade: 0.5,
        slopeAngleDeg: 25,
        projection: 'skybox-ground',
        segments: 64,
        surface: {
          texture: { url: '/skybox.png', filename: 'skybox.png' }
        }
      }
    })
    const group = new RoomShellGeometryBuilder().buildRoomShellGeometry(builder, {
      ...emptyTextureSet(),
      terrainSkirtTexture: skyboxTexture
    })

    expect(group.children).toHaveLength(1)
    expect(group.children[0]).toBeInstanceOf(THREE.Mesh)
    expect(skyboxTexture.repeat.x).toBe(1)
    expect(skyboxTexture.repeat.y).toBe(1)
  })
})
