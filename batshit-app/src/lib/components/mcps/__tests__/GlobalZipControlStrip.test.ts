import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import GlobalZipControlStrip from '../GlobalZipControlStrip.svelte'
import { TYPESAFE_FEATURES } from '$lib/utils/jevJuice'

/**
 * SA-120 P5 (LS-054) — the ONE global smart zip switch sits beside the other global zip
 * defaults. It reads its name from the shared registry (DL-120-13), shows OFF unless the
 * grid says ON, and leaves the other controls alone. The change →
 * save → Redis → reload round trip is proven in the browser (`_local/typesafe/p5-proof/`).
 */

function props(overrides: Record<string, unknown> = {}) {
  return {
    zipAiViewMode: 'appended' as const,
    zipToolNotesEnabled: true,
    jevSmartZipEnabled: false,
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
    expect(TYPESAFE_FEATURES.smart_zip.switchLabel).toBe('Judge Juice: Smart Zip')
    const trigger = await screen.findByTestId('global-jev-smart-zip-select')
    expect(trigger.textContent?.trim()).toBe('Disabled')
    // The neighbours are untouched.
    expect(screen.getByText('AI Zip Layout')).toBeTruthy()
    expect(screen.getByText('Tool Notes')).toBeTruthy()
  })

  it('shows Enabled only when the grid holds the switch on', async () => {
    render(GlobalZipControlStrip, { props: props({ jevSmartZipEnabled: true }) })
    const trigger = await screen.findByTestId('global-jev-smart-zip-select')
    expect(trigger.textContent?.trim()).toBe('Enabled')
  })

  // SA-129 DL-06 (BL-1484): the zip control permission is parked behind a hidden field. Hold and
  // Release replaced it, so Settings offers no control that turns it on.
  it('offers no Zip Control Permissions control', () => {
    render(GlobalZipControlStrip, { props: props() })
    expect(screen.queryByText('Zip Control Permissions')).toBeNull()
    expect(screen.queryByRole('button', { name: 'About Zip Control Permissions' })).toBeNull()
    expect(screen.queryByText(/unzip or zip items/)).toBeNull()
  })

  // BL-1485 (SA-129 DL-07): Tool Notes are recommended, on both Settings surfaces, and the (i)
  // says why in one sentence.
  it('Tool Notes read Enabled (Recommended) and say why', async () => {
    render(GlobalZipControlStrip, { props: props() })
    const label = screen.getByText('Tool Notes', { selector: '.batshit-settings-form-label' }).closest('label')
    expect(label?.querySelector('.batshit-settings-select-compact')?.textContent?.trim()).toBe('Enabled (Recommended)')
    await fireEvent.click(screen.getByRole('button', { name: 'About Tool Notes' }))
    const text = ((await screen.findByText(/short notes about important tool results/)).textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('the facts it needs stay in view after the full result is compressed')
    expect(text).toContain('Recommended.')
  })

  it('the agent card says the same: Enabled (Recommended) and the same reason', () => {
    const card = readFileSync(resolve(process.cwd(), 'src/lib/components/settings/agent/AgentMcpDefaultsCard.svelte'), 'utf8')
    expect(card).toContain("if (value === 'enabled') return 'Enabled (Recommended)'")
    expect(card).toContain('<Select.Item value="enabled" label="Enabled (Recommended)">Enabled (Recommended)</Select.Item>')
    expect(card.replace(/\s+/g, ' ')).toContain('the facts it needs stay in view after the full result is compressed and it reads files again less. Recommended.')
  })

  it('the Judge Juice smart zip (i) speaks the hold words and names no parked zip control', async () => {
    render(GlobalZipControlStrip, { props: props() })
    await fireEvent.click(screen.getByRole('button', { name: 'About Judge Juice smart zip' }))
    const menu = (await screen.findByText(/Before each reply, Batshit asks your judge/)).closest('[role="dialog"], [data-settings-info-content], div')
    const text = (menu?.parentElement?.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('which compressed tool results your message needs')
    expect(text).toContain('Your own Hold, Release and Zip now, and the agent\'s holds, always win')
    expect(text).not.toMatch(/zip control|pins|unzip/)
  })
})
