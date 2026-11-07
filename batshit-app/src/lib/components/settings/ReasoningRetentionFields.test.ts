import { render, screen, fireEvent, cleanup } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ReasoningRetentionFields from './ReasoningRetentionFields.svelte'

afterEach(cleanup)

describe('Reasoning Retention mounted controls', () => {
  it('hydrates factory values without saving and exposes exactly four per-agent modes', async () => {
    const onChange = vi.fn()
    render(ReasoningRetentionFields, { value: {}, onChange })
    expect(onChange).not.toHaveBeenCalled()
    // SA-126 WB-3 (Josh, 2026-10-19): an agent with no saved choice runs Whiteboard only.
    expect(screen.getByRole('button', { name: 'Reasoning Retention' }).textContent).toContain('Whiteboard Only')
    expect(screen.getByRole('button', { name: 'Display Whiteboard' }).textContent).toContain('Enabled')
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('1500')
    await fireEvent.keyDown(screen.getByRole('button', { name: 'Reasoning Retention' }), { key: 'ArrowDown' })
    await screen.findByRole('option', { name: 'Whiteboard Only' })
    for (const name of ['Whiteboard Only', 'Preserve Reasoning Only', 'Whiteboard + Preserved Reasoning', 'Neither']) {
      expect(screen.getByRole('option', { name })).toBeTruthy()
    }
    expect(screen.queryByRole('option', { name: 'Use Global Default' })).toBeNull()
    await fireEvent.pointerUp(screen.getByRole('option', { name: 'Preserve Reasoning Only' }), { pointerType: 'mouse' })
    expect(onChange).toHaveBeenCalledWith({ api_reasoning_retention: 'preserve' })
  })

  it('hides disabled-feature preferences without clearing them and restores them on re-enable', async () => {
    const onChange = vi.fn()
    const preferences = { show_whiteboard: false, whiteboard_budget_tokens: 3000 }
    const view = render(ReasoningRetentionFields, { value: { ...preferences, api_reasoning_retention: 'neither' }, onChange })
    expect(screen.queryByRole('button', { name: 'Display Whiteboard' })).toBeNull()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    await view.rerender({ value: { ...preferences, api_reasoning_retention: 'whiteboard' }, onChange })
    expect(screen.getByRole('button', { name: 'Display Whiteboard' }).textContent).toContain('Disabled')
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('3000')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows factory board preferences without writing on focus and blur', async () => {
    const onChange = vi.fn()
    render(ReasoningRetentionFields, { value: { api_reasoning_retention: 'whiteboard' }, onChange })
    expect(screen.getByRole('button', { name: 'Display Whiteboard' }).textContent).toContain('Enabled')
    const field = screen.getByRole('spinbutton')
    expect((field as HTMLInputElement).value).toBe('1500')
    await fireEvent.focus(field)
    await fireEvent.blur(field)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps invalid numeric drafts visible and saves only a valid budget on blur', async () => {
    const onChange = vi.fn()
    render(ReasoningRetentionFields, { value: { api_reasoning_retention: 'whiteboard', whiteboard_budget_tokens: 1500 }, onChange })
    const field = screen.getByRole('spinbutton')
    await fireEvent.focus(field)
    await fireEvent.input(field, { target: { value: '249' } })
    await fireEvent.blur(field)
    expect(screen.getByRole('alert').textContent).toContain('250')
    expect(onChange).not.toHaveBeenCalled()
    await fireEvent.focus(field)
    await fireEvent.input(field, { target: { value: '750' } })
    await fireEvent.blur(field)
    expect(onChange).toHaveBeenCalledWith({ whiteboard_budget_tokens: 750 })
  })

  it('does not retarget an open dropdown or numeric blur to another agent', async () => {
    const onChange = vi.fn()
    const value = { api_reasoning_retention: 'whiteboard' as const, whiteboard_budget_tokens: 1500 }
    const view = render(ReasoningRetentionFields, { ownerId: 'a', value, onChange })
    const field = screen.getByRole('spinbutton')
    await fireEvent.focus(field)
    await fireEvent.input(field, { target: { value: '2500' } })
    await view.rerender({ ownerId: 'b', value, onChange })
    await fireEvent.blur(field)
    expect(onChange).not.toHaveBeenCalled()
    await fireEvent.keyDown(screen.getByRole('button', { name: 'Reasoning Retention' }), { key: 'ArrowDown' })
    await screen.findByRole('option', { name: 'Neither' })
    await view.rerender({ ownerId: 'c', value, onChange })
    await fireEvent.pointerUp(screen.getByRole('option', { name: 'Neither' }), { pointerType: 'mouse' })
    expect(onChange).not.toHaveBeenCalled()
  })
})
