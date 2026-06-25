import type { Object3D, Vector3 } from 'three'

import { normalizeRoomShellBuilder } from '$lib/goons/roomBuilder'
import type {
  GoonPosture,
  GoonPostureMap,
  GoonRoomShellBuilder,
  GoonSceneDefinition,
  GoonSceneMarkers,
  GoonSceneProp
} from '$lib/types/goons'

export type GoonStageAnchorId = 'hips' | 'head' | 'feet'

export type GoonStageSceneHost = {
  setPostureDefinitions(postures: GoonPostureMap): void
  setSkyboxBackground(url: string | null): Promise<void>
  setRoomShell(url: string | null): Promise<void>
  setRoomShellBuilder(builder: GoonRoomShellBuilder | null): Promise<void>
  setSceneRootOffsetY(offset: number): void
  setSceneProps(props: GoonSceneProp[]): Promise<void>
  setSceneMarkers(markers: GoonSceneMarkers): void
}

export type GoonStageAvatarHost = {
  getAvatarRootObject(): Object3D | null
  getStageAnchor(name: GoonStageAnchorId): Vector3 | null
  setStagePlacement(position: Vector3, rotationY?: number): void
  setStagePosture(posture: GoonPosture, preferredMarkerId?: string): void
}

export type GoonStageHost = GoonStageSceneHost & GoonStageAvatarHost

export function buildGoonSceneSignature(scene?: GoonSceneDefinition | null) {
  if (!scene) return 'none'
  const shouldUseBuilder = Boolean(scene.roomShellBuilder || !scene.roomShell?.url)
  const builder = shouldUseBuilder ? normalizeRoomShellBuilder(scene.roomShellBuilder) : null
  return JSON.stringify({
    id: scene.id,
    skybox: scene.skybox?.url ?? null,
    roomShellUrl: shouldUseBuilder ? null : scene.roomShell?.url ?? null,
    roomShellBuilder: builder,
    props: scene.props ?? [],
    markers: scene.markers ?? {}
  })
}

export async function applyGoonSceneDefinition(
  host: GoonStageSceneHost,
  scene?: GoonSceneDefinition | null,
  postureDefinitions: GoonPostureMap = {}
) {
  host.setPostureDefinitions(postureDefinitions)
  await host.setSkyboxBackground(scene?.skybox?.url ?? null)

  const shouldUseBuilder = Boolean(scene && (scene.roomShellBuilder || !scene.roomShell?.url))
  if (shouldUseBuilder) {
    const builder = normalizeRoomShellBuilder(scene?.roomShellBuilder)
    await host.setRoomShell(null)
    await host.setRoomShellBuilder(builder)
    host.setSceneRootOffsetY(builder.floorOffsetY ?? 0)
  } else {
    await host.setRoomShell(scene?.roomShell?.url ?? null)
    await host.setRoomShellBuilder(null)
    host.setSceneRootOffsetY(0)
  }

  await host.setSceneProps(scene?.props ?? [])
  host.setSceneMarkers(scene?.markers ?? {})
}
