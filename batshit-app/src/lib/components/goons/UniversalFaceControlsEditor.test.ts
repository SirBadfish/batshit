import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

import UniversalFaceControlsEditor from './UniversalFaceControlsEditor.svelte'
import type { UniversalFaceControlModel } from '$lib/goons/universalFaceControls'
import { GOON_SEMANTIC_EXPRESSION_CONTROLS } from '$lib/goons/semanticExpressions'

if (typeof globalThis.ResizeObserver === 'undefined') {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })
}

if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: () => ({
      cancel: () => {},
      finish: () => {},
      play: () => {},
      pause: () => {},
      onfinish: null
    })
  })
}

const model: UniversalFaceControlModel = {
  sections: [
    {
      id: 'eyes',
      label: 'Eyes',
      controls: [
        {
          id: 'arkit:eyeBlinkLeft',
          label: 'Blink, Left',
          searchText: 'eyeBlinkLeft Blink Left ARKit',
          storage: 'raw-morph',
          morphTargets: ['EyeBlinkLeft'],
          min: 0,
          max: 1,
          step: 0.01,
          bipolar: false,
          negativeLabel: 'Neutral',
          positiveLabel: 'Full'
        }
      ]
    },
    {
      id: 'jaw',
      label: 'Jaw',
      controls: [
        {
          id: 'arkit:jawOpen',
          label: 'Open',
          searchText: 'jawOpen Open ARKit',
          storage: 'raw-morph',
          morphTargets: ['JawOpen'],
          min: 0,
          max: 1,
          step: 0.01,
          bipolar: false,
          negativeLabel: 'Neutral',
          positiveLabel: 'Full'
        }
      ]
    }
  ],
  managedRawMorphTargetNames: ['EyeBlinkLeft', 'JawOpen']
}

describe('UniversalFaceControlsEditor', () => {
  it('shows the five universal facial presets and treats Neutral as reset', () => {
    render(UniversalFaceControlsEditor, {
      presetOptions: GOON_SEMANTIC_EXPRESSION_CONTROLS,
      model,
      getControlValue: () => 0,
      onControlChange: vi.fn(),
      onReset: vi.fn()
    })

    for (const label of ['Happy', 'Relaxed', 'Sad', 'Angry', 'Surprised']) {
      expect(screen.getByRole('slider', { name: `${label} expression` })).toBeInTheDocument()
    }
    expect(screen.queryByRole('slider', { name: 'Neutral expression' })).not.toBeInTheDocument()
    expect(screen.getByText(/Neutral is the authored reset state/)).toBeInTheDocument()
  })

  it('searches the complete control set and resets through one explicit action', async () => {
    const onReset = vi.fn()
    render(UniversalFaceControlsEditor, {
      presetOptions: GOON_SEMANTIC_EXPRESSION_CONTROLS,
      model,
      getControlValue: () => 0,
      onControlChange: vi.fn(),
      onReset
    })

    await fireEvent.input(screen.getByRole('searchbox', { name: 'Search face controls' }), {
      target: { value: 'jaw open' }
    })
    expect(screen.getByRole('button', { name: /Jaw/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Eyes/ })).not.toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Open' })).toBeInTheDocument()

    await fireEvent.click(screen.getByRole('button', { name: /Reset face/i }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })
})
