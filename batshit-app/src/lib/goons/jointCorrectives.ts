/**
 * Joint-driven correctives — first-party Goon rig corrective resolver
 * (SA-090 correctives engine, `avatar.json#rig.correctives`,
 * contract `joint-angle-corrective/v1`).
 *
 * Consumes the correctives block shipped by the dial-round exporter and turns
 * posed-skeleton joint angles into additive morph-influence deltas on top of
 * the user's dial-resolved values. v1 ships the seated-butt corrective
 * (Josh's locked spec, dial-review-notes §2a-0): a bilateral hip-flexion
 * driver feeding seven BALL-kit keys, anchors interpolated by the Butt Size
 * dial, the gap channel front-loaded by angle. The same driver contract
 * serves wrist/knee crease correctives later.
 *
 * Everything here is data-driven from the manifest — bone names, rest
 * rotations, flexion axes, anchor tables, and angle curves are all measured
 * or locked at export time. The driver math is the rig twist contract's
 * idiom: qRel = restRotation^-1 * bone.quaternion, twist-decomposed about the
 * MEASURED axis (never a hardcoded axis, never a literal pose read), per-bone
 * clamped BEFORE the bilateral combine.
 *
 * Pure module: no THREE imports so every branch is unit-testable. The engine
 * feeds quaternion components straight from posed bones each frame.
 */

import {
  evalBodyDialTrack,
  type BodyDialKeyMeta,
  type BodyDialTrackPoint,
  type BodyDialsManifest
} from './bodyDials'
import type { AppearanceDialsManifest } from './appearanceDials'

/** Quaternion components in glTF/three.js order. */
export type CorrectiveQuat = [number, number, number, number]
export type CorrectiveVec3 = [number, number, number]

export type JointCorrectiveDriverBone = {
  bone: string
  /** node-local rest rotation measured from the exported GLB */
  restRotation: CorrectiveQuat
  /** flexion axis in the bone's REST-LOCAL frame (unit vector) */
  axisRestLocal: CorrectiveVec3
}

export type JointCorrectiveDriver = {
  id: string
  kind: 'swing-angle'
  combine: 'mean'
  /** per-bone angle clamp in degrees, applied before combining */
  clampDeg: [number, number]
  bones: JointCorrectiveDriverBone[]
}

export type JointCorrectiveEntry = {
  driver: string
  /** morph key the corrective drives (must exist in the dials keys block) */
  key: string
  /** dial whose value interpolates the anchors (linear at any value) */
  anchorDial: string
  anchorAt0: number
  anchorAt1: number
  /** normalized angle curve: degrees -> [0..1] factor */
  angleCurve: BodyDialTrackPoint[]
  mode: 'additive'
}

export type JointCorrectivesSpec = {
  contract: string
  drivers: JointCorrectiveDriver[]
  entries: JointCorrectiveEntry[]
}

export const JOINT_CORRECTIVES_CONTRACT = 'joint-angle-corrective/v1'

type JointCorrectiveDialContext = BodyDialsManifest | AppearanceDialsManifest
type JointCorrectiveTargetBounds = Pick<BodyDialKeyMeta, 'influenceMin' | 'influenceMax'>

const RAD_TO_DEG = 180 / Math.PI

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isTrack(value: unknown): value is BodyDialTrackPoint[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every(
      (pt) => Array.isArray(pt) && pt.length === 2 && isFiniteNumber(pt[0]) && isFiniteNumber(pt[1])
    )
  )
}

function isQuat(value: unknown): value is CorrectiveQuat {
  return Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber)
}

function isUnitVec3(value: unknown): value is CorrectiveVec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteNumber)) return false
  const len = Math.hypot(value[0], value[1], value[2])
  return Math.abs(len - 1) < 0.01
}

/**
 * Parse + validate a manifest's `rig.correctives` block. Returns null when
 * the block is absent or holds no entries (the Block C-era placeholder ships
 * `entries: []`); throws on a present-but-malformed populated block so a
 * broken export fails loudly instead of silently skipping correctives.
 *
 * Correctives compose onto dial-resolved influences, so a populated block
 * requires the parsed body-dials manifest for key/dial cross-validation.
 */
