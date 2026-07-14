import type { GoonSceneRoomShellTransform } from '$lib/types/goons'

export type NormalizedRoomShellTransform = {
  position: [number, number, number]
  rotationY: number
  uniformScale: number
}

export const DEFAULT_ROOM_SHELL_TRANSFORM: NormalizedRoomShellTransform = {
  position: [0, 0, 0],
  rotationY: 0,
  uniformScale: 1
}

export const MIN_ROOM_SHELL_SCALE = 0.05
export const MAX_ROOM_SHELL_SCALE = 20
export const MAX_ROOM_SHELL_OFFSET = 1000

function normalizeFinite(value: unknown, fallback: number) {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function normalizeOffset(value: unknown) {
  return Math.min(
    MAX_ROOM_SHELL_OFFSET,
    Math.max(-MAX_ROOM_SHELL_OFFSET, normalizeFinite(value, 0))
  )
}

function normalizeRotation(value: unknown) {
  const radians = normalizeFinite(value, 0)
  const fullTurn = Math.PI * 2
  return ((radians + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI
}

export function normalizeRoomShellTransform(
  value?: GoonSceneRoomShellTransform | null
): NormalizedRoomShellTransform {
  const position = Array.isArray(value?.position) ? value.position : [0, 0, 0]
  return {
    position: [
      normalizeOffset(position[0]),
      normalizeOffset(position[1]),
      normalizeOffset(position[2])
    ],
    rotationY: normalizeRotation(value?.rotationY),
    uniformScale: Math.min(
      MAX_ROOM_SHELL_SCALE,
      Math.max(MIN_ROOM_SHELL_SCALE, normalizeFinite(value?.uniformScale, 1))
    )
  }
}

export function isIdentityRoomShellTransform(value?: GoonSceneRoomShellTransform | null) {
  const normalized = normalizeRoomShellTransform(value)
  return (
    normalized.position.every((entry) => entry === 0) &&
    normalized.rotationY === 0 &&
    normalized.uniformScale === 1
  )
}
