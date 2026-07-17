import type { Object3D, Vector3 } from 'three'

import {
  normalizeRoomShellBuilder,
  ROOM_DEFAULT_TERRAIN_SKIRT_RADIUS
} from '$lib/goons/roomBuilder'
import { normalizeGoonSceneAmbience } from '$lib/goons/sceneAmbience'
import { normalizeRoomShellTransform } from '$lib/goons/roomShellTransform'
import { normalizeRoomCameraBoundary } from '$lib/goons/roomCameraBoundary'
import { normalizeGroundProjectionLine } from '$lib/goons/sceneSkybox'
import type {
  GoonPosture,
  GoonPostureMap,
  GoonSceneAmbience,
  GoonScenePlacement,
  GoonSceneRoomShellTransform,
  GoonSceneCameraBoundary,
  GoonRoomShellBuilder,
  GoonSceneDefinition,
  GoonSceneMarkers,
  GoonSceneProp
} from '$lib/types/goons'

export type GoonStageAnchorId = 'hips' | 'head' | 'feet'

export type GoonStageSceneHost = {
  setPostureDefinitions(postures: GoonPostureMap): void
  setGroundProjectionLine(line: number): void
  setSkyboxBackground(url: string | null): Promise<void>
  setRoomShellTransform(transform: GoonSceneRoomShellTransform | null): void
  setRoomCameraBoundary(boundary: GoonSceneCameraBoundary | null): void
  setRoomShell(url: string | null): Promise<void>
  setRoomShellBuilder(builder: GoonRoomShellBuilder | null): Promise<void>
  setSceneRootOffsetY(offset: number): void
  setScenePlacement(placement: GoonScenePlacement, radius: number): void
  setSceneProps(props: GoonSceneProp[]): Promise<void>
  setSceneMarkers(markers: GoonSceneMarkers): void
  setSceneAmbience(ambience: GoonSceneAmbience | null): void
}

export type GoonStageAvatarHost = {
  getAvatarRootObject(): Object3D | null
  getStageAnchor(name: GoonStageAnchorId): Vector3 | null
  setStagePlacement(position: Vector3, rotationY?: number): void
  setStagePosture(posture: GoonPosture, preferredMarkerId?: string): void
}

export type GoonStageHost = GoonStageSceneHost & GoonStageAvatarHost

export function resolveGoonScenePlacement(
  scene?: GoonSceneDefinition | null
): GoonScenePlacement {
  if (scene?.scenePlacement === 'ground' || scene?.scenePlacement === 'elevated') {
    return scene.scenePlacement
  }

  const legacyTerrainSkirt = scene?.roomShellBuilder?.terrainSkirt
  return legacyTerrainSkirt?.enabled && legacyTerrainSkirt.projection === 'skybox-ground'
    ? 'ground'
    : 'elevated'
}

export function buildGoonSceneSignature(scene?: GoonSceneDefinition | null) {
  if (!scene) return 'none'
  const shouldUseBuilder = Boolean(scene.roomShellBuilder || !scene.roomShell?.url)
  const builder = shouldUseBuilder ? normalizeRoomShellBuilder(scene.roomShellBuilder) : null
  return JSON.stringify({
    id: scene.id,
    skybox: scene.skybox?.url ?? null,
    groundProjectionLine: normalizeGroundProjectionLine(scene.groundProjectionLine),
    roomShellUrl: shouldUseBuilder ? null : scene.roomShell?.url ?? null,
    roomShellTransform: shouldUseBuilder
      ? null
      : normalizeRoomShellTransform(scene.roomShellTransform),
    cameraBoundary: shouldUseBuilder
      ? null
      : normalizeRoomCameraBoundary(scene.cameraBoundary),
    roomShellBuilder: builder,
    scenePlacement: resolveGoonScenePlacement(scene),
    props: scene.props ?? [],
    markers: scene.markers ?? {},
    ambience: normalizeGoonSceneAmbience(scene.ambience)
  })
}

export async function applyGoonSceneDefinition(
  host: GoonStageSceneHost,
  scene?: GoonSceneDefinition | null,
  postureDefinitions: GoonPostureMap = {}
) {
  host.setPostureDefinitions(postureDefinitions)
  host.setGroundProjectionLine(normalizeGroundProjectionLine(scene?.groundProjectionLine))
  await host.setSkyboxBackground(scene?.skybox?.url ?? null)

  const shouldUseBuilder = Boolean(scene && (scene.roomShellBuilder || !scene.roomShell?.url))
  const builder = shouldUseBuilder ? normalizeRoomShellBuilder(scene?.roomShellBuilder) : null
  host.setRoomShellTransform(builder ? null : scene?.roomShellTransform ?? null)
  host.setRoomCameraBoundary(builder ? null : scene?.cameraBoundary ?? null)
  if (builder) {
    await host.setRoomShell(null)
    await host.setRoomShellBuilder(builder)
    host.setSceneRootOffsetY(builder.floorOffsetY ?? 0)
  } else {
    await host.setRoomShell(scene?.roomShell?.url ?? null)
    await host.setRoomShellBuilder(null)
    host.setSceneRootOffsetY(0)
  }

  host.setScenePlacement(
    resolveGoonScenePlacement(scene),
    builder?.terrainSkirt?.radius ?? ROOM_DEFAULT_TERRAIN_SKIRT_RADIUS
  )

  await host.setSceneProps(scene?.props ?? [])
  host.setSceneMarkers(scene?.markers ?? {})
  host.setSceneAmbience(scene ? normalizeGoonSceneAmbience(scene.ambience) : null)
}
