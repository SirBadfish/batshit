/**
 * Runtime-only joint correctives for baked Live Goons.
 *
 * Authoring packages use `rig.correctives` (`joint-angle-corrective/v1`),
 * whose anchors depend on editable Appearance/Body dial values. Live Goons
 * deliberately contain neither authoring contract. The baker therefore
 * resolves those anchors once and emits this smaller, direct morph-binding
 * contract. Driver math remains shared with the authoring lane.
 */

import {
  evalBodyDialTrack,
  type BodyDialTrackPoint
} from './bodyDials'
import {
  type JointCorrectiveDriver,
  type CorrectiveQuat,
  resolveDriverAngleDeg
} from './jointCorrectives'

export const LIVE_JOINT_CORRECTIVES_CONTRACT = 'joint-angle-live-corrective/v1' as const

export type LiveJointCorrectiveEntry = {
  id: string
  driver: string
  node: string
  morph: string
  baseInfluence: number
  anchor: number
  influenceMin: number
  influenceMax: number
  angleCurve: BodyDialTrackPoint[]
  mode: 'additive'
}

export type LiveJointCorrectivesSpec = {
  contract: typeof LIVE_JOINT_CORRECTIVES_CONTRACT
  drivers: JointCorrectiveDriver[]
  entries: LiveJointCorrectiveEntry[]
}

function fail(message: string): never {
  throw new Error(`avatar.json#rig.liveCorrectives ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    fail(`${context} must contain exactly: ${sortedExpected.join(', ')}`)
  }
}

function finite(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${context} must be finite`)
  }
  return Object.is(value, -0) ? 0 : value
}

