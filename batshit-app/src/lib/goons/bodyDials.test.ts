import { describe, expect, it } from 'vitest'
import macroEngineFixture from './__fixtures__/bodyDialsMacroEngine.json'
import macroParityFixture from './__fixtures__/bodyDialsMacroParity.json'
import {
  BODY_DIALS_CONTRACT,
  bodyDialValuesEqual,
  evalBodyDialTrack,
  interpolateMacroComponents,
  normalizeBodyDialValues,
  parseBodyDialsManifest,
  resolveBodyDialState,
  resolveMacroCornerWeights,
  type BodyDialsMacroEngine,
  type BodyDialsManifest
} from './bodyDials'

const macroEngine = macroEngineFixture as unknown as BodyDialsMacroEngine

function buildManifest(overrides: Partial<BodyDialsManifest> = {}): BodyDialsManifest {
  return {
    contract: BODY_DIALS_CONTRACT,
    bodyMesh: 'bs_f1_body',
    groups: [
      { id: 'stature', label: 'Stature & Frame' },
      { id: 'macros', label: 'Body Macros' }
    ],
    dials: [
      {
        id: 'waist',
        label: 'Waist',
        group: 'stature',
        kind: 'tracks',
        range: [-1, 1],
        default: 0,
        members: [
          { key: 'measure-waist-circ-incr', track: [[0, 0], [1, 1]] },
          { key: 'measure-waist-circ-decr', track: [[-1, 1], [0, 0]] }
        ]
      },
      {
        id: 'stomach_tone',
        label: 'Stomach Tone',
        group: 'stature',
        kind: 'tracks',
        range: [0, 1],
        default: 1,
        members: [{ key: 'stomach-tone-incr', track: [[0, -1], [1, 0]] }]
      },
      {
        id: 'leg_length',
        label: 'Leg Length',
        group: 'stature',
        kind: 'tracks',
        range: [-1, 1],
        default: 0,
        members: [
          { key: 'torso-scale-vert-decr', track: [[0, 0], [1, 1]] },
          { key: 'measure-upperleg-height-incr', track: [[0, 0], [1, 0.11]] }
        ]
      },
      {
        id: 'overall_height',
        label: 'Overall Height',
        group: 'stature',
        kind: 'root-scale',
        range: [-1, 1],
        default: 0,
        scalePerUnit: 0.15
      },
      {
        id: 'macro_muscle',
        label: 'Muscle',
        group: 'macros',
        kind: 'macro-axis',
        axis: 'muscle',
        range: [0, 1],
        default: (macroEngine.baselineState as { muscle: number }).muscle
      },
      {
        id: 'macro_weight',
        label: 'Weight',
        group: 'macros',
        kind: 'macro-axis',
        axis: 'weight',
        range: [0, 1],
        default: (macroEngine.baselineState as { weight: number }).weight
      },
      {
        id: 'macro_cup',
        label: 'Cup Size',
        group: 'macros',
        kind: 'macro-axis',
        axis: 'cupsize',
        range: [0, 1],
        default: (macroEngine.baselineState as { cupsize: number }).cupsize
      },
      {
        id: 'macro_firmness',
        label: 'Firmness',
        group: 'macros',
        kind: 'macro-axis',
        axis: 'firmness',
        range: [0, 1],
        default: (macroEngine.baselineState as { firmness: number }).firmness
      },
      {
        id: 'head_size',
        label: 'Head Size',
        group: 'stature',
        kind: 'tracks',
        range: [-1, 1],
        default: 0,
        members: [{ key: 'head-scale-vert-incr', track: [[0, 0], [1, 1]] }]
      }
    ],
    keys: {
      'measure-waist-circ-incr': { baselineValue: 0, influenceMin: 0, influenceMax: 1 },
      'measure-waist-circ-decr': { baselineValue: 0, influenceMin: 0, influenceMax: 1 },
      'stomach-tone-incr': { baselineValue: 1, influenceMin: -1, influenceMax: 0 },
      'torso-scale-vert-decr': {
        baselineValue: 0,
        influenceMin: 0,
        influenceMax: 1,
        soleDeltaY: 0
      },
      'measure-upperleg-height-incr': {
        baselineValue: 0,
        influenceMin: 0,
        influenceMax: 1.745455,
        soleDeltaY: -0.0894
      },
      'head-scale-vert-incr': { baselineValue: 0, influenceMin: 0, influenceMax: 1 }
    },
    macroEngine,
    jointDeltas: {
      'measure-upperleg-height-incr': {
        'mixamorig:LeftLeg': [0, -0.0894, 0],
        'mixamorig:LeftFoot': [0, -0.16, 0]
      }
    },
    headAssetFollow: {
      dial: 'head_size',
      nodes: ['bs_f1_eyes'],
      scalePerUnit: 0.1,
      pivotWorld: [0, 1.27, 0.03]
    },
    ...overrides
  }
}

