import { render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import EyeContactTuningEditor from './EyeContactTuningEditor.svelte'
import TooltipProviderWrapper from '$lib/test-utils/TooltipProviderWrapper.svelte'
import type { EyeAppearanceControlDefinition } from '$lib/goons/eyeAppearance'
import type { ResolvedGoonEyeContactTuning } from '$lib/types/goons'

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

const tuning: ResolvedGoonEyeContactTuning = {
  eyeYawSensitivity: 1,
  eyeYawRange: 1,
  eyePitchSensitivity: 1,
  eyePitchRange: 1,
  headYawStartOutDeg: 18,
  headYawStartInDeg: 10,
  headYawSensitivity: 1,
  headYawRange: 1,
  headYawSpeed: 1,
  headPitchStartOutDeg: 12,
  headPitchStartInDeg: 6,
  headPitchSensitivity: 1,
  headPitchRange: 1,
  headPitchSpeed: 1,
  eyeYawHeadCompensation: 1,
  eyePitchHeadCompensation: 1
}

const eyeConvergenceControl: EyeAppearanceControlDefinition = {
  id: 'eye_convergence',
  label: 'Eye Convergence (Gaze)',
  description: 'Adjusts gaze distance around the calibrated neutral.',
  minimum: -10,
  maximum: 8,
  step: 0.1,
  default: 0,
  runtimeNeutralOffset: 4,
  unit: 'degrees',
  linkedBilateral: true,
  perEyeOverridesAllowed: false,
  runtimeClampingAllowed: false,
  geometrySemantics: 'Rotates both complete eye assemblies.'
}

describe('EyeContactTuningEditor', () => {
  it('shows package-owned Eye Convergence in per-Goon Eye Contact with zero as the calibrated neutral', () => {
    render(TooltipProviderWrapper as any, {
      props: {
        component: EyeContactTuningEditor,
        props: {
          mode: 'bone',
          tuning,
          showMode: false,
          eyeConvergenceControl,
          eyeConvergenceValue: 0,
          onModeChange: vi.fn(),
          onTuningChange: vi.fn(),
          onEyeConvergenceChange: vi.fn()
        }
      }
    })

    const slider = screen.getByRole('slider', { name: 'Eye Convergence (Gaze)' })
    expect(slider).toHaveAttribute('aria-valuemin', '-10')
    expect(slider).toHaveAttribute('aria-valuemax', '8')
    expect(slider).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByText('0.0 deg')).toBeInTheDocument()
  })

  it('keeps the global Eye Contact editor package-agnostic', () => {
    render(TooltipProviderWrapper as any, {
      props: {
        component: EyeContactTuningEditor,
        props: {
          mode: 'bone',
          tuning,
          onModeChange: vi.fn(),
          onTuningChange: vi.fn()
        }
      }
    })

    expect(screen.queryByRole('slider', { name: 'Eye Convergence (Gaze)' })).not.toBeInTheDocument()
  })
})
