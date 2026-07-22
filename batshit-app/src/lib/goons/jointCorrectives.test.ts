import { describe, expect, it } from 'vitest'
import macroEngineFixture from './__fixtures__/bodyDialsMacroEngine.json'
import correctivesFixture from './__fixtures__/jointCorrectives.json'
import { parseBodyDialsManifest, type BodyDialsMacroEngine } from './bodyDials'
import type { AppearanceDialsManifest } from './appearanceDials'
import {
  JOINT_CORRECTIVES_CONTRACT,
  evaluateJointCorrectives,
  parseJointCorrectives,
  resolveDriverAngleDeg,
  swingAngleDeg,
  type CorrectiveQuat,
  type CorrectiveVec3,
  type JointCorrectivesSpec
} from './jointCorrectives'

const macroEngine = macroEngineFixture as unknown as BodyDialsMacroEngine

// ---------------------------------------------------------------- fixtures
// The fixture carries the VERBATIM rig.correctives block, butt_size dial, and
// corrective key metas from the real dial-round export, so these tests lock
// exporter emission <-> Josh's spec (dial-review-notes §2a-0) <-> runtime.

function buildManifest(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 2,
    rig: { correctives: correctivesFixture.correctives },
    dials: {
      contract: 'body-dials/v1',
      bodyMesh: 'bs_f1_body',
      groups: [{ id: 'butt', label: 'Butt' }],
      dials: [correctivesFixture.buttSizeDial],
      keys: correctivesFixture.keys,
      macroEngine
    },
    ...overrides
  }
}

function parseFixtureSpec(): JointCorrectivesSpec {
  const manifest = buildManifest()
  const dials = parseBodyDialsManifest(manifest)
  const spec = parseJointCorrectives(manifest, dials)
  if (!spec) throw new Error('fixture spec did not parse')
  return spec
}

// quaternion helpers for synthetic pose tests (x, y, z, w order)
function quatFromAxisAngle(axis: CorrectiveVec3, deg: number): CorrectiveQuat {
  const half = (deg * Math.PI) / 360
  const s = Math.sin(half)
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)]
}

function quatMul(a: CorrectiveQuat, b: CorrectiveQuat): CorrectiveQuat {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ]
}

const spec = parseFixtureSpec()
const hipDriver = spec.drivers[0]
const leftBone = hipDriver.bones[0]

/** current local quat for a pure flexion of `deg` about the measured axis */
function flexed(bone: typeof leftBone, deg: number): CorrectiveQuat {
  return quatMul(bone.restRotation, quatFromAxisAngle(bone.axisRestLocal, deg))
}

