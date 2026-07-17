import { describe, expect, it, vi } from 'vitest'

import { normalizeRoomShellBuilder } from '$lib/goons/roomBuilder'
import { normalizeRoomShellTransform } from '$lib/goons/roomShellTransform'
import {
  applyGoonSceneDefinition,
  buildGoonSceneSignature,
  resolveGoonScenePlacement
} from '$lib/goons/stageScene'
import type { GoonStageSceneHost } from '$lib/goons/stageScene'
import type { GoonSceneDefinition } from '$lib/types/goons'

function createHost(): GoonStageSceneHost {
  return {
    setPostureDefinitions: vi.fn(),
    setGroundProjectionLine: vi.fn(),
    setSkyboxBackground: vi.fn().mockResolvedValue(undefined),
    setRoomShellTransform: vi.fn(),
    setRoomCameraBoundary: vi.fn(),
    setRoomShell: vi.fn().mockResolvedValue(undefined),
    setRoomShellBuilder: vi.fn().mockResolvedValue(undefined),
    setSceneRootOffsetY: vi.fn(),
    setScenePlacement: vi.fn(),
    setSceneProps: vi.fn().mockResolvedValue(undefined),
    setSceneMarkers: vi.fn(),
    setSceneAmbience: vi.fn()
  }
}

