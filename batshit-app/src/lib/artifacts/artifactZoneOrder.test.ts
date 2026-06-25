import { describe, expect, it } from 'vitest'

import {
  artifactOrderChanged,
  hydrateArtifactOrder,
  mergeVisibleDndItems,
  realArtifactIds
} from './artifactZoneOrder'

describe('artifact zone ordering helpers', () => {
  it('hydrates persisted order and appends new artifacts', () => {
    const artifacts = [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
      { id: 'c', name: 'Gamma' }
    ]

    expect(hydrateArtifactOrder(artifacts, [], ['b', 'missing', 'a'])).toEqual([
      artifacts[1],
      artifacts[0],
      artifacts[2]
    ])
  })

  it('detects display field changes for same-id artifacts', () => {
    const before = [{ id: 'a', name: 'Old', version: 1 }]
    const after = [{ id: 'a', name: 'New', version: 1 }]

    expect(artifactOrderChanged(before, after)).toBe(true)
    expect(artifactOrderChanged(after, after)).toBe(false)
  })

  it('keeps hidden header items when dnd only returns visible items', () => {
    const current = [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
      { id: 'c', name: 'Gamma' },
      { id: 'd', name: 'Delta' },
      { id: 'e', name: 'Epsilon' },
      { id: 'f', name: 'Zeta' },
      { id: 'g', name: 'Hidden seventh' }
    ]
    const visibleAfterDrag = [
      { id: 'b', name: 'Beta' },
      { id: 'a', name: 'Alpha' },
      { id: 'c', name: 'Gamma' },
      { id: 'd', name: 'Delta' },
      { id: 'e', name: 'Epsilon' },
      { id: 'f', name: 'Zeta' }
    ]

    const merged = mergeVisibleDndItems(current, visibleAfterDrag)

    expect(realArtifactIds(merged)).toEqual(['b', 'a', 'c', 'd', 'e', 'f', 'g'])
  })

  it('strips drag shadow items before persistence', () => {
    expect(
      realArtifactIds([
        { id: 'a' },
        { id: 'a', isDndShadowItem: true },
        { id: 'b' }
      ])
    ).toEqual(['a', 'b'])
  })

  it('does not duplicate hidden originals when a visible drag item is a shadow', () => {
    const current = [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
      { id: 'c', name: 'Hidden' }
    ]
    const visibleWithShadow = [
      { id: 'a', name: 'Alpha', isDndShadowItem: true },
      { id: 'b', name: 'Beta' }
    ]

    expect(realArtifactIds(mergeVisibleDndItems(current, visibleWithShadow))).toEqual(['b', 'c'])
  })
})
