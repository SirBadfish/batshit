import { describe, expect, it } from 'vitest'

import {
  GOON_SEMANTIC_EXPRESSION_CONTROLS,
  resolveGoonSemanticExpressionControlStates
} from '$lib/goons/semanticExpressions'

describe('semantic Goon expression controls', () => {
  it('keeps one stable user-facing vocabulary in semantic order', () => {
    expect(GOON_SEMANTIC_EXPRESSION_CONTROLS).toEqual([
      { value: 'happy', label: 'Happy' },
      { value: 'relaxed', label: 'Relaxed' },
      { value: 'sad', label: 'Sad' },
      { value: 'angry', label: 'Angry' },
      { value: 'surprised', label: 'Surprised' },
      { value: 'neutral', label: 'Neutral' }
    ])
  })

  it('marks unsupported semantics unavailable without removing them', () => {
    const states = resolveGoonSemanticExpressionControlStates(
      new Set(['happy', 'sad']),
      'This Advanced package'
    )

    expect(states).toHaveLength(GOON_SEMANTIC_EXPRESSION_CONTROLS.length)
    expect(states.find((entry) => entry.value === 'happy')).toEqual({
      value: 'happy',
      label: 'Happy',
      available: true
    })
    expect(states.find((entry) => entry.value === 'relaxed')).toEqual({
      value: 'relaxed',
      label: 'Relaxed',
      available: false,
      unavailableReason: 'This Advanced package does not provide a mapped Relaxed expression.'
    })
    expect(states.find((entry) => entry.value === 'neutral')).toEqual({
      value: 'neutral',
      label: 'Neutral',
      available: true
    })
  })
})