describe('parseBodyDialsManifest', () => {
  it('returns null when the avatar has no dials block', () => {
    expect(parseBodyDialsManifest({ name: 'plain avatar' })).toBeNull()
    expect(parseBodyDialsManifest(null)).toBeNull()
  })

  it('parses a valid dials block', () => {
    const parsed = parseBodyDialsManifest({ dials: buildManifest() })
    expect(parsed).not.toBeNull()
    expect(parsed?.bodyMesh).toBe('bs_f1_body')
    expect(parsed?.dials.map((dial) => dial.id)).toContain('macro_muscle')
  })

  it('throws loudly on a malformed dials block instead of silently skipping', () => {
    expect(() => parseBodyDialsManifest({ dials: { contract: 'other/v9' } })).toThrow(
      /contract/
    )
    const missingKey = buildManifest()
    missingKey.dials[0]!.members![0]!.key = 'not-in-keys-block'
    expect(() => parseBodyDialsManifest({ dials: missingKey })).toThrow(/missing from the keys/)
  })
})

describe('evalBodyDialTrack', () => {
  it('interpolates linearly and clamps at the ends', () => {
    const track: Array<[number, number]> = [
      [0.5, 0],
      [0.8, 0.75],
      [1, 1]
    ]
    expect(evalBodyDialTrack(track, 0.5)).toBe(0)
    expect(evalBodyDialTrack(track, 0.65)).toBeCloseTo(0.375, 10)
    expect(evalBodyDialTrack(track, 0.9)).toBeCloseTo(0.875, 10)
    expect(evalBodyDialTrack(track, 0)).toBe(0)
    expect(evalBodyDialTrack(track, 2)).toBe(1)
  })
})

describe('normalizeBodyDialValues', () => {
  it('applies defaults and clamps stored values to the dial range', () => {
    const manifest = buildManifest()
    const values = normalizeBodyDialValues(manifest, { waist: 4, macro_weight: -2 })
    expect(values.waist).toBe(1)
    expect(values.macro_weight).toBe(0)
    expect(values.stomach_tone).toBe(1)
    expect(values.macro_muscle).toBeCloseTo(
      (macroEngine.baselineState as { muscle: number }).muscle,
      6
    )
  })
})

describe('resolveBodyDialState', () => {
  it('resolves zero influences at defaults (baseline is the base mesh)', () => {
    const manifest = buildManifest()
    const state = resolveBodyDialState(manifest, null)
    for (const [, influence] of state.influences) {
      expect(Math.abs(influence)).toBeLessThan(1e-6)
    }
    expect(state.rootScale).toBe(1)
    expect(state.soleOffsetY).toBeCloseTo(0, 10)
    expect(state.headAssetScale).toBe(1)
    expect(state.jointOffsets.size).toBe(0)
  })

  it('drives pair dials in both directions with per-key clamping', () => {
    const manifest = buildManifest()
    const up = resolveBodyDialState(manifest, { waist: 0.6 })
    expect(up.influences.get('measure-waist-circ-incr')).toBeCloseTo(0.6, 10)
    expect(up.influences.get('measure-waist-circ-decr') ?? 0).toBe(0)
    const down = resolveBodyDialState(manifest, { waist: -0.4 })
    expect(down.influences.get('measure-waist-circ-decr')).toBeCloseTo(0.4, 10)
  })

  it('supports negative influences for baked-in defaults (stomach tone)', () => {
    const manifest = buildManifest()
    const state = resolveBodyDialState(manifest, { stomach_tone: 0 })
    expect(state.influences.get('stomach-tone-incr')).toBeCloseTo(-1, 10)
  })

  it('accumulates joint offsets and sole shift from member influences', () => {
    const manifest = buildManifest()
    const state = resolveBodyDialState(manifest, { leg_length: 1 })
    expect(state.influences.get('measure-upperleg-height-incr')).toBeCloseTo(0.11, 10)
    const leg = state.jointOffsets.get('mixamorig:LeftLeg')
    expect(leg?.[1]).toBeCloseTo(0.11 * -0.0894, 10)
    expect(state.soleOffsetY).toBeCloseTo(0.11 * -0.0894, 10)
  })

  it('applies root scale and head-asset follow from their dials', () => {
    const manifest = buildManifest()
    const state = resolveBodyDialState(manifest, { overall_height: 1, head_size: -1 })
    expect(state.rootScale).toBeCloseTo(1.15, 10)
    expect(state.headAssetScale).toBeCloseTo(0.9, 10)
  })
})

