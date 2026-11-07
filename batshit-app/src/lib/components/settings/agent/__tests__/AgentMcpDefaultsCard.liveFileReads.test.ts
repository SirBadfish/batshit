import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { ComponentProps } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentMcpDefaultsCard from '../AgentMcpDefaultsCard.svelte'
import { LIVE_FILE_READS_HELP, LIVE_FILE_READS_LABEL } from '$lib/utils/liveFileReads'
import { confirmUserSettings, resetUserSettings, updateUserSettings } from '$lib/stores/userSettings.svelte'
import { tick } from 'svelte'

/**
 * SA-137 P4a (D11): the agent's own Refreshed File Reads choice (named Live File Reads before
 * Round 2) sits beside AI Zip Layout and Tool Notes in its Tool Grid card. It exists only for an
 * API Primary agent: a CLI agent has no live refresh, and a Subagent's delegated run never
 * refreshes. The wording copies Tool Notes: Use Global Default / Enabled / Disabled. Round 2
 * (R2-2): when the panel says Refreshed File Reads cannot run for this agent now, the switch is
 * unavailable with that one sentence under it; its saved value still shows and nothing is saved.
 */

function props(overrides: Partial<ComponentProps<typeof AgentMcpDefaultsCard>> = {}): ComponentProps<typeof AgentMcpDefaultsCard> {
  return {
    agentId: 'lfr_agent',
    subjectKind: 'primary',
    toolHostScope: 'api',
    defaultMCPGateways: [],
    defaultMCPToolSelections: [],
    dcmDisplaySettings: { version: 1, groups: {}, tools: {} },
    mcpSaveState: 'idle',
    mcpRenderNonce: 0,
    defaultOpen: true,
    showCardHeader: false,
    showZipControls: true,
    showZipModeControls: true,
    showGridIntroBlock: false,
    onGatewaysChange: vi.fn(),
    onDcmDisplaySettingsChange: vi.fn(),
    getToolZipOverride: () => ({ buffer_size: '', zip_threshold: '', auto_zip: '__inherit__' }),
    onToolZipOverrideChange: vi.fn(),
    getNonMcpZipOverride: () => ({ buffer_size: '', zip_threshold: '', auto_zip: '__inherit__', min_buffer: 2 }),
    onNonMcpZipOverrideChange: vi.fn(),
    onZipAiViewModeChange: vi.fn(),
    onZipToolNotesChange: vi.fn(),
    onLiveFileReadsChange: vi.fn(),
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetUserSettings()
})

