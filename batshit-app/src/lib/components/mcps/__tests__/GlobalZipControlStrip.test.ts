import { render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import GlobalZipControlStrip from '../GlobalZipControlStrip.svelte'
import { TYPESAFE_FEATURES } from '$lib/utils/jevJuice'

/**
 * SA-120 P5 (LS-054) — the ONE global smart zip switch sits beside the other global zip
 * defaults. It reads its name from the shared registry (DL-120-13), shows OFF unless the
 * grid says ON, and leaves the three controls that were already there alone. The change →
 * save → Redis → reload round trip is proven in the browser (`_local/typesafe/p5-proof/`).
 */

function props(overrides: Record<string, unknown> = {}) {
  return {
    zipAgentControlEnabled: false,
    zipAiViewMode: 'appended' as const,
    zipToolNotesEnabled: true,
    jevSmartZipEnabled: false,
    onZipControlPermissionChange: vi.fn(),
    onZipAiViewModeChange: vi.fn(),
    onZipToolNotesEnabledChange: vi.fn(),
    onJevSmartZipEnabledChange: vi.fn(),
    ...overrides
  }
}

describe('GlobalZipControlStrip', () => {
  it('names the switch from the registry and shows it off by default', async () => {
    render(GlobalZipControlStrip, { props: props() })
    expect(screen.getByText(TYPESAFE_FEATURES.smart_zip.switchLabel)).toBeTruthy()
    expect(TYPESAFE_FEATURES.smart_zip.switchLabel).toBe('Jev Juice: Smart Zip')
    const trigger = await screen.findByTestId('global-jev-smart-zip-select')
    expect(trigger.textContent?.trim()).toBe('Disabled')
    // The neighbours are untouched.
    expect(screen.getByText('Zip Control Permissions')).toBeTruthy()
    expect(screen.getByText('AI Zip Layout')).toBeTruthy()
    expect(screen.getByText('Tool Notes')).toBeTruthy()
  })

  it('shows Enabled only when the grid holds the switch on', async () => {
    render(GlobalZipControlStrip, { props: props({ jevSmartZipEnabled: true }) })
    const trigger = await screen.findByTestId('global-jev-smart-zip-select')
    expect(trigger.textContent?.trim()).toBe('Enabled')
  })
})
