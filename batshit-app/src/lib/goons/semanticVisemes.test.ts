import { describe, expect, it } from 'vitest'

import {
  CUSTOM_RHUBARB_LIP_SYNC_MOUTH_ORDER,
  createEmptyCustomRhubarbMouthWeights,
  downmixCustomRhubarbMouthToGoonWeights,
  mapRhubarbCueToCustomRhubarbMouthWeights
} from './semanticVisemes'

describe('semanticVisemes', () => {
  it('maps Rhubarb cues directly into the Custom Rhubarb 9 mouth contract', () => {
    expect(mapRhubarbCueToCustomRhubarbMouthWeights('A')).toMatchObject({
      closed: 1
    })

    expect(mapRhubarbCueToCustomRhubarbMouthWeights('B')).toMatchObject({
      clenched: 0.9
    })

    expect(mapRhubarbCueToCustomRhubarbMouthWeights('C')).toMatchObject({
      mid_open: 0.86
    })

    expect(mapRhubarbCueToCustomRhubarbMouthWeights('D')).toMatchObject({
      wide_open: 1
    })

    expect(mapRhubarbCueToCustomRhubarbMouthWeights('E')).toMatchObject({
      round: 0.82
    })

    expect(mapRhubarbCueToCustomRhubarbMouthWeights('F')).toMatchObject({
      pucker: 0.96
    })

    expect(mapRhubarbCueToCustomRhubarbMouthWeights('G')).toMatchObject({
      teeth_lip: 1
    })

    expect(mapRhubarbCueToCustomRhubarbMouthWeights('H')).toMatchObject({
      tongue_lift: 0.95
    })

    expect(mapRhubarbCueToCustomRhubarbMouthWeights('x')).toMatchObject({
      rest: 1
    })
  })

  it('downmixes Custom Rhubarb 9 back into the current five-shape VRM fallback contract', () => {
    const weights = downmixCustomRhubarbMouthToGoonWeights({
      wide_open: 0.5,
      clenched: 0.75,
      teeth_lip: 0.5,
      rest: 1
    })

    expect(weights.aa).toBeCloseTo(0.5)
    expect(weights.ih).toBeCloseTo(0.28)
    expect(weights.ou).toBeCloseTo(0.04)
    expect(weights.ee).toBeCloseTo(0.54)
    expect(weights.oh).toBeCloseTo(0.11)
  })

  it('creates a zeroed Custom Rhubarb 9 weight object', () => {
    expect(createEmptyCustomRhubarbMouthWeights()).toEqual({
      rest: 0,
      closed: 0,
      clenched: 0,
      mid_open: 0,
      wide_open: 0,
      round: 0,
      pucker: 0,
      teeth_lip: 0,
      tongue_lift: 0
    })
  })

  it('keeps rest out of the active Custom lip-sync mouth morph list', () => {
    expect(CUSTOM_RHUBARB_LIP_SYNC_MOUTH_ORDER).not.toContain('rest')
    expect(CUSTOM_RHUBARB_LIP_SYNC_MOUTH_ORDER).toContain('closed')
    expect(CUSTOM_RHUBARB_LIP_SYNC_MOUTH_ORDER).toContain('wide_open')
  })
})
