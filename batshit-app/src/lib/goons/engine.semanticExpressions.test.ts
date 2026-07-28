import { describe, expect, it } from 'vitest'

import { GoonEngine } from '$lib/goons/engine'

describe('GoonEngine semantic expression capability', () => {
  it('combines explicit Advanced mappings with Standard VRM expressions', () => {
    const engine = new GoonEngine(document.createElement('div')) as any
    engine.customExpressionMorphMap.set('happy', [{ target: 'mouthSmileLeft', weight: 0.55 }])
    engine.vrm = {
      expressionManager: {
        getExpression: (preset: string) => (preset === 'sad' ? { expressionName: preset } : null)
      }
    }

    expect(engine.supportsExpressionPreset('happy')).toBe(true)
    expect(engine.supportsExpressionPreset('sad')).toBe(true)
    expect(engine.supportsExpressionPreset('relaxed')).toBe(false)
    expect(engine.getSupportedSemanticExpressionPresets()).toEqual(['happy', 'sad', 'neutral'])
  })

  it('treats Neutral as the intrinsic rest reset without requiring a morph', () => {
    const engine = new GoonEngine(document.createElement('div')) as any

    expect(engine.supportsExpressionPreset('neutral')).toBe(true)
    expect(engine.getSupportedSemanticExpressionPresets()).toEqual(['neutral'])
  })

  it('reports a model-specific owner for unavailable-control copy', () => {
    const standard = new GoonEngine(document.createElement('div')) as any
    standard.vrmSource = 'vroid'
    expect(standard.getSemanticExpressionSourceLabel()).toBe('This Standard/VRoid model')

    const advanced = new GoonEngine(document.createElement('div')) as any
    advanced.customExpressionMorphMap.set('happy', [{ target: 'mouthSmileLeft', weight: 0.55 }])
    expect(advanced.getSemanticExpressionSourceLabel()).toBe('This Advanced package')
  })
})
