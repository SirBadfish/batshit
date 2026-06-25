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
    westExteriorTexture: null
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
})
