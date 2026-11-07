import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { tick } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import AdminAgentBrowserDefaultsCard from './AdminAgentBrowserDefaultsCard.svelte'
import type { AgentBrowserOperationalSettings } from '$lib/utils/toolOperationalSettings'

function values(): AgentBrowserOperationalSettings {
  return { liveViewEnabled: true, runtimeMode: 'chrome-cdp', provider: 'browserbase', cdpPort: 9333, timeoutMs: 17001,
    executablePath: '/saved/browser path', session: 'saved-session', profilePath: '/saved/profile path', extraFlags: ['--saved-flag value'] }
}
function browserStubs() {
  if (typeof Element.prototype.animate !== 'function') Object.defineProperty(Element.prototype, 'animate', {
    configurable: true, value: () => ({ cancel() {}, finish() {}, play() {}, pause() {}, onfinish: null })
  })
  if (typeof globalThis.ResizeObserver === 'undefined') Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true, writable: true, value: class { observe() {} unobserve() {} disconnect() {} }
  })
}
async function choose(label: string, option: string) {
  await fireEvent.keyDown(screen.getByRole('button', { name: label }), { key: 'ArrowDown' })
  await fireEvent.pointerUp(await screen.findByRole('option', { name: option }), { pointerType: 'mouse' })
}

describe('controlled global Agent Browser defaults card', () => {
  it('hydrates and follows new props with zero callbacks and no mutation or default normalization', async () => {
    browserStubs()
    const saved = values(), before = JSON.stringify(saved), onChange = vi.fn()
    Object.freeze(saved.extraFlags); Object.freeze(saved)
    const view = render(AdminAgentBrowserDefaultsCard, { values: saved, disabled: false, onChange })
    await tick()
    expect(screen.getByLabelText('Agent Browser Timeout (ms)')).toHaveValue(17001)
    expect(screen.getByLabelText('Chrome CDP Port')).toHaveValue(9333)
    expect(onChange).not.toHaveBeenCalled()
    await view.rerender({ values: { ...values(), liveViewEnabled: false, timeoutMs: 45000, provider: 'kernel' }, disabled: false, onChange })
    expect(screen.getByRole('switch', { name: 'Live Browser Visibility' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByLabelText('Agent Browser Timeout (ms)')).toHaveValue(45000)
    expect(onChange).not.toHaveBeenCalled()
    expect(JSON.stringify(saved)).toBe(before)
  })

  it('emits real false, valid numbers, optional null resets and exact flag lines as finite field patches', async () => {
    browserStubs()
    const saved = values(), before = JSON.stringify(saved), onChange = vi.fn()
    render(AdminAgentBrowserDefaultsCard, { values: saved, disabled: false, onChange })
    await fireEvent.click(screen.getByRole('switch', { name: 'Live Browser Visibility' }))
    expect(onChange).toHaveBeenLastCalledWith({ liveViewEnabled: false })
    await fireEvent.input(screen.getByLabelText('Chrome CDP Port'), { target: { value: '9444' } })
    expect(onChange).toHaveBeenLastCalledWith({ cdpPort: 9444 })
    await fireEvent.input(screen.getByLabelText('Agent Browser Timeout (ms)'), { target: { value: '60000' } })
    expect(onChange).toHaveBeenLastCalledWith({ timeoutMs: 60000 })
    for (const [label, key] of [['Browser Executable Path (Optional)', 'executablePath'], ['Default Session Name (Optional)', 'session'], ['Default Profile Path (Optional)', 'profilePath']]) {
      await fireEvent.input(screen.getByLabelText(label), { target: { value: '   ' } })
      expect(onChange).toHaveBeenLastCalledWith({ [key]: null })
    }
    await fireEvent.input(screen.getByLabelText('Extra CLI Flags (Advanced)'), { target: { value: '--slow-mo 150\n\n--other value\n' } })
    expect(onChange).toHaveBeenLastCalledWith({ extraFlags: ['--slow-mo 150', '', '--other value', ''] })
    await fireEvent.input(screen.getByLabelText('Extra CLI Flags (Advanced)'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ extraFlags: [] })
    expect(onChange.mock.calls.every(([patch]) => Object.keys(patch).length === 1)).toBe(true)
    expect(JSON.stringify(saved)).toBe(before)
  })

  it('changes only the selected runtime or provider and keeps the hidden CDP value', async () => {
    browserStubs()
    const saved = values(), onChange = vi.fn()
    const view = render(AdminAgentBrowserDefaultsCard, { values: saved, disabled: false, onChange })
    await choose('Browser Runtime Mode', 'Separate Chromium (recommended)')
    expect(onChange).toHaveBeenLastCalledWith({ runtimeMode: 'chromium' })
    await view.rerender({ values: { ...saved, runtimeMode: 'chromium' }, disabled: false, onChange })
    expect(screen.queryByLabelText('Chrome CDP Port')).toBeNull()
    expect(saved.cdpPort).toBe(9333)
    await choose('Cloud Provider (Optional)', 'Kernel (cloud)')
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'kernel' })
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('disables every editable control without invoking a change callback', async () => {
    browserStubs()
    const onChange = vi.fn()
    render(AdminAgentBrowserDefaultsCard, { values: values(), disabled: true, onChange })
    const visibility = screen.getByRole('switch', { name: 'Live Browser Visibility' })
    expect(visibility).toBeDisabled()
    for (const input of screen.getAllByRole('spinbutton')) expect(input).toBeDisabled()
    for (const input of screen.getAllByRole('textbox')) expect(input).toBeDisabled()
    for (const label of ['Browser Runtime Mode', 'Cloud Provider (Optional)']) expect(screen.getByRole('button', { name: label })).toBeDisabled()
    await fireEvent.click(visibility)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('uses only the Docker fact prop and preserves hidden host choices while common fields remain editable', async () => {
    browserStubs()
    const saved = values(), before = JSON.stringify(saved), onChange = vi.fn()
    const view = render(AdminAgentBrowserDefaultsCard, { values: saved, disabled: false, dockerMode: true, onChange })
    expect(screen.getByText(/Uses the Agent Browser sidecar/)).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Live Browser Visibility' })).toBeNull()
    expect(screen.queryByLabelText('Browser Runtime Mode')).toBeNull()
    expect(screen.queryByLabelText('Browser Executable Path (Optional)')).toBeNull()
    expect(screen.getByLabelText('Agent Browser Timeout (ms)')).not.toBeDisabled()
    expect(screen.getByLabelText('Extra CLI Flags (Advanced)')).not.toBeDisabled()
    expect(onChange).not.toHaveBeenCalled()
    await fireEvent.input(screen.getByLabelText('Agent Browser Timeout (ms)'), { target: { value: '30000' } })
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 30000 })
    await view.rerender({ values: saved, disabled: false, dockerMode: false, onChange })
    await waitFor(() => expect(screen.getByLabelText('Default Session Name (Optional)')).toHaveValue('saved-session'))
    expect(screen.getByLabelText('Browser Executable Path (Optional)')).toHaveValue('/saved/browser path')
    expect(screen.getByLabelText('Chrome CDP Port')).toHaveValue(9333)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(saved)).toBe(before)
  })
})
