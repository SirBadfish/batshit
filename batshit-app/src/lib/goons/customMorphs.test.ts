import { describe, expect, it } from 'vitest'

import { applyCustomMorphValue, getCustomMorphValue } from '$lib/goons/customMorphs'

describe('custom morph helpers', () => {
  it('reads the highest active value across a curated custom morph binding', () => {
    expect(
      getCustomMorphValue(
        [
          { target: 'ear_left', value: 0.25 },
          { target: 'ear_right', value: 0.6 },
          { target: 'smile', value: 1 }
        ],
        ['ear_left', 'ear_right']
      )
    ).toBeCloseTo(0.6, 5)
  })

  it('writes one slider value onto every mapped raw morph target', () => {
    expect(
      applyCustomMorphValue(
        [
          { target: 'smile', value: 1 },
          { target: 'ear_left', value: 0.1 }
        ],
        ['ear_left', 'ear_right'],
        0.75
      )
    ).toEqual([
      { target: 'ear_left', value: 0.75 },
      { target: 'ear_right', value: 0.75 },
      { target: 'smile', value: 1 }
    ])
  })

  it('removes every mapped raw morph target when the slider returns to zero', () => {
    expect(
      applyCustomMorphValue(
        [
          { target: 'ear_left', value: 0.75 },
          { target: 'ear_right', value: 0.75 },
          { target: 'smile', value: 1 }
        ],
        ['ear_left', 'ear_right'],
        0
      )
    ).toEqual([{ target: 'smile', value: 1 }])
  })
})
