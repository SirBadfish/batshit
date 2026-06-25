import { describe, expect, it, vi } from 'vitest'

import { normalizeRoomShellBuilder } from '$lib/goons/roomBuilder'
import { applyGoonSceneDefinition, buildGoonSceneSignature } from '$lib/goons/stageScene'
import type { GoonStageSceneHost } from '$lib/goons/stageScene'
import type { GoonSceneDefinition } from '$lib/types/goons'

function createHost(): GoonStageSceneHost {
  return {
    setPostureDefinitions: vi.fn(),
    setSkyboxBackground: vi.fn().mockResolvedValue(undefined),
    setRoomShell: vi.fn().mockResolvedValue(undefined),
    setRoomShellBuilder: vi.fn().mockResolvedValue(undefined),
    setSceneRootOffsetY: vi.fn(),
    setSceneProps: vi.fn().mockResolvedValue(undefined),
    setSceneMarkers: vi.fn()
  }
}

describe('stageScene', () => {
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
      }
    }

    await applyGoonSceneDefinition(host, scene)

    expect(host.setPostureDefinitions).toHaveBeenCalledWith({})
    expect(host.setSkyboxBackground).toHaveBeenCalledWith('/skybox.hdr')
    expect(host.setRoomShell).toHaveBeenCalledWith(null)
    expect(host.setRoomShellBuilder).toHaveBeenCalledWith(
      normalizeRoomShellBuilder(scene.roomShellBuilder)
    )
    expect(host.setSceneRootOffsetY).toHaveBeenCalledWith(1.25)
    expect(host.setSceneProps).toHaveBeenCalledWith(scene.props ?? [])
    expect(host.setSceneMarkers).toHaveBeenCalledWith(scene.markers ?? {})
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
    expect(host.setRoomShellBuilder).toHaveBeenCalledWith(null)
    expect(host.setSceneRootOffsetY).toHaveBeenCalledWith(0)
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
})
