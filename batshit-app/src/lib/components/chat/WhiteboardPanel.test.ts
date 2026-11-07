import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import WhiteboardPanel from './WhiteboardPanel.svelte'
import { emptyWhiteboardPanelState, type WhiteboardPanelState } from '$lib/stores/whiteboardPanel'
import { copyTextToClipboard } from '$lib/utils/clipboard'

vi.mock('$lib/utils/clipboard', () => ({ copyTextToClipboard: vi.fn().mockResolvedValue(undefined) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const saved = (content: string | null = 'Confirmed notes') => ({
  schema_version: 1 as const, user_id: 'user', session_id: 'chat', agent_id: 'agent',
  version: 2, content, updated_at: '2026-10-15T12:00:00.000Z'
})
const state = (extra: Partial<WhiteboardPanelState> = {}): WhiteboardPanelState => ({
  ...emptyWhiteboardPanelState(), owner: { userId: 'user', sessionId: 'chat', agentId: 'agent' },
  visible: true, open: true, confirmed: true, board: saved(), ...extra
})
function mount(next = state(), budgetTokens = 1500) {
  const onOpenChange = vi.fn()
  const onRefresh = vi.fn()
  const view = render(WhiteboardPanel, { state: next, budgetTokens, onOpenChange, onRefresh })
  return { view, onOpenChange, onRefresh }
}

describe('Whiteboard floating panel', () => {
  it('opens only by activation and exposes explicit dismissal', async () => {
    const h = mount(state({ open: false }))
    const trigger = screen.getByRole('button', { name: 'Open Whiteboard' })
    await fireEvent.pointerEnter(trigger)
    expect(screen.queryByTestId('whiteboard-panel')).toBeNull()
    await fireEvent.click(trigger)
    expect(h.onOpenChange).toHaveBeenCalledWith(true)
    await h.view.rerender({ state: state() })
    const panel = await screen.findByTestId('whiteboard-panel')
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-label')).toBe('Whiteboard')
    // jsdom does not lay out the floating layer; the live browser owns visibility/focus proof.
    await fireEvent.click(panel.querySelector<HTMLButtonElement>('[aria-label="Close Whiteboard"]')!)
    expect(h.onOpenChange).toHaveBeenCalledWith(false)
  })
  it('copies the complete acknowledged contents and shows its saved timestamp', async () => {
    mount()
    const notes = await screen.findByTestId('whiteboard-notes')
    expect(notes.textContent).toBe('Confirmed notes')
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(saved().updated_at)
    const usage = screen.getByText('4 tokens / 1,500 limit')
    expect(usage.closest('p')).toBe(document.querySelector('time')?.closest('p'))
    expect(usage.getAttribute('aria-label')).toBe('4 estimated tokens, 1,500 estimated token limit')
    expect(usage.getAttribute('title')).toContain('estimate')
    const copyButton = screen.getByRole('button', { name: 'Copy Whiteboard' })
    // The shared xs Button uses this selector to size icon-only controls at 16px.
    expect(copyButton.matches(':has(> svg:only-child)')).toBe(false)
    await fireEvent.click(copyButton)
    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith('Confirmed notes'))
    await waitFor(() => expect(copyButton.textContent).toContain('Copied'))
    expect(copyButton.matches(':has(> svg:only-child)')).toBe(false)
  })
  it('returns focus to the current trigger when the panel opened without focusing that trigger', async () => {
    const h = mount()
    await screen.findByTestId('whiteboard-panel')
    const trigger = screen.getByRole('button', { name: 'Open Whiteboard' })
    expect(document.activeElement).not.toBe(trigger)
    await h.view.rerender({ state: state({ open: false }) })
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
  it('keeps focus on an outside input that dismisses the nonmodal panel', async () => {
    const h = mount()
    const composer = document.createElement('textarea')
    composer.setAttribute('aria-label', 'Message composer')
    h.view.container.appendChild(composer)
    await screen.findByTestId('whiteboard-panel')
    // The existing Bits dismissible layer installs its pointer listener after its mount tick.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await fireEvent.pointerDown(composer, { button: 0, pointerType: 'mouse', clientX: 100, clientY: 100 })
    composer.focus()
    await fireEvent.pointerUp(composer, { button: 0, pointerType: 'mouse', clientX: 100, clientY: 100 })
    await fireEvent.click(composer)
    await waitFor(() => expect(h.onOpenChange).toHaveBeenCalledWith(false))
    await h.view.rerender({ state: state({ open: false }) })
    await waitFor(() => expect(document.activeElement).toBe(composer))
  })
  it('shows full over-budget text during a failed refresh without claiming a new save', async () => {
    const content = 'Useful saved fact. '.repeat(100)
    const h = mount(state({ board: saved(content), error: 'Refresh failed' }), 250)
    expect((await screen.findByTestId('whiteboard-notes')).textContent).toBe(content)
    expect(screen.getByText(/Above the current budget/)).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Refresh failed')
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(saved().updated_at)
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(h.onRefresh).toHaveBeenCalledTimes(1)
  })
  it('resets copy success and failure when reused for another owner at the same version', async () => {
    const h = mount()
    const panel = await screen.findByTestId('whiteboard-panel')
    const copyButton = panel.querySelector<HTMLButtonElement>('[aria-label="Copy Whiteboard"]')!
    await fireEvent.click(copyButton)
    await waitFor(() => expect(copyButton.textContent).toContain('Copied'))
    const next = state({
      owner: { userId: 'user', sessionId: 'other-chat', agentId: 'other-agent' },
      board: { ...saved('Other owner notes'), session_id: 'other-chat', agent_id: 'other-agent' }
    })
    await h.view.rerender({ state: next })
    expect(copyButton.textContent).not.toContain('Copied')
    expect(copyTextToClipboard).toHaveBeenCalledTimes(1)
    vi.mocked(copyTextToClipboard).mockRejectedValueOnce(new Error('Clipboard unavailable'))
    await fireEvent.click(copyButton)
    await waitFor(() => expect(screen.getByRole('alert', { hidden: true }).textContent).toContain('Could not copy'))
    await h.view.rerender({ state: state() })
    expect(screen.queryByRole('alert', { hidden: true })).toBeNull()
    expect(copyButton.textContent).not.toContain('Copied')
  })
  it('ignores a clipboard result that finishes after the owner changes', async () => {
    let finishCopy!: () => void
    vi.mocked(copyTextToClipboard).mockImplementationOnce(() => new Promise<void>((resolve) => { finishCopy = resolve }))
    const h = mount()
    const panel = await screen.findByTestId('whiteboard-panel')
    const copyButton = panel.querySelector<HTMLButtonElement>('[aria-label="Copy Whiteboard"]')!
    await fireEvent.click(copyButton)
    await h.view.rerender({ state: state({
      owner: { userId: 'user', sessionId: 'next-chat', agentId: 'agent' },
      board: { ...saved('Next chat notes'), session_id: 'next-chat' }
    }) })
    finishCopy()
    await waitFor(() => expect(copyButton.textContent).not.toContain('Copied'))
    expect(screen.queryByRole('alert', { hidden: true })).toBeNull()
  })
  it('distinguishes never saved, confirmed clear and initial failure', async () => {
    const h = mount(state({ board: null }))
    expect(await screen.findByText('No saved notes yet.')).toBeTruthy()
    expect(document.querySelector('time')).toBeNull()
    await h.view.rerender({ state: state({ board: saved(null) }) })
    expect(await screen.findByText('Whiteboard cleared. No saved notes.')).toBeTruthy()
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(saved().updated_at)
    await h.view.rerender({ state: state({ board: null, confirmed: false, error: 'Read failed' }) })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('No saved notes yet.')).toBeNull()
    expect(screen.queryByText('Whiteboard cleared. No saved notes.')).toBeNull()
  })
})