describe('the agent card\'s Refreshed File Reads row (SA-137 P4a, Round 2)', () => {
  it('inherited selectors show confirmed global values live without saving or replacing inheritance', async () => {
    confirmUserSettings({ global_zip_settings: { zip_ai_view_mode: 'inline', zip_tool_notes_enabled: false, live_file_reads: true } })
    const callbacks = { onZipAiViewModeChange: vi.fn(), onZipToolNotesChange: vi.fn(), onLiveFileReadsChange: vi.fn() }
    render(AgentMcpDefaultsCard, { props: props(callbacks) })
    expect(screen.getByRole('button', { name: 'Use Global Default (Inline)', exact: true }).classList.contains('is-inherited')).toBe(true)
    expect(screen.getByRole('button', { name: 'Use Global Default (Disabled)', exact: true }).classList.contains('is-inherited')).toBe(true)
    expect(screen.getByTestId('agent-live-file-reads-select').textContent).toContain('Use Global Default (Enabled)')
    updateUserSettings({ global_zip_settings: { zip_ai_view_mode: 'appended', zip_tool_notes_enabled: true, live_file_reads: false } })
    await tick()
    expect(screen.getByRole('button', { name: 'Use Global Default (Appended)', exact: true })).toBeTruthy()
    expect(screen.getByTestId('agent-live-file-reads-select').textContent).toContain('Use Global Default (Disabled)')
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled()
    const trigger = screen.getByTestId('agent-live-file-reads-select')
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Enabled', exact: true }), { pointerType: 'mouse' })
    expect(callbacks.onLiveFileReadsChange).toHaveBeenLastCalledWith('enabled')
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Use Global Default (Disabled)', exact: true }), { pointerType: 'mouse' })
    expect(callbacks.onLiveFileReadsChange).toHaveBeenLastCalledWith('__inherit__')
  })
  it('an API Primary agent sees it, reading Use Global Default until it chooses', async () => {
    render(AgentMcpDefaultsCard, { props: props() })
    expect(LIVE_FILE_READS_LABEL).toBe('Refreshed File Reads')
    expect(screen.getByText('Refreshed File Reads', { selector: '.batshit-settings-form-label' })).toBeTruthy()
    // No visible text still says the old name.
    expect(screen.queryByText(/Live File Reads/)).toBeNull()
    const trigger = screen.getByTestId('agent-live-file-reads-select')
    expect(trigger.textContent?.trim()).toBe('Use Global Default')
    // Tool Notes beside it is untouched.
    expect(screen.getByText('Tool Notes', { selector: '.batshit-settings-form-label' })).toBeTruthy()
  })

  it.each([
    ['__inherit__', 'Use Global Default'],
    ['enabled', 'Enabled'],
    ['disabled', 'Disabled']
  ] as const)('shows the held choice %s as %s', (value, label) => {
    render(AgentMcpDefaultsCard, { props: props({ liveFileReads: value }) })
    expect(screen.getByTestId('agent-live-file-reads-select').textContent?.trim()).toBe(label)
  })

  it('hands the panel the three choices: enabled, disabled and the inherit value', async () => {
    const onLiveFileReadsChange = vi.fn()
    render(AgentMcpDefaultsCard, { props: props({ liveFileReads: 'enabled', onLiveFileReadsChange }) })
    const trigger = screen.getByTestId('agent-live-file-reads-select')
    const choose = async (name: string) => {
      await fireEvent.keyDown(trigger, { key: 'ArrowDown' })
      await fireEvent.pointerUp(await screen.findByRole('option', { name, exact: true }), { pointerType: 'mouse' })
    }
    await choose('Disabled')
    expect(onLiveFileReadsChange).toHaveBeenLastCalledWith('disabled')
    await choose('Use Global Default')
    expect(onLiveFileReadsChange).toHaveBeenLastCalledWith('__inherit__')
    await choose('Enabled')
    expect(onLiveFileReadsChange).toHaveBeenLastCalledWith('enabled')
  })

  it('its (i) carries the one agreed sentence', async () => {
    render(AgentMcpDefaultsCard, { props: props() })
    await fireEvent.click(screen.getByRole('button', { name: 'About Refreshed File Reads' }))
    const text = ((await screen.findByText(/At the start of each turn, the agent's open Read File results/)).textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toBe(LIVE_FILE_READS_HELP)
  })

  it('a CLI Primary agent has no row', () => {
    render(AgentMcpDefaultsCard, { props: props({ toolHostScope: 'cli' }) })
    expect(screen.queryByText('Refreshed File Reads')).toBeNull()
    expect(screen.queryByTestId('agent-live-file-reads-select')).toBeNull()
    // The zip mode row is still there.
    expect(screen.getByText('Tool Notes', { selector: '.batshit-settings-form-label' })).toBeTruthy()
  })

  it.each(['api', 'cli', 'n8n'] as const)('a Subagent (%s) has no row, even with the zip controls shown', (toolHostScope) => {
    render(AgentMcpDefaultsCard, { props: props({ subjectKind: 'subagent', toolHostScope }) })
    expect(screen.queryByText('Refreshed File Reads')).toBeNull()
    expect(screen.queryByTestId('agent-live-file-reads-select')).toBeNull()
  })

  it('a Subagent card with the zip controls hidden (as the panel mounts it) has no row either', () => {
    render(AgentMcpDefaultsCard, { props: props({ subjectKind: 'subagent', showZipControls: false }) })
    expect(screen.queryByText('Refreshed File Reads')).toBeNull()
  })

  it('the chat bar\'s Tools menu (zip mode controls hidden) shows no row', () => {
    render(AgentMcpDefaultsCard, { props: props({ showZipModeControls: false }) })
    expect(screen.queryByText('Refreshed File Reads')).toBeNull()
  })
})

describe('the agent\'s Refreshed File Reads row when it cannot run (SA-137 Round 2, R2-2)', () => {
  const REASON = 'Refreshed File Reads is not available in the app container yet.'
  const trigger = () => screen.getByTestId('agent-live-file-reads-select')
  const isDisabled = () => (trigger() as HTMLButtonElement).disabled

  it('with no reason the switch is usable and says nothing under it', () => {
    render(AgentMcpDefaultsCard, { props: props({ liveFileReadsUnavailableReason: null }) })
    expect(isDisabled()).toBe(false)
    expect(screen.queryByTestId('agent-live-file-reads-unavailable')).toBeNull()
  })

  it('shows the reason as one line under the switch and disables it', () => {
    render(AgentMcpDefaultsCard, { props: props({ liveFileReadsUnavailableReason: REASON }) })
    expect(screen.getByTestId('agent-live-file-reads-unavailable').textContent?.trim()).toBe(REASON)
    expect(isDisabled()).toBe(true)
  })

  it.each([
    ['__inherit__', 'Use Global Default'],
    ['enabled', 'Enabled'],
    ['disabled', 'Disabled']
  ] as const)('still shows the saved choice %s as %s while unavailable, and opening hands the panel no change', (value, label) => {
    const onLiveFileReadsChange = vi.fn()
    render(AgentMcpDefaultsCard, { props: props({ liveFileReads: value, liveFileReadsUnavailableReason: REASON, onLiveFileReadsChange }) })
    expect(trigger().textContent?.trim()).toBe(label)
    expect(onLiveFileReadsChange).not.toHaveBeenCalled()
  })

  it('is a natively disabled button (the browser delivers it no key or pointer event), so no choice reaches the panel', async () => {
    const onLiveFileReadsChange = vi.fn()
    render(AgentMcpDefaultsCard, { props: props({ liveFileReads: 'enabled', liveFileReadsUnavailableReason: REASON, onLiveFileReadsChange }) })
    expect(trigger().tagName).toBe('BUTTON')
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
    await fireEvent.click(trigger())
    expect(screen.queryByRole('option', { name: 'Disabled', exact: true })).toBeNull()
    expect(onLiveFileReadsChange).not.toHaveBeenCalled()
    expect(trigger().textContent?.trim()).toBe('Enabled')
  })

  it('the choice is usable again, with its saved value, once the reason goes', async () => {
    const onLiveFileReadsChange = vi.fn()
    const view = render(AgentMcpDefaultsCard, { props: props({ liveFileReads: 'disabled', liveFileReadsUnavailableReason: REASON, onLiveFileReadsChange }) })
    expect(isDisabled()).toBe(true)
    await view.rerender({ liveFileReadsUnavailableReason: null })
    expect(isDisabled()).toBe(false)
    expect(screen.queryByTestId('agent-live-file-reads-unavailable')).toBeNull()
    expect(trigger().textContent?.trim()).toBe('Disabled')
    expect(onLiveFileReadsChange).not.toHaveBeenCalled()
    await fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Enabled', exact: true }), { pointerType: 'mouse' })
    expect(onLiveFileReadsChange).toHaveBeenLastCalledWith('enabled')
  })

  it('a reason on a card that has no row (a CLI agent) shows nothing', () => {
    render(AgentMcpDefaultsCard, { props: props({ toolHostScope: 'cli', liveFileReadsUnavailableReason: REASON }) })
    expect(screen.queryByTestId('agent-live-file-reads-unavailable')).toBeNull()
    expect(screen.queryByTestId('agent-live-file-reads-select')).toBeNull()
  })

  // N2: the reason is a warning only when the setting resolves ON and is unavailable (the panel
  // says so with liveFileReadsWarn); otherwise, and while the host is still being read, it is plain.
  it('draws the reason in the warning tone only when the panel says the setting is on and unavailable', () => {
    const view = render(AgentMcpDefaultsCard, { props: props({ liveFileReadsUnavailableReason: REASON, liveFileReadsWarn: true }) })
    expect(screen.getByTestId('agent-live-file-reads-unavailable').classList.contains('is-warning')).toBe(true)
    view.unmount()
    render(AgentMcpDefaultsCard, { props: props({ liveFileReadsUnavailableReason: REASON, liveFileReadsWarn: false }) })
    const plain = screen.getByTestId('agent-live-file-reads-unavailable')
    expect(plain.classList.contains('is-warning')).toBe(false)
    expect(plain.classList.contains('batshit-settings-form-help')).toBe(true)
  })

  // S3: a host that could not be read is a plain note and never locks the switch.
  it('shows a note without locking the switch, and the note is plain', async () => {
    const onLiveFileReadsChange = vi.fn()
    render(AgentMcpDefaultsCard, {
      props: props({ liveFileReads: 'disabled', liveFileReadsUnavailableReason: null, liveFileReadsNote: 'Could not check whether Refreshed File Reads can run here.', onLiveFileReadsChange })
    })
    expect(isDisabled()).toBe(false)
    const note = screen.getByTestId('agent-live-file-reads-note')
    expect(note.textContent?.trim()).toBe('Could not check whether Refreshed File Reads can run here.')
    expect(note.classList.contains('is-warning')).toBe(false)
    expect(screen.queryByTestId('agent-live-file-reads-unavailable')).toBeNull()
    await fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Enabled', exact: true }), { pointerType: 'mouse' })
    expect(onLiveFileReadsChange).toHaveBeenLastCalledWith('enabled')
  })

  // N1: the reason and the note describe the switch for assistive technology.
  it('points aria-describedby at the reason and the note, and at nothing when neither shows', () => {
    const view = render(AgentMcpDefaultsCard, { props: props({ liveFileReadsUnavailableReason: REASON, liveFileReadsNote: 'A note.' }) })
    const ids = trigger().getAttribute('aria-describedby')?.split(' ') ?? []
    expect(ids).toEqual([screen.getByTestId('agent-live-file-reads-unavailable').id, screen.getByTestId('agent-live-file-reads-note').id])
    expect(ids.every((id) => id.length > 0 && document.getElementById(id) !== null)).toBe(true)
    view.unmount()
    render(AgentMcpDefaultsCard, { props: props() })
    expect(trigger().hasAttribute('aria-describedby')).toBe(false)
  })

  it('two cards on one page never share an id', () => {
    render(AgentMcpDefaultsCard, { props: props({ liveFileReadsUnavailableReason: REASON }) })
    render(AgentMcpDefaultsCard, { props: props({ liveFileReadsUnavailableReason: REASON }) })
    const ids = screen.getAllByTestId('agent-live-file-reads-unavailable').map((reason) => reason.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })
})
