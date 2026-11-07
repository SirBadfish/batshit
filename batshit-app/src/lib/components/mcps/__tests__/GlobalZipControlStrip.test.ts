import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import GlobalZipControlStrip from '../GlobalZipControlStrip.svelte'
import { TYPESAFE_FEATURES } from '$lib/utils/jevJuice'
import { LIVE_FILE_READS_HELP, LIVE_FILE_READS_LABEL } from '$lib/utils/liveFileReads'
import {
  REFRESHED_FILE_READS_GLOBAL_HINT,
  REFRESHED_FILE_READS_GLOBAL_INLINE_NOTE,
  REFRESHED_FILE_READS_HOST_CHECK_FAILED
} from '$lib/utils/refreshedFileReadsSettings'

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
    liveFileReadsValue: null as boolean | null,
    onZipAiViewModeChange: vi.fn(),
    onZipToolNotesEnabledChange: vi.fn(),
    onJevSmartZipEnabledChange: vi.fn(),
    onLiveFileReadsValueChange: vi.fn(),
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

  // SA-137 P4a (D11): Refreshed File Reads (Live File Reads before Round 2) is the strip's fourth
  // control. Default stores absent (null), so the factory value can still move; Enabled and
  // Disabled are explicit choices.
  it.each([
    [null, 'Default (On)'],
    [true, 'Enabled'],
    [false, 'Disabled']
  ] as const)('Refreshed File Reads shows %s as %s', async (value, label) => {
    render(GlobalZipControlStrip, { props: props({ liveFileReadsValue: value }) })
    expect(LIVE_FILE_READS_LABEL).toBe('Refreshed File Reads')
    expect(screen.getByText('Refreshed File Reads', { selector: '.batshit-settings-form-label' })).toBeTruthy()
    expect(screen.queryByText(/Live File Reads/)).toBeNull()
    const trigger = await screen.findByTestId('global-live-file-reads-select')
    expect(trigger.textContent?.trim()).toBe(label)
    // The neighbours are untouched.
    expect(screen.getByText('AI Zip Layout')).toBeTruthy()
    expect(screen.getByText('Tool Notes')).toBeTruthy()
  })

  it('Refreshed File Reads hands the grid true, false or null for its three choices', async () => {
    const onLiveFileReadsValueChange = vi.fn()
    render(GlobalZipControlStrip, { props: props({ liveFileReadsValue: true, onLiveFileReadsValueChange }) })
    const trigger = await screen.findByTestId('global-live-file-reads-select')
    const choose = async (name: string) => {
      await fireEvent.keyDown(trigger, { key: 'ArrowDown' })
      await fireEvent.pointerUp(await screen.findByRole('option', { name, exact: true }), { pointerType: 'mouse' })
    }
    await choose('Disabled')
    expect(onLiveFileReadsValueChange).toHaveBeenLastCalledWith(false)
    await choose('Default (On)')
    expect(onLiveFileReadsValueChange).toHaveBeenLastCalledWith(null)
    await choose('Enabled')
    expect(onLiveFileReadsValueChange).toHaveBeenLastCalledWith(true)
  })

  it('the Refreshed File Reads (i) carries the one agreed sentence', async () => {
    render(GlobalZipControlStrip, { props: props() })
    await fireEvent.click(screen.getByRole('button', { name: 'About Refreshed File Reads' }))
    const text = ((await screen.findByText(/At the start of each turn, the agent's open Read File results/)).textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toBe(LIVE_FILE_READS_HELP)
    expect(LIVE_FILE_READS_HELP).toMatch(/marked REFRESHED/)
  })

  // Round 2 (R2-2): the global switch is not one agent's, so it shows as unavailable only for what
  // this computer is; the global Zip view and an unreadable host are plain notes that leave it
  // usable. The saved value is never changed by any of this.
  describe('availability (Round 2)', () => {
    const REASON = 'Refreshed File Reads is not available in the app container yet.'
    const trigger = () => screen.getByTestId('global-live-file-reads-select') as HTMLButtonElement

    it('available: usable, with the short hint that it applies to Primary Agents with the appended Zip view', () => {
      render(GlobalZipControlStrip, { props: props() })
      expect(trigger().disabled).toBe(false)
      expect(screen.getByTestId('global-live-file-reads-hint').textContent?.trim()).toBe(REFRESHED_FILE_READS_GLOBAL_HINT)
      expect(REFRESHED_FILE_READS_GLOBAL_HINT).toBe('Applies to Primary Agents with the appended Zip view.')
      expect(screen.queryByTestId('global-live-file-reads-reason')).toBeNull()
    })

    it('unavailable: disabled with the reason under it, in place of the hint', () => {
      render(GlobalZipControlStrip, { props: props({ liveFileReadsUnavailableReason: REASON }) })
      expect(trigger().disabled).toBe(true)
      expect(screen.getByTestId('global-live-file-reads-reason').textContent?.trim()).toBe(REASON)
      expect(screen.queryByTestId('global-live-file-reads-hint')).toBeNull()
    })

    it.each([[null, 'Default (On)'], [true, 'Enabled'], [false, 'Disabled']] as const)(
      'still shows the saved value %s as %s while unavailable, and hands the grid nothing',
      async (value, label) => {
        const onLiveFileReadsValueChange = vi.fn()
        render(GlobalZipControlStrip, { props: props({ liveFileReadsValue: value, liveFileReadsUnavailableReason: REASON, onLiveFileReadsValueChange }) })
        expect(trigger().textContent?.trim()).toBe(label)
        await fireEvent.click(trigger())
        expect(screen.queryByRole('option', { name: 'Enabled', exact: true })).toBeNull()
        expect(onLiveFileReadsValueChange).not.toHaveBeenCalled()
      }
    )

    it('is usable again with its saved value once the reason goes', async () => {
      const onLiveFileReadsValueChange = vi.fn()
      const view = render(GlobalZipControlStrip, { props: props({ liveFileReadsValue: false, liveFileReadsUnavailableReason: REASON, onLiveFileReadsValueChange }) })
      await view.rerender({ liveFileReadsUnavailableReason: null })
      expect(trigger().disabled).toBe(false)
      expect(trigger().textContent?.trim()).toBe('Disabled')
      expect(onLiveFileReadsValueChange).not.toHaveBeenCalled()
    })

    it('notes (an inline global Zip view, an unreadable host) leave the switch usable, in the plain tone, in place of the hint', async () => {
      const onLiveFileReadsValueChange = vi.fn()
      render(GlobalZipControlStrip, {
        props: props({ liveFileReadsNotes: [REFRESHED_FILE_READS_HOST_CHECK_FAILED, REFRESHED_FILE_READS_GLOBAL_INLINE_NOTE], onLiveFileReadsValueChange })
      })
      expect(trigger().disabled).toBe(false)
      const notes = screen.getAllByTestId('global-live-file-reads-note')
      expect(notes.map((note) => note.textContent?.trim())).toEqual([
        'Could not check whether Refreshed File Reads can run here.',
        'The global Zip view is inline; agents that use it refresh nothing.'
      ])
      expect(notes.every((note) => !note.classList.contains('is-warning'))).toBe(true)
      expect(screen.queryByTestId('global-live-file-reads-hint')).toBeNull()
      await fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
      await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Enabled', exact: true }), { pointerType: 'mouse' })
      expect(onLiveFileReadsValueChange).toHaveBeenLastCalledWith(true)
    })

    // N1: the reason and every note describe the switch for assistive technology.
    it('describes the switch by its reason, notes or hint (aria-describedby points at real ids)', () => {
      const view = render(GlobalZipControlStrip, { props: props({ liveFileReadsUnavailableReason: REASON, liveFileReadsNotes: ['A note.'] }) })
      const describedBy = trigger().getAttribute('aria-describedby')?.split(' ') ?? []
      expect(describedBy).toHaveLength(2)
      const reason = screen.getByTestId('global-live-file-reads-reason')
      const note = screen.getByTestId('global-live-file-reads-note')
      expect(describedBy).toEqual([reason.id, note.id])
      expect(new Set(describedBy).size).toBe(2)
      view.unmount()
      render(GlobalZipControlStrip, { props: props() })
      expect(trigger().getAttribute('aria-describedby')).toBe(screen.getByTestId('global-live-file-reads-hint').id)
    })

    it('two strips on one page never share an id', () => {
      render(GlobalZipControlStrip, { props: props({ liveFileReadsUnavailableReason: REASON }) })
      render(GlobalZipControlStrip, { props: props({ liveFileReadsUnavailableReason: REASON }) })
      const ids = screen.getAllByTestId('global-live-file-reads-reason').map((reason) => reason.id)
      expect(ids).toHaveLength(2)
      expect(new Set(ids).size).toBe(2)
    })
  })
})