export function parseJointCorrectives(
  manifest: unknown,
  dials: JointCorrectiveDialContext | null
): JointCorrectivesSpec | null {
  if (!isRecord(manifest)) return null
  const rig = manifest.rig
  if (!isRecord(rig)) return null
  const raw = rig.correctives
  if (raw === undefined || raw === null) return null
  if (!isRecord(raw)) {
    throw new Error('avatar.json#rig.correctives is not an object')
  }
  const rawEntries = raw.entries
  if (rawEntries === undefined || (Array.isArray(rawEntries) && rawEntries.length === 0)) {
    return null
  }
  if (raw.driverContract !== JOINT_CORRECTIVES_CONTRACT) {
    throw new Error(
      `avatar.json#rig.correctives contract ${String(raw.driverContract)} is not ${JOINT_CORRECTIVES_CONTRACT}`
    )
  }
  if (!Array.isArray(rawEntries)) {
    throw new Error('avatar.json#rig.correctives entries is not an array')
  }
  if (!dials) {
    throw new Error('avatar.json#rig.correctives requires the body dials block')
  }
  if (!Array.isArray(raw.drivers) || raw.drivers.length === 0) {
    throw new Error('avatar.json#rig.correctives has entries but no drivers')
  }

  const drivers: JointCorrectiveDriver[] = []
  const driverIds = new Set<string>()
  for (const entry of raw.drivers as unknown[]) {
    if (!isRecord(entry)) throw new Error('rig.correctives contains a non-object driver')
    const id = typeof entry.id === 'string' ? entry.id : ''
    const clamp = entry.clampDeg
    if (
      !id ||
      entry.kind !== 'swing-angle' ||
      entry.combine !== 'mean' ||
      !Array.isArray(clamp) ||
      clamp.length !== 2 ||
      !isFiniteNumber(clamp[0]) ||
      !isFiniteNumber(clamp[1]) ||
      clamp[0] >= clamp[1] ||
      !Array.isArray(entry.bones) ||
      entry.bones.length === 0
    ) {
      throw new Error(`rig.correctives driver ${id || '<unnamed>'} is malformed`)
    }
    for (const bone of entry.bones) {
      if (
        !isRecord(bone) ||
        typeof bone.bone !== 'string' ||
        !bone.bone ||
        !isQuat(bone.restRotation) ||
        !isUnitVec3(bone.axisRestLocal)
      ) {
        throw new Error(`rig.correctives driver ${id} has a malformed bone frame`)
      }
    }
    if (driverIds.has(id)) throw new Error(`rig.correctives duplicate driver id ${id}`)
    driverIds.add(id)
    drivers.push({
      id,
      kind: 'swing-angle',
      combine: 'mean',
      clampDeg: [clamp[0], clamp[1]],
      bones: entry.bones.map((bone) => ({
        bone: (bone as Record<string, unknown>).bone as string,
        restRotation: [...((bone as Record<string, unknown>).restRotation as CorrectiveQuat)],
        axisRestLocal: [...((bone as Record<string, unknown>).axisRestLocal as CorrectiveVec3)]
      }))
    })
  }

  const dialIds = new Set(dials.dials.map((dial) => dial.id))
  const targetBounds: Record<string, JointCorrectiveTargetBounds> =
    'keys' in dials ? dials.keys : dials.targets
  const entries: JointCorrectiveEntry[] = []
  for (const entry of rawEntries as unknown[]) {
    if (!isRecord(entry)) throw new Error('rig.correctives contains a non-object entry')
    const key =
      typeof entry.key === 'string'
        ? entry.key
        : typeof entry.target === 'string'
          ? entry.target
          : ''
    if (
      !key ||
      typeof entry.driver !== 'string' ||
      !driverIds.has(entry.driver) ||
      typeof entry.anchorDial !== 'string' ||
      !isFiniteNumber(entry.anchorAt0) ||
      !isFiniteNumber(entry.anchorAt1) ||
      !isTrack(entry.angleCurve) ||
      entry.mode !== 'additive'
    ) {
      throw new Error(`rig.correctives entry ${key || '<unnamed>'} is malformed`)
    }
    if (!isRecord(targetBounds[key])) {
      throw new Error(
        'keys' in dials
          ? `rig.correctives entry ${key} references a key missing from the dials keys block`
          : `rig.correctives entry ${key} references a target missing from appearance-dials/v2`
      )
    }
    if (!dialIds.has(entry.anchorDial)) {
      throw new Error(`rig.correctives entry ${key} references unknown anchor dial ${entry.anchorDial}`)
    }
    entries.push({
      driver: entry.driver,
      key,
      anchorDial: entry.anchorDial,
      anchorAt0: entry.anchorAt0,
      anchorAt1: entry.anchorAt1,
      angleCurve: entry.angleCurve.map((point) => [point[0], point[1]]),
      mode: 'additive'
    })
  }

  return { contract: JOINT_CORRECTIVES_CONTRACT, drivers, entries }
}