describe('parseJointCorrectives', () => {
  it('parses the real exported block and matches the locked spec table', () => {
    expect(spec.contract).toBe(JOINT_CORRECTIVES_CONTRACT)
    expect(spec.drivers).toHaveLength(1)
    expect(hipDriver.id).toBe('hipFlexion')
    expect(hipDriver.kind).toBe('swing-angle')
    expect(hipDriver.combine).toBe('mean')
    expect(hipDriver.clampDeg).toEqual([0, 90])
    expect(hipDriver.bones.map((b) => b.bone)).toEqual([
      'mixamorig:LeftUpLeg',
      'mixamorig:RightUpLeg'
    ])
    expect(Object.keys(hipDriver).sort()).toEqual([
      'bones',
      'clampDeg',
      'combine',
      'id',
      'kind'
    ])

    // Josh's locked numbers (dial-review-notes §2a-0, 2026-07-08)
    const byKey = Object.fromEntries(spec.entries.map((e) => [e.key, e]))
    expect(spec.entries).toHaveLength(7)
    expect(byKey.bs_TEMP_BALL_gap.anchorAt0).toBe(-2)
    expect(byKey.bs_TEMP_BALL_gap.anchorAt1).toBe(-3)
    expect(byKey.bs_TEMP_BALL_gap.angleCurve).toEqual([
      [0, 0],
      [45, 0.8333],
      [90, 1]
    ])
    expect(byKey.bs_TEMP_BALL_bury.anchorAt0).toBe(-0.5)
    expect(byKey.bs_TEMP_BALL_bury.anchorAt1).toBe(2)
    expect(byKey.bs_TEMP_BALL_ovalTop.anchorAt1).toBe(1)
    expect(byKey.bs_TEMP_BALL_ovalBot.anchorAt1).toBe(-1)
    expect(byKey.bs_TEMP_BALL_tiltTop.anchorAt1).toBe(1)
    expect(byKey.bs_TEMP_BALL_tiltTopLat.anchorAt1).toBe(2)
    expect(byKey.bs_TEMP_BALL_tiltBot.anchorAt1).toBe(-1)
    for (const entry of spec.entries) {
      expect(entry.driver).toBe('hipFlexion')
      expect(entry.anchorDial).toBe('butt_size')
      expect(entry.mode).toBe('additive')
      expect(Object.keys(entry).sort()).toEqual([
        'anchorAt0',
        'anchorAt1',
        'anchorDial',
        'angleCurve',
        'driver',
        'key',
        'mode'
      ])
      if (entry.key !== 'bs_TEMP_BALL_gap') {
        expect(entry.angleCurve).toEqual([
          [0, 0],
          [90, 1]
        ])
      }
    }
  })

  it('returns null when the block is absent or empty (placeholder shape)', () => {
    const dials = parseBodyDialsManifest(buildManifest())
    expect(parseJointCorrectives({ dials: {} }, dials)).toBeNull()
    expect(parseJointCorrectives(buildManifest({ rig: {} }), dials)).toBeNull()
    expect(
      parseJointCorrectives(
        buildManifest({
          rig: {
            correctives: {
              driverContract: JOINT_CORRECTIVES_CONTRACT,
              entries: [],
              note: 'placeholder'
            }
          }
        }),
        dials
      )
    ).toBeNull()
  })

  it('fails loudly on malformed populated blocks', () => {
    const manifest = buildManifest()
    const dials = parseBodyDialsManifest(manifest)
    const good = correctivesFixture.correctives as Record<string, unknown>

    // wrong contract
    expect(() =>
      parseJointCorrectives(
        buildManifest({ rig: { correctives: { ...good, driverContract: 'nope/v9' } } }),
        dials
      )
    ).toThrow(/contract/)

    // entries without drivers
    expect(() =>
      parseJointCorrectives(
        buildManifest({ rig: { correctives: { ...good, drivers: [] } } }),
        dials
      )
    ).toThrow(/no drivers/)

    // correctives without the dials block
    expect(() => parseJointCorrectives(manifest, null)).toThrow(/body dials/)

    // entry referencing a key missing from the dials keys block
    const entries = (good.entries as Array<Record<string, unknown>>).map((e) => ({ ...e }))
    entries[0].key = 'bs_TEMP_MISSING'
    expect(() =>
      parseJointCorrectives(buildManifest({ rig: { correctives: { ...good, entries } } }), dials)
    ).toThrow(/missing from the dials keys block/)

    // entry referencing an unknown anchor dial
    const entries2 = (good.entries as Array<Record<string, unknown>>).map((e) => ({ ...e }))
    entries2[0].anchorDial = 'not_a_dial'
    expect(() =>
      parseJointCorrectives(buildManifest({ rig: { correctives: { ...good, entries: entries2 } } }), dials)
    ).toThrow(/unknown anchor dial/)
  })

  it('cross-validates and evaluates the same corrective table against appearance-dials/v2', () => {
    const appearance = {
      dials: [correctivesFixture.buttSizeDial],
      targets: Object.fromEntries(
        Object.entries(correctivesFixture.keys).map(([target, bounds]) => [target, bounds])
      )
    } as unknown as AppearanceDialsManifest
    const v2Entries = correctivesFixture.correctives.entries.map((entry) => {
      const { key, ...rest } = entry
      return { ...rest, target: key }
    })
    const v2Manifest = buildManifest({
      rig: { correctives: { ...correctivesFixture.correctives, entries: v2Entries } }
    })
    const parsed = parseJointCorrectives(v2Manifest, appearance)
    expect(parsed?.entries).toHaveLength(7)
    if (!parsed) throw new Error('appearance corrective fixture did not parse')
    const atFortyFive = evaluateJointCorrectives(
      parsed,
      { hipFlexion: 45 },
      { butt_size: 1 },
      () => 0,
      appearance.targets
    )
    expect(atFortyFive.get('bs_TEMP_BALL_gap')).toBeCloseTo(-2.4999, 4)

    const missing = {
      ...appearance,
      targets: { ...appearance.targets }
    }
    delete missing.targets.bs_TEMP_BALL_gap
    expect(() => parseJointCorrectives(v2Manifest, missing)).toThrow(
      /missing from appearance-dials\/v2/
    )
  })
})