function stableString(value: unknown, context: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${context} must be a non-empty trimmed string`)
  }
  return value
}

function vec(value: unknown, length: number, context: string): number[] {
  if (!Array.isArray(value) || value.length !== length) {
    fail(`${context} must contain ${length} values`)
  }
  return value.map((entry, index) => finite(entry, `${context}[${index}]`))
}

function parseDriver(value: unknown, index: number): JointCorrectiveDriver {
  if (!isRecord(value)) fail(`drivers[${index}] must be an object`)
  exactKeys(value, ['id', 'kind', 'combine', 'clampDeg', 'bones'], `drivers[${index}]`)
  const id = stableString(value.id, `drivers[${index}].id`)
  if (value.kind !== 'swing-angle' || value.combine !== 'mean') {
    fail(`driver ${id} has an unsupported kind or combine law`)
  }
  const clampDeg = vec(value.clampDeg, 2, `driver ${id}.clampDeg`) as [number, number]
  if (clampDeg[0] >= clampDeg[1]) fail(`driver ${id}.clampDeg must increase`)
  if (!Array.isArray(value.bones) || value.bones.length === 0) {
    fail(`driver ${id} must contain bones`)
  }
  const bones = value.bones.map((boneValue, boneIndex) => {
    if (!isRecord(boneValue)) fail(`driver ${id}.bones[${boneIndex}] must be an object`)
    exactKeys(
      boneValue,
      ['bone', 'restRotation', 'axisRestLocal'],
      `driver ${id}.bones[${boneIndex}]`
    )
    const restRotation = vec(
      boneValue.restRotation,
      4,
      `driver ${id}.bones[${boneIndex}].restRotation`
    ) as [number, number, number, number]
    const rotationLength = Math.hypot(...restRotation)
    if (Math.abs(rotationLength - 1) > 0.01) {
      fail(`driver ${id}.bones[${boneIndex}].restRotation must be unit length`)
    }
    const axisRestLocal = vec(
      boneValue.axisRestLocal,
      3,
      `driver ${id}.bones[${boneIndex}].axisRestLocal`
    ) as [number, number, number]
    const axisLength = Math.hypot(...axisRestLocal)
    if (Math.abs(axisLength - 1) > 0.01) {
      fail(`driver ${id}.bones[${boneIndex}].axisRestLocal must be unit length`)
    }
    return {
      bone: stableString(boneValue.bone, `driver ${id}.bones[${boneIndex}].bone`),
      restRotation,
      axisRestLocal
    }
  })
  return { id, kind: 'swing-angle', combine: 'mean', clampDeg, bones }
}

function parseTrack(value: unknown, context: string): BodyDialTrackPoint[] {
  if (!Array.isArray(value) || value.length < 2) fail(`${context} must contain at least two points`)
  const points: BodyDialTrackPoint[] = []
  value.forEach((point, index) => {
    const parsed = vec(point, 2, `${context}[${index}]`) as [number, number]
    if (index > 0 && parsed[0] <= points[index - 1]![0]) {
      fail(`${context} degrees must increase strictly`)
    }
    points.push(parsed)
  })
  return points
}

export function parseLiveJointCorrectives(value: unknown): LiveJointCorrectivesSpec | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) fail('must be an object')
  exactKeys(value, ['contract', 'drivers', 'entries'], 'contract root')
  if (value.contract !== LIVE_JOINT_CORRECTIVES_CONTRACT) {
    fail(`contract must be ${LIVE_JOINT_CORRECTIVES_CONTRACT}`)
  }
  if (!Array.isArray(value.drivers) || !Array.isArray(value.entries)) {
    fail('drivers and entries must be arrays')
  }
  const drivers = value.drivers.map(parseDriver)
  const driverIds = new Set<string>()
  for (const driver of drivers) {
    if (driverIds.has(driver.id)) fail(`contains duplicate driver ${driver.id}`)
    driverIds.add(driver.id)
  }
  const entryIds = new Set<string>()
  const bindingContracts = new Map<string, string>()
  const entries = value.entries.map((entryValue, index): LiveJointCorrectiveEntry => {
    if (!isRecord(entryValue)) fail(`entries[${index}] must be an object`)
    exactKeys(
      entryValue,
      [
        'id',
        'driver',
        'node',
        'morph',
        'baseInfluence',
        'anchor',
        'influenceMin',
        'influenceMax',
        'angleCurve',
        'mode'
      ],
      `entries[${index}]`
    )
    const id = stableString(entryValue.id, `entries[${index}].id`)
    if (entryIds.has(id)) fail(`contains duplicate entry ${id}`)
    entryIds.add(id)
    const driver = stableString(entryValue.driver, `entry ${id}.driver`)
    if (!driverIds.has(driver)) fail(`entry ${id} references unknown driver ${driver}`)
    const node = stableString(entryValue.node, `entry ${id}.node`)
    const morph = stableString(entryValue.morph, `entry ${id}.morph`)
    const binding = `${node}\u0000${morph}`
    const influenceMin = finite(entryValue.influenceMin, `entry ${id}.influenceMin`)
    const influenceMax = finite(entryValue.influenceMax, `entry ${id}.influenceMax`)
    if (influenceMin >= influenceMax) fail(`entry ${id} influence bounds must increase`)
    const baseInfluence = finite(entryValue.baseInfluence, `entry ${id}.baseInfluence`)
    if (baseInfluence < influenceMin || baseInfluence > influenceMax) {
      fail(`entry ${id}.baseInfluence is outside its influence bounds`)
    }
    const bindingContract = `${baseInfluence}\u0000${influenceMin}\u0000${influenceMax}`
    const priorBindingContract = bindingContracts.get(binding)
    if (priorBindingContract && priorBindingContract !== bindingContract) {
      fail(`entries for ${node}/${morph} disagree on base influence or bounds`)
    }
    bindingContracts.set(binding, bindingContract)
    if (entryValue.mode !== 'additive') fail(`entry ${id}.mode must be additive`)
    return {
      id,
      driver,
      node,
      morph,
      baseInfluence,
      anchor: finite(entryValue.anchor, `entry ${id}.anchor`),
      influenceMin,
      influenceMax,
      angleCurve: parseTrack(entryValue.angleCurve, `entry ${id}.angleCurve`),
      mode: 'additive'
    }
  })
  if (entries.length === 0) return null
  return { contract: LIVE_JOINT_CORRECTIVES_CONTRACT, drivers, entries }
}

export function parseLiveJointCorrectivesFromManifest(manifest: unknown): LiveJointCorrectivesSpec | null {
  if (!isRecord(manifest) || !isRecord(manifest.rig)) return null
  return parseLiveJointCorrectives(manifest.rig.liveCorrectives)
}

export function evaluateLiveJointCorrectives(
  spec: LiveJointCorrectivesSpec,
  posedRotations: Record<string, CorrectiveQuat[]>
): Map<string, number> {
  const angles: Record<string, number> = {}
  for (const driver of spec.drivers) {
    const rotations = posedRotations[driver.id]
    if (!rotations || rotations.length !== driver.bones.length) {
      fail(`driver ${driver.id} posed rotation inventory is incomplete`)
    }
    angles[driver.id] = resolveDriverAngleDeg(driver, rotations)
  }
  return evaluateLiveJointCorrectiveAngles(spec, angles)
}

export function evaluateLiveJointCorrectiveAngles(
  spec: LiveJointCorrectivesSpec,
  angles: Record<string, number>
): Map<string, number> {
  for (const driver of spec.drivers) {
    if (!Number.isFinite(angles[driver.id])) {
      fail(`driver ${driver.id} angle is missing or non-finite`)
    }
  }
  const deltas = new Map<string, number>()
  const contracts = new Map<
    string,
    Pick<LiveJointCorrectiveEntry, 'baseInfluence' | 'influenceMin' | 'influenceMax'>
  >()
  for (const entry of spec.entries) {
    const factor = evalBodyDialTrack(entry.angleCurve, angles[entry.driver]!)
    const key = `${entry.node}\u0000${entry.morph}`
    deltas.set(key, (deltas.get(key) ?? 0) + entry.anchor * factor)
    contracts.set(key, entry)
  }
  const values = new Map<string, number>()
  for (const [key, delta] of deltas) {
    const contract = contracts.get(key)!
    const unclamped = contract.baseInfluence + delta
    values.set(key, Math.min(contract.influenceMax, Math.max(contract.influenceMin, unclamped)))
  }
  return values
}