describe('stageScene', () => {
  it('resets projection and Room Shell placement for an empty scene', async () => {
    const host = createHost()

    await applyGoonSceneDefinition(host, null)

    expect(host.setGroundProjectionLine).toHaveBeenCalledWith(0.5)
    expect(host.setRoomShellTransform).toHaveBeenCalledWith(null)
    expect(host.setRoomCameraBoundary).toHaveBeenCalledWith(null)
    expect(host.setRoomShell).toHaveBeenCalledWith(null)
    expect(host.setScenePlacement).toHaveBeenCalledWith('elevated', 70)
  })

  it('applies builder-backed scenes consistently', async () => {
    const host = createHost()
    const scene: GoonSceneDefinition = {
      id: 'builder_scene',
      name: 'Builder Scene',
      skybox: { url: '/skybox.hdr', filename: 'skybox.hdr' },
      roomShellBuilder: {
        floorOffsetY: 1.25,
      },
      props: [
        {
          id: 'lamp',
          name: 'Lamp',
          fileRef: { url: '/props/lamp.glb', filename: 'lamp.glb' },
          position: [0, 0, 0]
        }
      ],
      markers: {
        sit: [{ id: 'chair', position: [1, 0, 2], rotation: [0, 1.57, 0] }]
      },
      ambience: {
        enabled: true,
        preset: 'embers',
        placement: 'inside',
        intensity: 0.65,
        speed: 0.8,
        wind: [0.1, -0.05]
      }
    }

    await applyGoonSceneDefinition(host, scene)

    expect(host.setPostureDefinitions).toHaveBeenCalledWith({})
    expect(host.setGroundProjectionLine).toHaveBeenCalledWith(0.5)
    expect(host.setSkyboxBackground).toHaveBeenCalledWith('/skybox.hdr')
    expect(host.setRoomShell).toHaveBeenCalledWith(null)
    expect(host.setRoomShellBuilder).toHaveBeenCalledWith(
      normalizeRoomShellBuilder(scene.roomShellBuilder)
    )
    expect(host.setSceneRootOffsetY).toHaveBeenCalledWith(1.25)
    expect(host.setScenePlacement).toHaveBeenCalledWith('elevated', 70)
    expect(host.setSceneProps).toHaveBeenCalledWith(scene.props ?? [])
    expect(host.setSceneMarkers).toHaveBeenCalledWith(scene.markers ?? {})
    expect(host.setSceneAmbience).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        preset: 'embers',
        placement: 'inside',
        intensity: 0.65,
        speed: 0.8,
        wind: [0.1, -0.05]
      })
    )
  })

  it('resolves legacy terrain-skirt grounding through the scene-level placement path', async () => {
    const host = createHost()
    const scene: GoonSceneDefinition = {
      id: 'projected_ground_scene',
      name: 'Projected Ground Scene',
      skybox: { url: '/skybox.png', filename: 'skybox.png' },
      roomShellBuilder: {
        terrainSkirt: {
          enabled: true,
          projection: 'skybox-ground',
          surface: {
            texture: { url: '/fallback-grass.png', filename: 'fallback-grass.png' }
          }
        }
      },
      props: [],
      markers: {}
    }

    await applyGoonSceneDefinition(host, scene)

    expect(host.setRoomShellBuilder).toHaveBeenCalledWith(
      expect.objectContaining({
        terrainSkirt: expect.objectContaining({
          projection: 'skybox-ground',
          surface: expect.objectContaining({
            texture: { url: '/fallback-grass.png', filename: 'fallback-grass.png' }
          })
        })
      })
    )
    expect(resolveGoonScenePlacement(scene)).toBe('ground')
    expect(host.setScenePlacement).toHaveBeenCalledWith('ground', 70)
  })

  it('uses the explicit room shell when present and resets builder state', async () => {
    const host = createHost()
    const scene: GoonSceneDefinition = {
      id: 'shell_scene',
      name: 'Shell Scene',
      roomShell: { url: '/rooms/lounge.glb', filename: 'lounge.glb' },
      props: [],
      markers: {}
    }

    await applyGoonSceneDefinition(host, scene)

    expect(host.setPostureDefinitions).toHaveBeenCalledWith({})
    expect(host.setRoomShell).toHaveBeenCalledWith('/rooms/lounge.glb')
    expect(host.setRoomShellTransform).toHaveBeenCalledWith(null)
    expect(host.setRoomShellBuilder).toHaveBeenCalledWith(null)
    expect(host.setSceneRootOffsetY).toHaveBeenCalledWith(0)
    expect(host.setScenePlacement).toHaveBeenCalledWith('elevated', 70)
    expect(host.setSceneAmbience).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        preset: 'dust',
        placement: 'whole_stage'
      })
    )
  })

  it('applies an explicit uploaded-room camera boundary and includes it in signatures', async () => {
    const host = createHost()
    const scene: GoonSceneDefinition = {
      id: 'bounded_shell',
      name: 'Bounded Shell',
      roomShell: { url: '/rooms/bounded.glb', filename: 'bounded.glb' },
      cameraBoundary: {
        center: [1, 2, 3],
        size: [8, 4, 6],
        rotationY: Math.PI / 4
      }
    }

    await applyGoonSceneDefinition(host, scene)

    expect(host.setRoomCameraBoundary).toHaveBeenCalledWith(scene.cameraBoundary)
    expect(buildGoonSceneSignature(scene)).not.toBe(
      buildGoonSceneSignature({ ...scene, cameraBoundary: undefined })
    )
  })

  it('keeps an uploaded room shell active when Ground Level is selected', async () => {
    const host = createHost()
    const scene: GoonSceneDefinition = {
      id: 'grounded_shell_scene',
      name: 'Grounded Shell Scene',
      skybox: { url: '/skybox.png', filename: 'skybox.png' },
      scenePlacement: 'ground',
      groundProjectionLine: 0.58,
      roomShell: { url: '/rooms/cabin.glb', filename: 'cabin.glb' },
      roomShellTransform: {
        position: [1, -0.35, 2],
        rotationY: Math.PI / 2,
        uniformScale: 1.4
      }
    }

    await applyGoonSceneDefinition(host, scene)

    expect(host.setRoomShell).toHaveBeenCalledWith('/rooms/cabin.glb')
    expect(host.setGroundProjectionLine).toHaveBeenCalledWith(0.58)
    expect(host.setRoomShellTransform).toHaveBeenCalledWith(scene.roomShellTransform)
    expect(host.setRoomShellBuilder).toHaveBeenCalledWith(null)
    expect(host.setScenePlacement).toHaveBeenCalledWith('ground', 70)
  })

  it('builds the same scene signature for equivalent builder-backed definitions', () => {
    const legacyBuilder = { layout: 'floor_2_walls' } as unknown as GoonSceneDefinition['roomShellBuilder']
    const fromLegacyLayout: GoonSceneDefinition = {
      id: 'shared_scene',
      name: 'Shared Scene',
      roomShellBuilder: legacyBuilder,
      props: [],
      markers: {}
    }
    const fromNormalizedBuilder: GoonSceneDefinition = {
      id: 'shared_scene',
      name: 'Shared Scene',
      roomShellBuilder: normalizeRoomShellBuilder(legacyBuilder),
      props: [],
      markers: {}
    }

    expect(buildGoonSceneSignature(fromLegacyLayout)).toBe(
      buildGoonSceneSignature(fromNormalizedBuilder)
    )
  })

  it('changes the scene signature when only saved ambience changes', () => {
    const scene: GoonSceneDefinition = {
      id: 'atmosphere_scene',
      name: 'Atmosphere Scene',
      roomShellBuilder: {},
      ambience: {
        enabled: true,
        preset: 'rain',
        placement: 'outside',
        intensity: 0.55,
        speed: 1,
        wind: [0.1, 0],
        seed: 42
      }
    }

    const before = buildGoonSceneSignature(scene)
    const after = buildGoonSceneSignature({
      ...scene,
      ambience: {
        ...scene.ambience,
        preset: 'embers',
        placement: 'inside'
      }
    })

    expect(after).not.toBe(before)
  })

  it('changes the scene signature when only scene placement changes', () => {
    const scene: GoonSceneDefinition = {
      id: 'placement_scene',
      name: 'Placement Scene',
      roomShell: { url: '/rooms/stage.glb', filename: 'stage.glb' },
      scenePlacement: 'elevated'
    }

    expect(
      buildGoonSceneSignature({
        ...scene,
        scenePlacement: 'ground'
      })
    ).not.toBe(buildGoonSceneSignature(scene))
  })

  it('changes the scene signature when only Ground Projection Line changes', () => {
    const scene: GoonSceneDefinition = {
      id: 'projection_line_scene',
      name: 'Projection Line Scene',
      skybox: { url: '/skybox.png', filename: 'skybox.png' },
      scenePlacement: 'ground'
    }

    expect(
      buildGoonSceneSignature({
        ...scene,
        groundProjectionLine: 0.6
      })
    ).not.toBe(buildGoonSceneSignature(scene))
  })

  it('normalizes absent and explicit default scene placement data to the same signature', () => {
    const scene: GoonSceneDefinition = {
      id: 'default_projection_scene',
      name: 'Default Projection Scene',
      roomShell: { url: '/rooms/stage.glb', filename: 'stage.glb' }
    }

    expect(
      buildGoonSceneSignature({
        ...scene,
        groundProjectionLine: 0.5,
        roomShellTransform: normalizeRoomShellTransform()
      })
    ).toBe(buildGoonSceneSignature(scene))
  })

  it('changes the scene signature for an active Uploaded GLB transform but ignores it in Builder mode', () => {
    const uploaded: GoonSceneDefinition = {
      id: 'shell_transform_scene',
      name: 'Shell Transform Scene',
      roomShell: { url: '/rooms/stage.glb', filename: 'stage.glb' }
    }
    const transformed = {
      ...uploaded,
      roomShellTransform: { uniformScale: 1.5, position: [0, -0.3, 0] as [number, number, number] }
    }

    expect(buildGoonSceneSignature(transformed)).not.toBe(buildGoonSceneSignature(uploaded))

    const builder = { ...uploaded, roomShellBuilder: {} }
    expect(buildGoonSceneSignature({ ...builder, roomShellTransform: transformed.roomShellTransform })).toBe(
      buildGoonSceneSignature(builder)
    )
  })

  it('prefers the explicit scene placement over the legacy builder signal', () => {
    const scene: GoonSceneDefinition = {
      id: 'explicit_placement_scene',
      name: 'Explicit Placement Scene',
      scenePlacement: 'elevated',
      roomShellBuilder: {
        terrainSkirt: {
          enabled: true,
          projection: 'skybox-ground'
        }
      }
    }

    expect(resolveGoonScenePlacement(scene)).toBe('elevated')
  })
})