describe('swingAngleDeg', () => {
  it('reads pure flexion about the measured axis exactly', () => {
    for (const bone of hipDriver.bones) {
      for (const deg of [15, 30, 45, 60, 90]) {
        expect(swingAngleDeg(bone.restRotation, flexed(bone, deg), bone.axisRestLocal)).toBeCloseTo(
          deg,
          4
        )
      }
      expect(swingAngleDeg(bone.restRotation, bone.restRotation, bone.axisRestLocal)).toBeCloseTo(
        0,
        6
      )
    }
  })

  it('reads extension (negative swing) with sign', () => {
    expect(
      swingAngleDeg(leftBone.restRotation, flexed(leftBone, -30), leftBone.axisRestLocal)
    ).toBeCloseTo(-30, 4)
  })

  it('ignores rotation about a perpendicular axis (axial thigh twist)', () => {
    // bone-local Y is the thigh direction — essentially perpendicular to the
    // measured flexion axis; axial twist must not read as flexion
    const twisted = quatMul(leftBone.restRotation, quatFromAxisAngle([0, 1, 0], 35))
    expect(
      Math.abs(swingAngleDeg(leftBone.restRotation, twisted, leftBone.axisRestLocal))
    ).toBeLessThan(0.6)
  })

  it('extracts the flexion component from combined flexion + axial twist', () => {
    const combined = quatMul(flexed(leftBone, 60), quatFromAxisAngle([0, 1, 0], 40))
    const angle = swingAngleDeg(leftBone.restRotation, combined, leftBone.axisRestLocal)
    expect(Math.abs(angle - 60)).toBeLessThan(8)
  })

  it('is stable under the quaternion double cover', () => {
    const current = flexed(leftBone, 72)
    const negated = current.map((c) => -c) as CorrectiveQuat
    expect(swingAngleDeg(leftBone.restRotation, negated, leftBone.axisRestLocal)).toBeCloseTo(
      swingAngleDeg(leftBone.restRotation, current, leftBone.axisRestLocal),
      6
    )
  })
})

describe('resolveDriverAngleDeg', () => {
  const restQuats = hipDriver.bones.map((b) => b.restRotation)

  it('means the per-bone angles (bilateral v1)', () => {
    const quats: CorrectiveQuat[] = [flexed(hipDriver.bones[0], 90), restQuats[1]]
    expect(resolveDriverAngleDeg(hipDriver, quats)).toBeCloseTo(45, 3)
    const both: CorrectiveQuat[] = hipDriver.bones.map((b) => flexed(b, 90))
    expect(resolveDriverAngleDeg(hipDriver, both)).toBeCloseTo(90, 3)
  })

  it('clamps per bone BEFORE combining', () => {
    // one leg extended backward (-40 -> clamps to 0), one flexed 90
    const quats: CorrectiveQuat[] = [flexed(hipDriver.bones[0], -40), flexed(hipDriver.bones[1], 90)]
    expect(resolveDriverAngleDeg(hipDriver, quats)).toBeCloseTo(45, 3)
    // deep squat past 90 clamps at 90
    const deep: CorrectiveQuat[] = hipDriver.bones.map((b) => flexed(b, 120))
    expect(resolveDriverAngleDeg(hipDriver, deep)).toBeCloseTo(90, 3)
  })

  it('throws on a bone-count mismatch', () => {
    expect(() => resolveDriverAngleDeg(hipDriver, [restQuats[0]])).toThrow(/bone quats/)
  })
})