describe('macro engine (MPFB product formula)', () => {
  it('reproduces the live baseline corner values at the baseline state', () => {
    const baseline = macroEngine.baselineState as Record<string, number>
    const weights = resolveMacroCornerWeights(macroEngine, {
      muscle: baseline.muscle!,
      weight: baseline.weight!,
      cupsize: baseline.cupsize!,
      firmness: baseline.firmness!
    })
    for (const corner of macroEngine.corners) {
      expect(weights.get(corner.key) ?? 0).toBeCloseTo(corner.baselineWeight, 3)
    }
  })

  it('matches the MPFB ground-truth parity fixture at every sample', () => {
    const parity = macroParityFixture as unknown as {
      cutoff: number
      samples: Array<{
        dials: { muscle: number; weight: number; cupsize: number; firmness: number }
        corners: Record<string, number>
      }>
    }
    expect(parity.samples.length).toBeGreaterThan(80)
    for (const sample of parity.samples) {
      const weights = resolveMacroCornerWeights(macroEngine, sample.dials)
      for (const corner of macroEngine.corners) {
        const truth = sample.corners[corner.key] ?? 0
        const mine = weights.get(corner.key) ?? 0
        expect(
          Math.abs(mine - truth),
          `${corner.key} at ${JSON.stringify(sample.dials)}`
        ).toBeLessThan(2e-3)
      }
    }
  })

  it('interpolates macro components exactly like MPFB at the padded edges', () => {
    const parts = macroEngine.dims.weight.parts
    const atZero = interpolateMacroComponents(parts, 0)
    expect(atZero.get('minweight')).toBeCloseTo(0.9804, 3)
    expect(atZero.get('averageweight')).toBeCloseTo(0.0196, 3)
    const atHalfPlus = interpolateMacroComponents(parts, 0.75)
    expect(atHalfPlus.get('averageweight')).toBeCloseTo(0.5098, 2)
    expect(atHalfPlus.get('maxweight')).toBeCloseTo(0.4902, 2)
  })
})