/**
 * Signed swing angle (degrees) of a bone's current local rotation about the
 * measured axis, relative to its rest rotation.
 *
 * qRel = restRotation^-1 * current (the delta rotation expressed in the
 * bone's rest-local frame — conjugation-consistent with the exporter's axis
 * frame), sign-normalized for the quaternion double cover, then
 * twist-decomposed about the axis: angle = 2 * atan2(dot(qRel.xyz, axis), qRel.w).
 */
export function swingAngleDeg(
  rest: CorrectiveQuat,
  current: CorrectiveQuat,
  axisRestLocal: CorrectiveVec3
): number {
  const [rx, ry, rz, rw] = rest
  const [cx, cy, cz, cw] = current
  // conj(rest) ⊗ current
  const ax = -rx
  const ay = -ry
  const az = -rz
  let qx = rw * cx + ax * cw + ay * cz - az * cy
  let qy = rw * cy - ax * cz + ay * cw + az * cx
  let qz = rw * cz + ax * cy - ay * cx + az * cw
  let qw = rw * cw - ax * cx - ay * cy - az * cz
  if (qw < 0) {
    qx = -qx
    qy = -qy
    qz = -qz
    qw = -qw
  }
  const proj = qx * axisRestLocal[0] + qy * axisRestLocal[1] + qz * axisRestLocal[2]
  return 2 * Math.atan2(proj, qw) * RAD_TO_DEG
}

/**
 * Combined driver angle from the posed bones' current local quaternions
 * (same order as driver.bones). Per-bone clamp FIRST, then the bilateral
 * combine (v1: mean).
 */
export function resolveDriverAngleDeg(
  driver: JointCorrectiveDriver,
  currentQuats: CorrectiveQuat[]
): number {
  if (currentQuats.length !== driver.bones.length) {
    throw new Error(
      `driver ${driver.id} got ${currentQuats.length} bone quats for ${driver.bones.length} bones`
    )
  }
  let sum = 0
  for (let i = 0; i < driver.bones.length; i += 1) {
    const bone = driver.bones[i]
    const angle = swingAngleDeg(bone.restRotation, currentQuats[i], bone.axisRestLocal)
    sum += Math.min(driver.clampDeg[1], Math.max(driver.clampDeg[0], angle))
  }
  return sum / driver.bones.length
}

/**
 * Resolve final morph influences for every corrective-driven key:
 * anchor = lerp(anchorAt0, anchorAt1, anchorDial value) — linear at ANY dial
 * value (extrapolates below the 0-anchor across the dial's own range);
 * delta = anchor * angleCurve(angleDeg); deltas ACCUMULATE per key, add onto
 * the dial-resolved base influence, and clamp to the key's influence bounds.
 * At angle 0 every factor is 0, so the result writes the base back exactly.
 */
export function evaluateJointCorrectives(
  spec: JointCorrectivesSpec,
  anglesByDriver: Record<string, number>,
  dialValues: Record<string, number>,
  baseInfluence: (key: string) => number,
  keys: Record<string, JointCorrectiveTargetBounds>
): Map<string, number> {
  const deltas = new Map<string, number>()
  for (const entry of spec.entries) {
    const angle = anglesByDriver[entry.driver] ?? 0
    const factor = evalBodyDialTrack(entry.angleCurve, angle)
    const t = dialValues[entry.anchorDial] ?? 0
    const anchor = entry.anchorAt0 + (entry.anchorAt1 - entry.anchorAt0) * t
    deltas.set(entry.key, (deltas.get(entry.key) ?? 0) + anchor * factor)
  }
  const out = new Map<string, number>()
  for (const [key, delta] of deltas) {
    const meta = keys[key]
    let influence = baseInfluence(key) + delta
    if (meta) {
      influence = Math.min(meta.influenceMax, Math.max(meta.influenceMin, influence))
    }
    out.set(key, influence)
  }
  return out
}