describe('evaluateJointCorrectives', () => {
  const keys = correctivesFixture.keys as Record<
    string,
    { baselineValue: number; influenceMin: number; influenceMax: number }
  >
  const zeroBase = () => 0

  function finalsAt(angleDeg: number, buttSize: number, base: (key: string) => number = zeroBase) {
    return evaluateJointCorrectives(
      spec,
      { hipFlexion: angleDeg },
      { butt_size: buttSize },
      base,
      keys
    )
  }

  it("matches Josh's locked table at 90° (both anchor columns)", () => {
    const atMax = finalsAt(90, 1)
    expect(atMax.get('bs_TEMP_BALL_gap')).toBeCloseTo(-3, 6)
    expect(atMax.get('bs_TEMP_BALL_bury')).toBeCloseTo(2, 6)
    expect(atMax.get('bs_TEMP_BALL_ovalTop')).toBeCloseTo(1, 6)
    expect(atMax.get('bs_TEMP_BALL_ovalBot')).toBeCloseTo(-1, 6)
    expect(atMax.get('bs_TEMP_BALL_tiltTop')).toBeCloseTo(1, 6)
    expect(atMax.get('bs_TEMP_BALL_tiltTopLat')).toBeCloseTo(2, 6)
    expect(atMax.get('bs_TEMP_BALL_tiltBot')).toBeCloseTo(-1, 6)

    const atZero = finalsAt(90, 0)
    expect(atZero.get('bs_TEMP_BALL_gap')).toBeCloseTo(-2, 6)
    expect(atZero.get('bs_TEMP_BALL_bury')).toBeCloseTo(-0.5, 6)
    expect(atZero.get('bs_TEMP_BALL_ovalTop')).toBeCloseTo(0, 6)
    expect(atZero.get('bs_TEMP_BALL_tiltTopLat')).toBeCloseTo(0, 6)
  })

  it('front-loads the gap channel while the others stay linear (45°)', () => {
    const atMax = finalsAt(45, 1)
    // Josh: gap already -2.5 of -3.0 at 45°/BALL=1
    expect(atMax.get('bs_TEMP_BALL_gap')).toBeCloseTo(-3 * 0.8333, 4)
    expect(atMax.get('bs_TEMP_BALL_bury')).toBeCloseTo(1, 6)
    expect(atMax.get('bs_TEMP_BALL_ovalTop')).toBeCloseTo(0.5, 6)

    // Josh: gap -1.67 of -2.0 at 45°/BALL=0 ("same scale")
    const atZero = finalsAt(45, 0)
    expect(atZero.get('bs_TEMP_BALL_gap')).toBeCloseTo(-2 * 0.8333, 4)
  })

  it("holds continuity on both axes (Josh's 53°/BALL=0.26 demo point)", () => {
    const finals = finalsAt(53, 0.26)
    // anchor = lerp(-2, -3, 0.26) = -2.26; curve(53°) = 0.8333 + (8/45)*0.1667
    const curve53 = 0.8333 + ((53 - 45) / 45) * (1 - 0.8333)
    expect(finals.get('bs_TEMP_BALL_gap')).toBeCloseTo(-2.26 * curve53, 4)
    expect(finals.get('bs_TEMP_BALL_bury')).toBeCloseTo(
      (-0.5 + (2 - -0.5) * 0.26) * (53 / 90),
      4
    )
  })

  it('adds on the dial-resolved base and clamps to the influence bounds', () => {
    // user pulled cheeks together (gap -1): -1 + -3 = -4, inside min -5.4
    const withGapBase = finalsAt(90, 1, (key) => (key === 'bs_TEMP_BALL_gap' ? -1 : 0))
    expect(withGapBase.get('bs_TEMP_BALL_gap')).toBeCloseTo(-4, 6)

    // user maxed bury (+1): +1 + 2 = +3 = exactly the authored ceiling
    const withBuryBase = finalsAt(90, 1, (key) => (key === 'bs_TEMP_BALL_bury' ? 1 : 0))
    expect(withBuryBase.get('bs_TEMP_BALL_bury')).toBeCloseTo(keys.bs_TEMP_BALL_bury.influenceMax, 6)

    // user maxed upper butt height (+1): +1 + 1 = 2 -> clamps to +1
    const withOvalBase = finalsAt(90, 1, (key) => (key === 'bs_TEMP_BALL_ovalTop' ? 1 : 0))
    expect(withOvalBase.get('bs_TEMP_BALL_ovalTop')).toBeCloseTo(
      keys.bs_TEMP_BALL_ovalTop.influenceMax,
      6
    )
  })

  it('extrapolates the anchor line below the 0 column (butt_size dial floor)', () => {
    const finals = finalsAt(90, -0.25)
    // anchor = -2 + (-3 - -2) * -0.25 = -1.75
    expect(finals.get('bs_TEMP_BALL_gap')).toBeCloseTo(-1.75, 6)
    expect(finals.get('bs_TEMP_BALL_ovalTop')).toBeCloseTo(-0.25, 6)
  })

  it('writes the base back exactly at zero angle', () => {
    const base = (key: string) => (key === 'bs_TEMP_BALL_gap' ? 0.4 : 0)
    const finals = finalsAt(0, 1, base)
    expect(finals.get('bs_TEMP_BALL_gap')).toBeCloseTo(0.4, 6)
    expect(finals.get('bs_TEMP_BALL_bury')).toBeCloseTo(0, 6)
    // every corrective-driven key gets an explicit write-back entry
    expect(finals.size).toBe(7)
  })
})