describe('bodyDialValuesEqual', () => {
  it('compares stored records field-wise', () => {
    expect(bodyDialValuesEqual({ a: 1 }, { a: 1 })).toBe(true)
    expect(bodyDialValuesEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(bodyDialValuesEqual({ a: 1 }, { a: 1, b: 0 })).toBe(false)
    expect(bodyDialValuesEqual(null, {})).toBe(true)
  })
})

describe('cup size top extension (macro-axis extrapolation)', () => {
  // Recompute the axis endpoint exactly like the exporter: the value where
  // the last (padded) cup part's high comp reaches 2.0 — Josh's approved
  // "100% past designed max" state (maxcup x2.0 / averagecup x-1.0).
  const cupParts = macroEngine.dims.cupsize.parts
  const last = cupParts[cupParts.length - 1]
  const axisTop = last.lowest + 2.0 * (last.highest - last.lowest)
  const extEngine: BodyDialsMacroEngine = {
    ...macroEngine,
    dims: {
      ...macroEngine.dims,
      cupsize: { ...macroEngine.dims.cupsize, extrapolateHigh: true }
    }
  }

  it('extrapolates the last cup part to the approved maximum', () => {
    const comps = interpolateMacroComponents(cupParts, axisTop, true)
    expect(comps.get('maxcup')).toBeCloseTo(2.0, 3)
    expect(comps.get('averagecup')).toBeCloseTo(-1.0, 3)
  })

  it('returns nothing beyond the top without the flag (old behavior)', () => {
    expect(interpolateMacroComponents(cupParts, axisTop).size).toBe(0)
  })

  it('is continuous across the padded top bound', () => {
    const justBelow = interpolateMacroComponents(cupParts, last.highest - 1e-6, true)
    const atBound = interpolateMacroComponents(cupParts, last.highest, true)
    expect(atBound.get('maxcup')).toBeCloseTo(justBelow.get('maxcup') ?? 0, 3)
    expect(atBound.get('averagecup') ?? 0).toBeCloseTo(justBelow.get('averagecup') ?? 0, 3)
  })

  it('keeps in-range results identical with the flag on', () => {
    const a = interpolateMacroComponents(cupParts, 0.730005)
    const b = interpolateMacroComponents(cupParts, 0.730005, true)
    expect([...b.entries()]).toEqual([...a.entries()])
  })

  it('produces the approved corner weights through the product formula', () => {
    const baseline = macroEngine.baselineState as Record<string, number>
    const weights = resolveMacroCornerWeights(extEngine, {
      muscle: baseline.muscle!,
      weight: baseline.weight!,
      cupsize: axisTop,
      firmness: baseline.firmness!
    })
    const muscleComps = interpolateMacroComponents(macroEngine.dims.muscle.parts, baseline.muscle!)
    const weightComps = interpolateMacroComponents(macroEngine.dims.weight.parts, baseline.weight!)
    const firmComps = interpolateMacroComponents(macroEngine.dims.firmness.parts, baseline.firmness!)
    let checkedMax = 0
    let checkedAvg = 0
    for (const corner of extEngine.corners) {
      if (!corner.comps.cupsize) continue
      const others =
        corner.fixedFactor *
        (corner.comps.muscle ? (muscleComps.get(corner.comps.muscle) ?? 0) : 1) *
        (corner.comps.weight ? (weightComps.get(corner.comps.weight) ?? 0) : 1) *
        (corner.comps.firmness ? (firmComps.get(corner.comps.firmness) ?? 0) : 1)
      if (Math.abs(others) < 0.02) continue
      const got = weights.get(corner.key) ?? 0
      if (corner.comps.cupsize === 'maxcup') {
        expect(got, `${corner.key} (maxcup)`).toBeCloseTo(2.0 * others, 2)
        checkedMax += 1
      } else if (corner.comps.cupsize === 'averagecup') {
        expect(got, `${corner.key} (averagecup)`).toBeCloseTo(-1.0 * others, 2)
        checkedAvg += 1
      }
    }
    expect(checkedMax).toBeGreaterThan(0)
    expect(checkedAvg).toBeGreaterThan(0)
  })

  it('routes the dial through axisTrack and resolves extended influences', () => {
    const manifest = buildManifest({ macroEngine: extEngine })
    const cup = manifest.dials.find((d) => d.id === 'macro_cup')!
    cup.range = [0, 1.25]
    cup.axisTrack = [
      [0, 0],
      [1, 1],
      [1.25, Math.round(axisTop * 1e6) / 1e6]
    ]

    // identity segment: below dial 1.0 the track changes nothing
    const plain = buildManifest()
    const a = resolveBodyDialState(manifest, { macro_cup: 0.9 })
    const b = resolveBodyDialState(plain, { macro_cup: 0.9 })
    for (const corner of macroEngine.corners) {
      expect(a.influences.get(corner.key) ?? 0).toBeCloseTo(b.influences.get(corner.key) ?? 0, 6)
    }

    // extended top: the dominant maxcup corner overshoots its designed max
    // and the dominant averagecup corner goes hard negative
    const top = resolveBodyDialState(manifest, { macro_cup: 1.25 })
    const domMax = macroEngine.corners
      .filter((c) => c.comps.cupsize === 'maxcup')
      .sort((x, y) => y.baselineWeight - x.baselineWeight)[0]
    const domAvg = macroEngine.corners
      .filter((c) => c.comps.cupsize === 'averagecup')
      .sort((x, y) => y.baselineWeight - x.baselineWeight)[0]
    expect(top.influences.get(domMax.key) ?? 0).toBeGreaterThan(1.0)
    expect(top.influences.get(domAvg.key) ?? 0).toBeLessThan(-0.9)
  })

  it('rejects malformed or misplaced axisTrack at parse time', () => {
    const bad = buildManifest() as unknown as { dials: Array<Record<string, unknown>> }
    bad.dials.find((d) => d.id === 'macro_cup')!.axisTrack = 'nope'
    expect(() => parseBodyDialsManifest({ dials: bad })).toThrow(/axisTrack/)

    const misplaced = buildManifest() as unknown as { dials: Array<Record<string, unknown>> }
    misplaced.dials.find((d) => d.id === 'waist')!.axisTrack = [
      [0, 0],
      [1, 1]
    ]
    expect(() => parseBodyDialsManifest({ dials: misplaced })).toThrow(/axisTrack/)
  })
})
